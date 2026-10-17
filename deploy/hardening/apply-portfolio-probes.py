"""Apply only the Portfolio probe guard, preserving every existing NPM setting.

Run on the VPS, with NPM identity then password on stdin (never argv). A private
backup is written before mutation. NPM validates/reloads its generated config;
an explicit nginx -t and the host status must pass, otherwise restore the old
advanced_config. This does not change any Cloudflare security setting.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

BEGIN = "# BEGIN portfolio-probe-guard"
END = "# END portfolio-probe-guard"


def merged(existing: str, guard: str) -> str:
    if (BEGIN in existing) != (END in existing):
        raise ValueError("incomplete existing portfolio probe marker; inspect before changing it")
    if BEGIN in existing:
        before, rest = existing.split(BEGIN, 1)
        _, after = rest.split(END, 1)
        return before + guard.rstrip() + after
    return existing.rstrip() + "\n\n" + guard


def main() -> None:
    guard = Path(__file__).with_name("npm-portfolio-probes.conf").read_text()
    identity = sys.stdin.readline().strip()
    secret = sys.stdin.readline().strip()
    if not identity or not secret:
        raise SystemExit("NPM identity and password are required on stdin")

    def request(path: str, body=None, token: str | None = None, method: str | None = None):
        req = urllib.request.Request(
            "http://127.0.0.1:81/api" + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method or ("POST" if body is not None else "GET"),
            headers={"Content-Type": "application/json"},
        )
        if token:
            req.add_header("Authorization", "Bearer " + token)
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.loads(response.read())

    token = request("/tokens", {"identity": identity, "secret": secret})["token"]
    hosts = [h for h in request("/nginx/proxy-hosts", token=token) if "chakkritton.com" in h["domain_names"]]
    if len(hosts) != 1:
        raise SystemExit("expected exactly one Portfolio proxy host")
    host = hosts[0]
    old = host.get("advanced_config") or ""
    new = merged(old, guard)
    if new == old:
        print("Portfolio probe guard already current")
        return
    backup_dir = Path("/opt/apps/backups/config")
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup = backup_dir / f"npm-portfolio-{stamp}.json"
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({"id": host["id"], "advanced_config": old}, fh)
    path = f"/nginx/proxy-hosts/{host['id']}"
    try:
        updated = request(path, {"advanced_config": new}, token, "PUT")
        subprocess.run(["docker", "exec", "nginx-proxy-manager", "nginx", "-t"], check=True)
        if updated.get("meta", {}).get("nginx_online") is False:
            raise RuntimeError("NPM rejected the updated Portfolio configuration")
    except Exception:
        request(path, {"advanced_config": old}, token, "PUT")
        subprocess.run(["docker", "exec", "nginx-proxy-manager", "nginx", "-t"], check=True)
        raise
    print("Portfolio probe guard applied; nginx -t passed; backup:", backup)


if __name__ == "__main__":
    main()
