"""Real native HTTP contracts; all writes/alerts are confined to temporary fixtures."""

import contextlib
import datetime as dt
import http.client
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

ROOT = Path(__file__).resolve().parents[1]
BIN = os.environ.get("APPS_RUST_TEST_BIN", str(ROOT / "target/debug/apps-runtime"))


def request(port, path, method="GET", body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        headers = {"content-type": "application/json", **(headers or {})}
    c.request(method, path, body, headers or {})
    r = c.getresponse()
    result = (r.status, dict(r.getheaders()), r.read())
    c.close()
    return result


def value(r):
    return json.loads(r[2])


@contextlib.contextmanager
def running(service, **env):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with tempfile.TemporaryFile() as log:
        p = subprocess.Popen(
            [BIN, service],
            env={**os.environ, **env, "PORT": str(port)},
            stdout=log,
            stderr=log,
        )
        try:
            for _ in range(150):
                if p.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read().decode())
                try:
                    if (
                        request(port, "/ping" if service == "health" else "/health")[0]
                        == 200
                    ):
                        break
                except OSError:
                    time.sleep(0.02)
            else:
                raise AssertionError("startup timeout")
            subprocess.run(
                [BIN, service, "--healthcheck"],
                env={**os.environ, **env, "PORT": str(port)},
                check=True,
                capture_output=True,
            )
            yield port
        finally:
            p.terminate()
            p.wait(timeout=8)


class Fixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    mode = "ok"
    counts: ClassVar[dict] = {}
    alerts: ClassVar[list] = []

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.reply()

    def do_POST(self):
        self.reply()

    def reply(self):
        cls = type(self)
        path = self.path
        cls.counts[path] = cls.counts.get(path, 0) + 1
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        status = 200
        if path == "/__health":
            result = b"ok\n"
            if cls.mode == "rooms-down" or (
                cls.mode == "rooms-retry" and cls.counts[path] == 1
            ):
                status = 503
        elif path == "/health":
            result = {
                "status": "ok",
                "service": "drive-music-sync",
                "protocol": 1 if cls.mode == "sync-invalid" else 2,
            }
        elif path == "/chat/alert":
            assert self.headers["x-alert-secret"] == "alert-fixture"
            cls.alerts.append(json.loads(body))
            result = {"ok": True}
            if cls.mode == "alert-rejected":
                status, result = 403, {"error": "rejected"}
            if cls.mode == "alert-nonjson":
                result = b"not-json"
        else:
            assert self.command == "POST"
            assert self.headers["x-status-secret"] == "status-fixture"
            assert json.loads(body) == {"health": True}  # Never a notification request.
            last = dt.datetime.now(dt.UTC)
            if cls.mode == "stale":
                last -= dt.timedelta(hours=27)
            if cls.mode == "future":
                last += dt.timedelta(minutes=6)
            result = {"lastRun": last.isoformat()}
            if cls.mode == "invalid":
                result = {}
            if cls.mode == "forbidden":
                status = 403
            if cls.mode == "transient" and cls.counts[path] == 1:
                status = 503
            if cls.mode == "timeout":
                time.sleep(0.2)
        data = result if isinstance(result, bytes) else json.dumps(result).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Contracts(unittest.TestCase):
    def test_health_probes_retry_and_fake_alerts(self):
        with tempfile.TemporaryDirectory() as d:
            snap = Path(d) / "containers.tsv"
            snap.write_text(
                "1792150000\napps-expenses-17\trunning\tUp (healthy)\napps-db\texited\tExited (1)\n"
            )
            stub = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
            thread = threading.Thread(target=stub.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{stub.server_port}"
            env = {
                "CONTAINERS_FILE": str(snap),
                "ROOMS_URL": base,
                "SYNC_URL": base,
                "REMINDERS_URL": base + "/",
                "ALERT_URL": base + "/chat/alert",
                "PROBE_SECRET": "probe-fixture",
                "STATUS_SECRET": "status-fixture",
                "ALERT_SECRET": "alert-fixture",
                "HEALTH_PROBE_TIMEOUT_MS": "70",
                "HEALTH_RETRY_DELAY_MS": "1",
            }
            h = {"x-probe-secret": "probe-fixture"}
            try:
                Fixture.alerts = []
                Fixture.mode = "ok"
                Fixture.counts = {}
                with running("health", **env) as p:
                    self.assertEqual(request(p, "/health")[0], 401)
                    self.assertEqual(
                        request(p, "/health", headers={"x-probe-secret": "wrong"})[0],
                        401,
                    )
                    r = request(p, "/health", headers=h)
                    self.assertEqual(r[1]["cache-control"], "no-store")
                    b = value(r)
                    self.assertEqual(b["at"], 1792150000000)
                    self.assertEqual(
                        b["containers"],
                        [
                            {"name": "apps-db", "state": "exited", "health": None},
                            {
                                "name": "apps-expenses",
                                "state": "running",
                                "health": "healthy",
                            },
                        ],
                    )
                    self.assertEqual(
                        [(x["id"], x["ok"]) for x in b["checks"]],
                        [("rooms", True), ("musicsync", True), ("reminders", True)],
                    )
                    for mode, target, ok, count, reason in [
                        ("rooms-retry", "rooms", True, 2, None),
                        ("rooms-down", "rooms", False, 2, None),
                        ("sync-invalid", "musicsync", False, 2, None),
                        ("stale", "reminders", False, 1, "heartbeat-stale"),
                        ("future", "reminders", False, 1, "heartbeat-stale"),
                        ("invalid", "reminders", False, 1, "invalid-response"),
                        ("forbidden", "reminders", False, 1, "http-error"),
                        ("transient", "reminders", True, 2, None),
                        ("timeout", "reminders", False, 2, "timeout"),
                    ]:
                        Fixture.mode, Fixture.counts = mode, {}
                        b = value(request(p, "/health/", headers=h))
                        check = next(x for x in b["checks"] if x["id"] == target)
                        self.assertEqual(check["ok"], ok, mode)
                        self.assertEqual(check.get("reason"), reason, mode)
                        self.assertEqual(
                            Fixture.counts[
                                {
                                    "rooms": "/__health",
                                    "musicsync": "/health",
                                    "reminders": "/",
                                }[target]
                            ],
                            count,
                            mode,
                        )
                    Fixture.mode = "ok"
                    snap.unlink()
                    b = value(request(p, "/health", headers=h))
                    self.assertEqual((b["at"], b["containers"]), (0, []))
                    payload = {"alert": {"title": "fixture only", "kind": "down"}}
                    self.assertEqual(request(p, "/alert", "POST", payload)[0], 401)
                    self.assertEqual(Fixture.alerts, [])
                    self.assertEqual(
                        value(request(p, "/alert", "POST", payload, h)), {"ok": True}
                    )
                    self.assertEqual(Fixture.alerts, [payload])
                    Fixture.mode = "alert-rejected"
                    self.assertEqual(request(p, "/alert", "POST", payload, h)[0], 403)
                    Fixture.mode = "alert-nonjson"
                    self.assertEqual(
                        value(request(p, "/alert", "POST", payload, h)), {}
                    )
                    self.assertEqual(request(p, "/alert", "POST", b"{", h)[0], 400)
                before = len(Fixture.alerts)
                with running(
                    "health", **{**env, "HEALTH_ALERTS_DISABLED": "true"}
                ) as p:
                    self.assertEqual(request(p, "/alert", "POST", {}, h)[0], 503)
                self.assertEqual(len(Fixture.alerts), before)
                with running("health", **{**env, "PROBE_SECRET": ""}) as p:
                    self.assertEqual(request(p, "/health")[0], 401)
            finally:
                stub.shutdown()
                stub.server_close()

    def test_media_atomic_store_range_security_and_limit(self):
        with tempfile.TemporaryDirectory() as d:
            h = {"x-media-token": "fixture"}
            with running("media", MEDIA_DIR=d, MEDIA_TOKEN="fixture") as p:
                path = "/internal/media/uploads/2026-10/test.png"
                png = b"\x89PNG\x01\x02\x03"
                self.assertEqual(request(p, path, "PUT", png)[0], 403)
                self.assertEqual(
                    request(p, path, "PUT", png, {"x-media-token": "incorrect"})[0], 403
                )
                self.assertEqual(request(p, path, "PUT", png, h)[0], 201)
                r = request(p, "/media/uploads/2026-10/test.png")
                self.assertEqual(r[2], png)
                self.assertEqual(r[1]["content-type"], "image/png")
                self.assertIn("immutable", r[1]["cache-control"])
                self.assertIn("sandbox", r[1]["content-security-policy"])
                r = request(
                    p, "/media/uploads/2026-10/test.png", headers={"range": "bytes=1-3"}
                )
                self.assertEqual((r[0], r[2]), (206, png[1:4]))
                self.assertEqual(
                    request(p, "/media/uploads/2026-10/test.png", "HEAD")[2], b""
                )
                for raw in [
                    "%2e%2e/escape",
                    "uploads/..%2F..%2Fx",
                    "a//b",
                    ".hidden",
                    "a%5Cb",
                    "a%zz",
                ]:
                    self.assertEqual(
                        request(p, "/internal/media/" + raw, "PUT", b"x", h)[0],
                        400,
                        raw,
                    )
                    self.assertEqual(request(p, "/media/" + raw)[0], 404, raw)
                self.assertEqual(
                    request(p, path, "PUT", b"x" * (20 * 1024 * 1024 + 1), h)[0], 413
                )
                self.assertEqual(
                    (Path(d) / "uploads/2026-10/test.png").read_bytes(), png
                )
                self.assertEqual(
                    request(p, "/internal/media/x.html", "PUT", b"<script/>", h)[0], 201
                )
                self.assertEqual(
                    request(p, "/media/x.html")[1]["content-disposition"], "attachment"
                )
                self.assertEqual(request(p, path, "DELETE", headers=h)[0], 204)
                self.assertEqual(request(p, path, "DELETE", headers=h)[0], 404)
                self.assertEqual(request(p, "/media/uploads/2026-10/test.png")[0], 404)
                self.assertFalse(list(Path(d).rglob(".upload-*")))

    def test_analytics_schema_salt_stats_and_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            db = str(Path(d) / "analytics.db")
            iphone = "iPhone Mobile Safari"
            mac = "Macintosh Chrome/141.0 Safari/537.36"

            def post(p, ua, ip, b, host="chakkritton.com"):
                return request(
                    p,
                    "/_a",
                    "POST",
                    b,
                    {
                        "host": host,
                        "user-agent": ua,
                        "cf-connecting-ip": ip,
                        "cf-ipcountry": "TH",
                    },
                )

            with running("analytics", ANALYTICS_DB=db) as p:
                self.assertEqual(
                    post(
                        p,
                        iphone,
                        "1.1.1.1",
                        {
                            "t": "pv",
                            "p": "/?token=secret#x",
                            "r": "https://www.google.com/?private=x",
                        },
                    )[0],
                    204,
                )
                post(p, iphone, "1.1.1.1", {"t": "pv", "p": "/th/projects"})
                post(p, mac, "2.2.2.2", {"t": "pv", "p": "/"}, "www.chakkritton.com")
                for ua, n, v in [
                    (mac, "LCP", 1800),
                    (iphone, "LCP", 2600),
                    (iphone, "EVIL", 1),
                    (iphone, "LCP", -1),
                    (iphone, "LCP", 600000),
                ]:
                    post(p, ua, "1.1.1.1", {"t": "v", "p": "/", "n": n, "v": v})
                post(p, "Googlebot", "3.3.3.3", {"t": "pv", "p": "/"})
                post(p, iphone, "4.4.4.4", {"t": "pv", "p": "/"}, "evil.invalid")
                post(p, iphone, "4.4.4.4", {"t": "pv", "p": "http://evil"})
                b = value(request(p, "/stats?host=chakkritton.com&days=7"))
                self.assertEqual(b["totals"], {"views": 3, "visitors": 2})
                self.assertEqual(
                    b["referrers"], [{"key": "google.com", "views": 1, "visitors": 1}]
                )
                self.assertEqual(b["pages"][0], {"key": "/", "views": 2, "visitors": 2})
                self.assertEqual(
                    b["vitals"]["LCP"],
                    {"p75": 2600, "n": 2, "mobile": 2600, "desktop": 1800},
                )
                self.assertEqual(b["days"], 7)
                self.assertEqual(value(request(p, "/stats?days=0"))["days"], 7)
                self.assertEqual(value(request(p, "/stats?days=999"))["days"], 400)
                with contextlib.closing(sqlite3.connect(db)) as sql:
                    self.assertEqual(
                        len(sql.execute("SELECT * FROM salt").fetchall()), 1
                    )
                    rows = sql.execute("SELECT visitor,path,ref FROM views").fetchall()
                    self.assertEqual(rows[0][0], rows[1][0])
                    self.assertNotEqual(rows[0][0], rows[2][0])
                    self.assertEqual(
                        [c[1] for c in sql.execute("PRAGMA table_info(views)")],
                        [
                            "ts",
                            "day",
                            "host",
                            "path",
                            "ref",
                            "country",
                            "device",
                            "browser",
                            "visitor",
                        ],
                    )
            with running("analytics", ANALYTICS_DB=db, ANALYTICS_READ_ONLY="true") as p:
                self.assertEqual(
                    value(request(p, "/stats?host=chakkritton.com&days=7")), b
                )
                self.assertEqual(
                    post(p, iphone, "1.1.1.1", {"t": "pv", "p": "/"})[0], 503
                )
            with contextlib.closing(sqlite3.connect(db)) as sql:
                self.assertEqual(
                    sql.execute("SELECT count(*) FROM views").fetchone()[0], 3
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
