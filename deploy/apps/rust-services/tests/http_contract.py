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
        outbox = json.loads(self.request(port, "/security/outbox?after=0")[2])
        self.assertEqual(outbox["events"], [], "the first run is the baseline")
        self.assertEqual(self.request(port, "/security/ack", "POST")[0], 200)
        self.assertEqual(self.request(port, "/security", "POST")[0], 404)
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 0)
        saved = json.loads((self.root / "data/security.json").read_text())
        self.assertGreater(saved["acked"], 0)
        self.assertNotIn("/bin/sh", (self.root / "data/security.json").read_text())

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
