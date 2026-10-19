"""Create and decrypt a real native bundle using fake pg_dump and temporary files."""

import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

from http_contract import request, running, value


class Backup(unittest.TestCase):
    def test_native_bundle_restore_format_retention_and_links(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for p in [
                "out",
                "volumes/apps_media-data/_data",
                "volumes/apps_portfolio-cache/_data",
                "env",
                "origin",
                "repos/fixture/.git/refs/heads",
                "bin",
            ]:
                (root / p).mkdir(parents=True)
            (root / "volumes/apps_media-data/_data/a.txt").write_text("fixture media")
            (root / "volumes/apps_portfolio-cache/_data/excluded.txt").write_text(
                "cache"
            )
            (root / "env/db.env").write_text("POSTGRES_PASSWORD=fixture-only\n")
            (root / "env/app.env").write_text("FIXTURE_KEY=fixture-only\n")
            (root / "weather.env").write_text("FIXTURE_WEATHER=true\n")
            (root / "origin/cert.pem").write_text("fixture certificate")
            script = Path(
                os.environ.get(
                    "BACKUP_RESTORE_TEST_SCRIPT",
                    str(Path(__file__).resolve().parents[3] / "backup/restore.sh"),
                )
            )
            (root / "restore.sh").write_bytes(script.read_bytes())
            (root / "README.txt").write_text("fixture restore instructions")
            git = root / "repos/fixture/.git"
            (git / "HEAD").write_text("ref: refs/heads/main\n")
            (git / "refs/heads/main").write_text("a" * 40 + "\n")
            (git / "config").write_text(
                '[remote "origin"]\n url = https://github.com/fixture/fixture\n'
            )
            fake = root / "bin/pg_dump"
            fake.write_text("""#!/bin/sh
out=''
name=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-f' ]; then shift; out=$1; fi
  name=$1
  shift
done
sleep .1
printf 'PGDMP-fixture-%s' "$name" > "$out"
""")
            fake.chmod(0o755)
            for n in [1, 2, 3]:
                (
                    root / f"out/chakkritton-server-backup-2020010{n}-0000.zip"
                ).write_bytes(b"old-fixture")
            env = {
                "BUNDLE_DIR": str(root / "out"),
                "VOLUMES_DIR": str(root / "volumes"),
                "ENV_DIR": str(root / "env"),
                "TW_ENV": str(root / "weather.env"),
                "ORIGIN_DIR": str(root / "origin"),
                "REPOS_DIR": str(root / "repos"),
                "TW_REPO": str(root / "repos/fixture"),
                "RESTORE_SCRIPT": str(root / "restore.sh"),
                "RESTORE_README": str(root / "README.txt"),
                "DB_HOST": "fixture-no-network",
                "KEEP": "2",
                "PATH": str(root / "bin") + os.pathsep + os.environ["PATH"],
            }
            with running("backup", **env) as p:
                self.assertEqual(len(value(request(p, "/backups"))["bundles"]), 3)
                self.assertEqual(
                    request(p, "/backups", "POST", {"passphrase": "short"})[0], 400
                )
                name = value(
                    request(
                        p, "/backups", "POST", {"passphrase": "fixture-passphrase-only"}
                    )
                )["started"]
                self.assertEqual(
                    request(
                        p, "/backups", "POST", {"passphrase": "fixture-passphrase-only"}
                    )[0],
                    409,
                )
                for _ in range(300):
                    b = value(request(p, "/backups"))
                    if b["job"].get("done") or b["job"].get("error"):
                        break
                    time.sleep(0.02)
                self.assertNotIn("error", b["job"], b["job"])
                self.assertTrue(b["job"]["done"])
                self.assertEqual(len(b["bundles"]), 2)
                url = value(request(p, f"/backups/{name}/link", "POST"))["url"]
                download = request(p, url.removeprefix("/api"))
                self.assertEqual(download[0], 200)
                self.assertEqual(download[1]["cache-control"], "no-store")
                self.assertEqual(download[2], (root / "out" / name).read_bytes())
                part = request(
                    p, url.removeprefix("/api"), headers={"range": "bytes=1-99"}
                )
                self.assertEqual((part[0], part[2]), (206, download[2][1:100]))
                self.assertEqual(request(p, "/backups/dl/invalid")[0], 410)
                self.assertEqual(request(p, "/backups/..%2Fescape", "DELETE")[0], 404)
                with zipfile.ZipFile(io.BytesIO(download[2])) as z:
                    self.assertEqual(
                        set(z.namelist()),
                        {
                            "restore.sh",
                            "README.txt",
                            "payload.enc",
                            "payload.enc.sha256",
                        },
                    )
                    encrypted = z.read("payload.enc")
                    self.assertEqual(
                        z.read("payload.enc.sha256").decode(),
                        hashlib.sha256(encrypted).hexdigest() + "  payload.enc\n",
                    )
                    self.assertEqual(
                        z.read("restore.sh"), (root / "restore.sh").read_bytes()
                    )
                data = subprocess.check_output(
                    [
                        "openssl",
                        "enc",
                        "-d",
                        "-aes-256-cbc",
                        "-pbkdf2",
                        "-iter",
                        "600000",
                        "-pass",
                        "env:FIXTURE_PASS",
                    ],
                    input=encrypted,
                    env={**os.environ, "FIXTURE_PASS": "fixture-passphrase-only"},
                )
                with tarfile.open(fileobj=io.BytesIO(data)) as t:
                    names = {n.removeprefix("./") for n in t.getnames()}
                    self.assertIn("db/expenses.dump", names)
                    self.assertEqual(
                        t.extractfile("./db/expenses.dump").read(),
                        b"PGDMP-fixture-expenses",
                    )
                    self.assertIn("env/thai-weather.deploy.env", names)
                    self.assertIn("origin-ca/cert.pem", names)
                    self.assertIn("volumes/apps_media-data.tar.gz", names)
                    self.assertNotIn("volumes/apps_portfolio-cache.tar.gz", names)
                    meta = json.load(t.extractfile("./meta.json"))
                    self.assertEqual(meta["format"], 1)
                    self.assertEqual(meta["databases"], ["expenses", "portfolio"])
                    self.assertEqual(meta["repos"]["fixture"]["commit"], "a" * 40)
                    self.assertEqual(meta["repos"]["fixture"]["branch"], "main")
                    volume = t.extractfile("./volumes/apps_media-data.tar.gz").read()
                    with tarfile.open(fileobj=io.BytesIO(volume), mode="r:gz") as v:
                        self.assertEqual(
                            v.extractfile("./a.txt").read(), b"fixture media"
                        )
                if os.environ.get("APPS_RUST_TEST_RESTORE_CHECK") == "true":
                    restore = root / "restore-check"
                    restore.mkdir()
                    with zipfile.ZipFile(io.BytesIO(download[2])) as z:
                        z.extractall(restore)
                    subprocess.run(
                        ["bash", str(restore / "restore.sh"), "--check"],
                        check=True,
                        capture_output=True,
                        env={
                            **os.environ,
                            "BUNDLE_PASS": "fixture-passphrase-only",
                            "TMPDIR": str(root),
                        },
                    )
                    self.assertFalse(list(root.glob("restore-????????")))
                self.assertEqual(
                    value(request(p, f"/backups/{name}", "DELETE")), {"deleted": name}
                )
                self.assertFalse((root / "out" / name).exists())
                self.assertFalse(list((root / "out").glob(".work-*")))
                self.assertFalse(list((root / "out").glob("*.part")))
            with running("backup", **env, BACKUP_JOBS_DISABLED="true") as p:
                self.assertEqual(
                    request(
                        p, "/backups", "POST", {"passphrase": "fixture-passphrase-only"}
                    )[0],
                    503,
                )
                self.assertEqual(request(p, "/backups/anything", "DELETE")[0], 503)
                self.assertIsNone(value(request(p, "/backups"))["job"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
