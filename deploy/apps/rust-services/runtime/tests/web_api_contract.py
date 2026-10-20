"""Native web-adapter contracts using loopback fixtures and disposable SQLite only."""

import base64
import contextlib
import hashlib
import hmac
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

from http_contract import BIN, request, running, value

SECRET = "synthetic-private-signing-secret-" * 2
ANON = "synthetic-public-anon-key"


def decode(part):
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def verified_jwt(token):
    header, claims, signature = token.split(".")
    expected = hmac.digest(SECRET.encode(), f"{header}.{claims}".encode(), "sha256")
    if not hmac.compare_digest(expected, decode(signature)):
        raise AssertionError("invalid native HS256 signature")
    return json.loads(decode(header)), json.loads(decode(claims))


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen: ClassVar[list] = []
    db_status = 200
    auth_status = 200

    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.answer()

    def do_GET(self):
        self.answer()

    def do_POST(self):
        self.answer()

    def answer(self):
        cls = type(self)
        cls.seen.append((self.command, self.path, dict(self.headers)))
        status, body = 404, {"error": "private unexpected upstream request"}
        if self.command == "HEAD" and self.path == "/":
            status, body = 200, {}
        elif self.command == "GET" and self.path == "/plans?select=id&limit=1":
            status, body = cls.db_status, []
        elif self.command == "GET" and self.path == "/auth/v1/health":
            status, body = cls.auth_status, {"status": "private auth fixture"}
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


@contextlib.contextmanager
def upstream():
    Upstream.seen = []
    Upstream.db_status = Upstream.auth_status = 200
    server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@contextlib.contextmanager
def unconfigured_sync(database):
    """Start the intentional degraded state without a successful /health requirement."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(
            [BIN, "sync"],
            env={
                **os.environ,
                "PORT": str(port),
                "SYNC_DB": str(database),
                "SYNC_READ_ONLY": "false",
                "PARTY_TOKEN_SECRET": "",
            },
            stdout=log,
            stderr=log,
        )
        try:
            for _ in range(150):
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read().decode())
                try:
                    if request(port, "/health")[0] == 503:
                        break
                except OSError:
                    time.sleep(0.02)
            else:
                raise AssertionError("degraded sync startup timeout")
            yield port
        finally:
            process.terminate()
            process.wait(timeout=8)


class WebApiContracts(unittest.TestCase):
    def assert_health(self, response, db, auth):
        self.assertEqual(response[0], 200 if db and auth else 503)
        self.assertEqual(response[1]["cache-control"], "public, s-maxage=15")
        body = value(response)
        self.assertEqual(set(body), {"ok", "db", "auth"})
        self.assertIs(body["ok"], db and auth)
        for key, expected in [("db", db), ("auth", auth)]:
            self.assertEqual(set(body[key]), {"ok", "ms"})
            self.assertIs(body[key]["ok"], expected)
            self.assertIsInstance(body[key]["ms"], int)
            self.assertGreaterEqual(body[key]["ms"], 0)
        self.assertNotIn(b"private", response[2])

    def assert_anonymous_probes(self):
        self.assertTrue(Upstream.seen)
        for method, path, raw_headers in Upstream.seen:
            headers = {key.lower(): val for key, val in raw_headers.items()}
            self.assertEqual(method, "GET")
            self.assertIn(path, ["/plans?select=id&limit=1", "/auth/v1/health"])
            self.assertNotIn("cookie", headers)
            self.assertNotIn("authorization", headers)
            self.assertNotIn("x-sync-secret", headers)
            self.assertNotIn("x-forwarded-for", headers)
            if path.startswith("/plans"):
                # PostgREST's configured anonymous role handles the absent token.
                self.assertNotIn("apikey", headers)
            else:
                self.assertEqual(headers.get("apikey"), ANON)

    def test_site_health_success_head_and_no_user_or_profile_access(self):
        with upstream() as base:
            env = {
                "REST_URL": base,
                "SUPABASE_URL": base,
                "SUPABASE_ANON_KEY": ANON,
                "PGRST_JWT_SECRET": SECRET,
                "REMINDERS_URL": base + "/never-call-reminders",
                "DBGW_READ_ONLY": "false",
            }
            with running("dbgw", **env) as port:
                Upstream.seen = []
                self.assert_health(
                    request(
                        port,
                        "/site/health?account=untrusted",
                        headers={
                            "Cookie": "session=private",
                            "Authorization": "Bearer caller-must-not-forward",
                            "x-sync-secret": "untrusted",
                            "x-forwarded-for": "203.0.113.1",
                        },
                    ),
                    True,
                    True,
                )
                head = request(port, "/site/health", method="HEAD")
                self.assertEqual(head[0], 200)
                self.assertEqual(head[1]["cache-control"], "public, s-maxage=15")
                self.assertEqual(head[2], b"")
                self.assertEqual(len(Upstream.seen), 4)
                self.assert_anonymous_probes()

    def test_site_health_dependency_failures_are_separate_sanitized_and_cached(self):
        with (
            upstream() as base,
            running(
                "dbgw",
                REST_URL=base,
                SUPABASE_URL=base,
                SUPABASE_ANON_KEY=ANON,
                PGRST_JWT_SECRET=SECRET,
            ) as port,
        ):
            for db_status, auth_status in [(503, 200), (200, 503), (201, 204)]:
                Upstream.db_status, Upstream.auth_status = db_status, auth_status
                Upstream.seen = []
                self.assert_health(
                    request(port, "/site/health"),
                    db_status == 200,
                    auth_status == 200,
                )
                self.assert_anonymous_probes()
            head = request(port, "/site/health", method="HEAD")
            self.assertEqual(head[0], 503)
            self.assertEqual(head[1]["cache-control"], "public, s-maxage=15")
            self.assertEqual(head[2], b"")

    def test_site_health_missing_configuration_does_not_probe_any_dependency(self):
        with upstream() as base:
            for auth_url, anon in [("", ANON), (base, "")]:
                with (
                    self.subTest(auth_url=bool(auth_url), anon=bool(anon)),
                    running(
                        "dbgw",
                        REST_URL=base,
                        SUPABASE_URL=auth_url,
                        SUPABASE_ANON_KEY=anon,
                        PGRST_JWT_SECRET=SECRET,
                    ) as port,
                ):
                    Upstream.seen = []
                    for method in ["GET", "HEAD"]:
                        response = request(port, "/site/health", method=method)
                        self.assertEqual(response[0], 503)
                        self.assertEqual(
                            response[1]["cache-control"], "public, s-maxage=15"
                        )
                        self.assertEqual(
                            response[2],
                            b"" if method == "HEAD" else b'{"ok":false}',
                        )
                    self.assertEqual(Upstream.seen, [])

    def test_private_signer_normalizes_account_and_signs_exact_five_minute_claims(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            running(
                "sync",
                SYNC_DB=str(Path(directory) / "sync.db"),
                PARTY_TOKEN_SECRET=SECRET,
                SYNC_READ_ONLY="false",
            ) as port,
        ):
            before = int(time.time())
            room = hashlib.sha256(b"synthetic-account").hexdigest()
            for account in ["  Synthetic-Account\t", "synthetic-account"]:
                response = request(
                    port,
                    "/internal/token?account=untrusted",
                    method="POST",
                    body={"account": account},
                    headers={"x-sync-secret": SECRET},
                )
                self.assertEqual(response[0], 200)
                self.assertEqual(response[1]["cache-control"], "private, no-store")
                self.assertNotIn("set-cookie", response[1])
                body = value(response)
                self.assertEqual(set(body), {"token", "roomId"})
                self.assertEqual(body["roomId"], room)
                header, claims = verified_jwt(body["token"])
                self.assertEqual(header, {"alg": "HS256"})
                self.assertEqual(set(claims), {"sub", "iat", "exp"})
                self.assertEqual(claims["sub"], room)
                self.assertEqual(claims["exp"] - claims["iat"], 300)
                self.assertLessEqual(before, claims["iat"])
                self.assertLessEqual(claims["iat"], int(time.time()))
                self.assertNotIn("synthetic-account", json.dumps(claims))

    def test_private_signer_rejects_missing_or_mismatched_secrets_and_malformed_accounts(
        self,
    ):
        with (
            tempfile.TemporaryDirectory() as directory,
            running(
                "sync",
                SYNC_DB=str(Path(directory) / "sync.db"),
                PARTY_TOKEN_SECRET=SECRET,
                SYNC_READ_ONLY="false",
            ) as port,
        ):
            for headers in [{}, {"x-sync-secret": "wrong-secret"}]:
                response = request(
                    port,
                    "/internal/token",
                    "POST",
                    {"account": "synthetic-account"},
                    headers,
                )
                self.assertEqual(response[0], 403)
                self.assertEqual(value(response), {"error": "Forbidden"})
            for body in [
                {},
                {"account": None},
                {"account": 42},
                {"account": ""},
                {"account": "a" * 4097},
                [],
                b"invalid-json",
            ]:
                response = request(
                    port, "/internal/token", "POST", body, {"x-sync-secret": SECRET}
                )
                self.assertEqual(response[0], 400)
                self.assertEqual(value(response), {"error": "Invalid account"})
            self.assertEqual(request(port, "/internal/token")[0], 405)

    def test_private_signer_without_config_is_unavailable(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            unconfigured_sync(Path(directory) / "sync.db") as port,
        ):
            response = request(
                port,
                "/internal/token",
                "POST",
                {"account": "synthetic-account"},
                {"x-sync-secret": SECRET},
            )
            self.assertEqual(response[0], 503)
            self.assertEqual(value(response), {"error": "Sync is not configured"})

    def test_unconfigured_portfolio_search_and_health_preserve_get_head_and_caches(
        self,
    ):
        with running("portfolio-api", DATABASE_URL="") as port:
            for query in ["", "?locale=invalid", "?locale=en&locale=ja", "?locale=ja"]:
                for method in ["GET", "HEAD"]:
                    response = request(port, "/api/search" + query, method=method)
                    self.assertEqual(response[0], 200)
                    self.assertEqual(
                        response[1]["cache-control"],
                        "public, s-maxage=60, stale-while-revalidate=300",
                    )
                    self.assertEqual(response[2], b"" if method == "HEAD" else b"[]")
            for method in ["GET", "HEAD"]:
                response = request(port, "/api/health", method=method)
                self.assertEqual(response[0], 503)
                self.assertEqual(response[1]["cache-control"], "public, s-maxage=15")
                self.assertEqual(
                    response[2], b"" if method == "HEAD" else b'{"ok":false}'
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
