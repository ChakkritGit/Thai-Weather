"""Real HTTP and process-lifecycle tests; temporary fixture data only, no real services."""

from __future__ import annotations

import gzip
import http.client
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

BINARY = Path(
    os.environ.get(
        "METRICS_TEST_BIN", Path(__file__).parents[1] / "target/debug/dock-metrics"
    )
).resolve()
FIXTURE = json.loads((Path(__file__).parent / "fixtures/bun-contract.json").read_text())


class Contract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rust-metrics-http-")
        self.root = Path(self.temp.name)
        (self.root / "data").mkdir()
        (self.root / "logs").mkdir()
        (self.root / "hostname").write_text("fixture-host\n")
        (self.root / "os-release").write_text('PRETTY_NAME="Fixture OS"\n')
        self.env = {
            **os.environ,
            "HOST_PROC": str(self.root / "proc"),
            "HOST_CGROUP": str(self.root / "cgroup"),
            "HOST_FILE": str(self.root / "hostname"),
            "NPM_LOGS": str(self.root / "logs"),
            "DATA_DIR": str(self.root / "data"),
        }
        self.processes = []

    def tearDown(self):
        for p in self.processes:
            if p.poll() is None:
                p.terminate()
                p.wait(timeout=10)
        self.temp.cleanup()

    def start(self, serve_only=True):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        env = {
            **self.env,
            "PORT": str(port),
            "METRICS_SERVE_ONLY": str(serve_only).lower(),
        }
        if serve_only:
            env["METRICS_FIXED_NOW"] = str(FIXTURE["now"])
        p = subprocess.Popen(
            [str(BINARY)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        self.processes.append(p)
        for _ in range(100):
            if p.poll() is not None:
                raise AssertionError("collector exited before becoming ready")
            try:
                if self.request(port, "/healthz")[0] == 200:
                    return p, port, env
            except OSError:
                pass
            time.sleep(0.03)
        self.fail("health timeout")

    def request(self, port, path, method="GET"):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            c.request(method, path)
            r = c.getresponse()
            return r.status, dict(r.getheaders()), r.read()
        finally:
            c.close()

    def test_wire_contract_and_read_only_mode(self):
        history = self.root / "data/history.json.gz"
        history.write_bytes(
            gzip.compress(json.dumps({"hist": FIXTURE["hist"], "logpos": {}}).encode())
        )
        before = history.read_bytes()
        p, port, env = self.start()
        for name in ["1h", "24h", "7d"]:
            code, headers, body = self.request(port, "/metrics?range=" + name)
            self.assertEqual(code, 200)
            self.assertEqual(headers["content-type"], "application/json")
            self.assertEqual(headers["content-encoding"], "gzip")
            self.assertEqual(headers["cache-control"], "no-store")
            data = json.loads(gzip.decompress(body))
            self.assertEqual(data["range"], name)
            self.assertEqual(len(data["times"]), FIXTURE["series"][name]["count"])
            self.assertEqual(
                [data["times"][0], data["times"][-1]],
                [FIXTURE["series"][name]["first"], FIXTURE["series"][name]["last"]],
            )
            self.assertEqual(data["snapshot"]["hostname"], "fixture-host")
            self.assertEqual(data["snapshot"]["os"], "Fixture OS")
            self.assertEqual(data["collector_uptime_s"], 0)
        data = json.loads(
            gzip.decompress(self.request(port, "/metrics?range=1h&range=7d")[2])
        )
        self.assertEqual(data["range"], "7d")
        self.assertEqual(self.request(port, "/metrics/")[0], 200)
        for path in ["/metrics?range=", "/metrics?range=invalid"]:
            code, headers, body = self.request(port, path)
            self.assertEqual((code, body), (400, b"bad range"))
            self.assertNotIn("content-type", headers)
        for path, method in [("/missing", "GET"), ("/metrics", "POST")]:
            self.assertEqual(self.request(port, path, method)[::2], (404, b"NOT_FOUND"))
        self.assertEqual(
            json.loads(self.request(port, "/security")[2]), {"enabled": False}
        )
        self.assertEqual(
            json.loads(self.request(port, "/security/attacks?days=7")[2]),
            {"enabled": False},
        )
        code, headers, body = self.request(port, "/metrics", "HEAD")
        self.assertEqual((code, headers["content-encoding"], body), (200, "gzip", b""))
        subprocess.run([str(BINARY), "--healthcheck"], env=env, check=True, timeout=5)
        p.terminate()
        self.assertEqual(p.wait(timeout=10), 0)
        self.assertEqual(history.read_bytes(), before)
        self.assertEqual(
            sorted(x.name for x in (self.root / "data").iterdir()), ["history.json.gz"]
        )

    def test_shutdown_save_resume_and_single_writer_lease(self):
        line = FIXTURE["lines"][0]
        # The synthetic time in access logs must be within retention for the current test date.
        import datetime

        months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        ]
        stamp = datetime.datetime.now(datetime.UTC)
        new_stamp = f"{stamp.day:02d}/{months[stamp.month - 1]}/{stamp.year}:{stamp:%H:%M:%S} +0000"
        line = "[" + new_stamp + "] " + line.split("] ", 1)[1]
        (self.root / "logs/proxy-host-1_access.log").write_text(line + "\n")
        p, _, env = self.start(False)
        second = subprocess.run(
            [str(BINARY)], env=env, capture_output=True, timeout=10, check=False
        )
        self.assertNotEqual(second.returncode, 0)
        self.assertIn(b"another collector owns this history", second.stderr)
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 0)
        history = self.root / "data/history.json.gz"
        saved = json.loads(gzip.decompress(history.read_bytes()))
        self.assertGreater(saved["logpos"]["proxy-host-1_access.log"][1], 0)
        p, _, _ = self.start(False)
        p.terminate()
        self.assertEqual(p.wait(timeout=10), 0)
        self.assertEqual(json.loads(gzip.decompress(history.read_bytes())), saved)
        self.assertFalse((self.root / "data/history.json.gz.tmp").exists())

    def test_security_watch_learns_then_serves_and_saves(self):
        host = self.root / "host"
        (host / "log").mkdir(parents=True)
        (host / "etc").mkdir()
        (host / "log/auth.log").write_text(
            "2026-10-24T09:00:00+07:00 h sshd[1]: Accepted publickey for root"
            " from 192.0.2.1 port 1 ssh2: ED25519 SHA256:fixture\n"
        )
        (host / "etc/passwd").write_text("root:x:0:0::/root:/bin/sh\n")
        (host / "scan").mkdir()
        (host / "scan/images.json").write_text(json.dumps({
            "scanned": 1, "trivy": "0.75.0", "dbError": None,
            "images": [{"image": "nginx:1", "counts": {"HIGH": 1}, "vulns": [],
                        "fixableKeys": ["HIGH|CVE-1|openssl"]}],
        }))
        self.env["SECURITY_HOST"] = str(host)
        p, port, _ = self.start(False)
        for _ in range(100):
            code, headers, body = self.request(port, "/security")
            data = json.loads(body)
            if data["cats"]["files"]["watched"]:
                break
            time.sleep(0.05)
        self.assertEqual((code, headers["cache-control"]), (200, "no-store"))
        self.assertTrue(data["enabled"])
        self.assertEqual(data["cats"]["files"]["watched"], 1)
        self.assertEqual(data["cats"]["ssh"]["keys"][0]["key"], "SHA256:fixture")
        self.assertEqual(data["cats"]["images"]["images"][0]["image"], "nginx:1")
        self.assertNotIn("fixableKeys", data["cats"]["images"]["images"][0])
        outbox = json.loads(self.request(port, "/security/outbox?after=0")[2])
        self.assertEqual(outbox["events"], [], "the first run is the baseline")
        self.assertEqual(self.request(port, "/security/ack", "POST")[0], 200)
        self.assertEqual(self.request(port, "/security", "POST")[0], 404)
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 0)
        saved = json.loads((self.root / "data/security.json").read_text())
        self.assertGreater(saved["acked"], 0)
        self.assertNotIn("/bin/sh", (self.root / "data/security.json").read_text())

    def test_attack_map_is_view_only_and_counts_log_lines(self):
        import datetime

        host = self.root / "host"
        (host / "log").mkdir(parents=True)
        (self.root / "geo.csv").write_text(
            "45.0.0.0,45.255.255.255,DE\n60.0.0.0,60.255.255.255,CN\n"
        )
        stamp = datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=7))
        ).isoformat(timespec="microseconds")
        (host / "log/ufw.log").write_text(
            f"{stamp} h kernel: [1.0] [UFW BLOCK] IN=eth0 OUT= SRC=45.1.2.3 DST=203.0.113.9"
            " LEN=44 PROTO=TCP SPT=5 DPT=22 WINDOW=1 SYN\n"
            f"{stamp} h kernel: [1.0] [UFW BLOCK] IN=eth0 OUT= SRC=192.168.1.5 DST=203.0.113.9"
            " LEN=44 PROTO=TCP SPT=5 DPT=22 WINDOW=1 SYN\n"
        )
        (host / "log/auth.log").write_text(
            f"{stamp} h sshd[1]: Invalid user admin from 60.9.9.9 port 4\n"
        )
        self.env["SECURITY_HOST"] = str(host)
        # no IP database: the map is off, nothing else changes
        p, port, _ = self.start(False)
        self.assertEqual(
            json.loads(self.request(port, "/security/attacks")[2]), {"enabled": False}
        )
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 0)
        self.assertFalse((self.root / "data/attacks.json").exists())

        self.env["GEOIP_DB"] = str(self.root / "geo.csv")
        self.env["GEOIP_MONTH"] = "2026-10"
        p, port, _ = self.start(False)
        for _ in range(100):
            code, headers, body = self.request(port, "/security/attacks?days=1")
            data = json.loads(body)
            if data["totals"]["total"]:
                break
            time.sleep(0.05)
        self.assertEqual((code, headers["cache-control"]), (200, "no-store"))
        self.assertEqual(
            (data["totals"]["scan"], data["totals"]["ssh"], data["totals"]["web"]),
            (1, 1, 0),
        )
        self.assertEqual([c["cc"] for c in data["countries"]], ["CN", "DE"])
        self.assertEqual(data["geo"]["month"], "2026-10")
        for days in ("7", "30"):
            self.assertEqual(
                json.loads(self.request(port, f"/security/attacks?days={days}")[2])["totals"]["total"], 2
            )
        for bad in ("0", "2", "x", ""):
            self.assertEqual(
                self.request(port, f"/security/attacks?days={bad}")[0], 400, bad
            )
        self.assertEqual(self.request(port, "/security/attacks", "POST")[0], 404)
        # view-only: the security watch has nothing to tell apps-chat about these attackers
        outbox = json.loads(self.request(port, "/security/outbox?after=0")[2])
        self.assertEqual(outbox["events"], [])
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 0)
        # the watch's own failed-login tally may hold the SSH address; no event may, and ufw is never read by it
        saved = json.loads((self.root / "data/security.json").read_text())
        self.assertNotIn("45.1.2.3", json.dumps(saved))
        self.assertEqual([e["alert"] for e in saved["events"]], [False])
        self.assertNotIn("60.9.9.9", json.dumps(saved["events"]))
        self.assertTrue((self.root / "data/attacks.json").exists())

    def test_fixed_clock_requires_serve_only(self):
        result = subprocess.run(
            [str(BINARY)],
            env={**self.env, "METRICS_FIXED_NOW": "1"},
            check=False,
            capture_output=True,
            timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"fixed clock", result.stderr)


if __name__ == "__main__":
    unittest.main()
