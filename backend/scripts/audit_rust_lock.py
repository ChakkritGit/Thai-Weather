"""Fail if any locked Rust crate was released less than 14 days before addition.

    python scripts/audit_rust_lock.py --added-on 2026-10-17

Run after generating Cargo.lock, and downgrade too-new transitive crates with
`cargo update -p <crate> --precise <eligible-version>` before building --locked.
Metadata comes from crates.io, not a search result or the current machine date.
"""

from __future__ import annotations

import argparse
import json
import tomllib
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--added-on", required=True, type=date.fromisoformat)
    parser.add_argument("--lock", type=Path, help="Audit another Rust service's Cargo.lock")
    args = parser.parse_args()
    cutoff = datetime.combine(args.added_on, datetime.min.time(), tzinfo=UTC) - timedelta(days=14)
    lock = args.lock or Path(__file__).resolve().parents[1] / "rust-api" / "Cargo.lock"
    if not lock.exists():
        raise SystemExit("Cargo.lock is missing: generate and audit it before treating the Rust API as buildable")
    packages = [p for p in tomllib.loads(lock.read_text())["package"] if "source" in p]

    def check(package):
        name, version = package["name"], package["version"]
        if package["source"] != "registry+https://github.com/rust-lang/crates.io-index":
            return f"{name} {version}: unreviewed non-crates.io source"
        url = "https://crates.io/api/v1/crates/" + urllib.parse.quote(name) + "/" + urllib.parse.quote(version)
        req = urllib.request.Request(
            url, headers={"User-Agent": "thwx-dependency-audit/1.0 (https://github.com/ChakkritGit/Thai-Weather)"}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            metadata = json.load(response)["version"]
        created = datetime.fromisoformat(metadata["created_at"].replace("Z", "+00:00"))
        if created > cutoff:
            return f"{name} {version}: released {created.isoformat()}, newer than {cutoff.isoformat()}"
        if metadata.get("yanked"):
            return f"{name} {version}: yanked"
        return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        failures = [f for f in pool.map(check, packages) if f]
    if failures:
        raise SystemExit("Rust dependency audit failed:\n" + "\n".join(failures))
    print(f"All {len(packages)} locked crates were non-yanked and at least 14 days old on {args.added_on}")


if __name__ == "__main__":
    main()
