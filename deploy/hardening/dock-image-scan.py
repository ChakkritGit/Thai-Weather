"""Nightly CVE scan of every image a container uses, for Dock's ความปลอดภัย page.

Run by dock-image-scan.timer as root on the VPS. Trivy never gets the Docker socket: each image is
exported with `docker save` into a private work directory and scanned as a tar in a container with
no network, no capabilities and a read-only root. Only the database download has network.
The summary goes to /var/lib/dock-scan/images.json (dock-metrics reads it read-only and raises the
alerts); the tars and Trivy's full reports are deleted after each image.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# 0.75.0 (2026-10-01): after the March 2026 compromise (0.69.4-0.69.6); same digest on Docker Hub and GHCR
TRIVY = "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"
TRIVY_VERSION = "0.75.0"
OUT = Path("/var/lib/dock-scan")
WORK = Path("/var/tmp/dock-scan")
CACHE = "dock-scan-cache"  # named volume: Trivy's vulnerability database
SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]
KEEP_VULNS = 40  # per image, most severe first; fixable ones before the rest
# Trivy writes only to its cache volume and the work directory (tars, report, TMPDIR)
# the label lets dock-metrics skip these runs (only unprivileged Trivy ones) instead of reporting new containers
SANDBOX = ["--rm", "--label", "dock.image-scan=true", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
           "--pids-limit", "256", "--cpu-shares", "64", "-v", f"{CACHE}:/cache", "-v", f"{WORK}:/work",
           "-e", "TMPDIR=/work/tmp"]
COMMON = ["--cache-dir", "/cache", "--skip-version-check", "--disable-telemetry", "--quiet"]
# Java archives (NPM's image has one in a layer that a later layer deletes) and the SBOMs Python packages
# ship (PEP 770, pip's vendored list) make Trivy demand its Java DB, ~1 GB more a night. Nothing here runs
# Java, and the Python packages themselves are still found from their dist-info metadata.
SKIP = [arg for glob in ["**/*.jar", "**/*.war", "**/*.ear", "**/*.par", "**/*.dist-info/sboms/*.json",
                         "**/pip/_vendor/bom.cdx.json"] for arg in ("--skip-files", glob)]


def run(args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def short_error(p: subprocess.CompletedProcess[str]) -> str:
    lines = [line for line in (p.stderr or p.stdout).splitlines() if line.strip()]
    return (lines[-1] if lines else f"exit {p.returncode}")[:300]


def images_in_use() -> dict[str, dict]:
    """image id → what Dock shows: the reference it was started from and the containers using it"""
    ids = run(["docker", "ps", "-aq"], 60).stdout.split()
    if not ids:
        return {}
    found: dict[str, dict] = {}
    for c in json.loads(run(["docker", "inspect", *ids], 120).stdout or "[]"):
        ref = c["Config"]["Image"].split("@", 1)[0]
        entry = found.setdefault(c["Image"], {"image": ref, "containers": [], "running": False})
        entry["containers"].append(c["Name"].lstrip("/"))
        entry["running"] |= bool(c["State"].get("Running"))
    return found


def summary(report: dict) -> dict:
    meta = report.get("Metadata") or {}
    os_info = meta.get("OS") or {}
    seen: dict[tuple[str, str], dict] = {}
    for result in report.get("Results") or []:
        for v in result.get("Vulnerabilities") or []:
            sev = v.get("Severity") if v.get("Severity") in SEVERITIES else "UNKNOWN"
            key = (v.get("VulnerabilityID", ""), v.get("PkgName", ""))
            if key in seen:
                continue
            seen[key] = {
                "id": key[0],
                "pkg": key[1],
                "installed": v.get("InstalledVersion", ""),
                "fixed": v.get("FixedVersion", ""),
                "severity": sev,
                "title": (v.get("Title") or "")[:160],
            }
    vulns = list(seen.values())
    counts = {s: sum(v["severity"] == s for v in vulns) for s in SEVERITIES}
    fixable = {s: sum(v["severity"] == s and bool(v["fixed"]) for v in vulns) for s in SEVERITIES}
    # every fixable CRITICAL/HIGH finding, not only the shown ones: dock-metrics alerts on new entries
    keys = sorted({f"{v['severity']}|{v['id']}|{v['pkg']}" for v in vulns
                   if v["fixed"] and v["severity"] in ("CRITICAL", "HIGH")})
    vulns.sort(key=lambda v: (SEVERITIES.index(v["severity"]), not v["fixed"], v["id"]))
    family = os_info.get("Family", "")
    return {
        "os": f"{family} {os_info.get('Name', '')}".strip(),
        "eosl": bool(os_info.get("EOSL")),
        "counts": counts,
        "fixable": fixable,
        "vulns": vulns[:KEEP_VULNS],
        "fixableKeys": keys,
    }


def scan(image_id: str) -> dict:
    tar, report = WORK / "image.tar", WORK / "report.json"
    try:
        saved = run(["docker", "save", "-o", str(tar), image_id], 1800)
        if saved.returncode != 0:
            if "No such image" in saved.stderr:
                # the tag was rebuilt and the old image removed while a container still runs it
                return {"gone": True, "error": "image เดิมถูกลบไปแล้ว สร้างคอนเทนเนอร์ใหม่แล้วจะสแกนได้"}
            return {"error": f"docker save: {short_error(saved)}"}
        os.chmod(tar, 0o644)
        p = run(["docker", "run", *SANDBOX, "--network", "none", TRIVY, "image", "--input", "/work/image.tar", *COMMON,
                 *SKIP, "--skip-db-update", "--skip-java-db-update", "--scanners", "vuln",
                 "--list-all-pkgs=false", "--timeout", "30m", "--format", "json",
                 "--output", "/work/report.json"], 2400)
        if p.returncode != 0:
            return {"error": f"trivy: {short_error(p)}"}
        return summary(json.loads(report.read_text()))
    finally:
        tar.unlink(missing_ok=True)
        report.unlink(missing_ok=True)
        shutil.rmtree(WORK / "tmp", ignore_errors=True)
        (WORK / "tmp").mkdir(mode=0o777, exist_ok=True)


def write(doc: dict) -> None:
    OUT.mkdir(mode=0o755, parents=True, exist_ok=True)
    tmp = OUT / ".images.json"
    tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    os.chmod(tmp, 0o644)
    tmp.replace(OUT / "images.json")


def main() -> int:
    OUT.mkdir(mode=0o755, parents=True, exist_ok=True)
    lock = open(OUT / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another scan is running", file=sys.stderr)
        return 0
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(mode=0o700, parents=True)
    (WORK / "tmp").mkdir(mode=0o777)
    started = time.time()
    db = run(["docker", "run", *SANDBOX, TRIVY, "image", "--download-db-only", *COMMON], 1800)
    doc: dict = {"started": started, "trivy": TRIVY_VERSION, "dbError": None, "images": []}
    if db.returncode != 0:
        # an old database still finds most problems; say so on the page instead of skipping the night
        doc["dbError"] = short_error(db)
    for image_id, info in sorted(images_in_use().items(), key=lambda kv: kv[1]["image"]):
        entry = {"id": image_id, **info, "containers": sorted(info["containers"])}
        entry.update(scan(image_id))
        doc["images"].append(entry)
        print(f"{info['image']}: {entry.get('error') or entry['counts']}", flush=True)
    doc["scanned"] = time.time()
    write(doc)
    shutil.rmtree(WORK, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
