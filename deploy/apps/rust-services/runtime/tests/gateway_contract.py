"""Native JWT/RLS proxy contracts against a disposable JWKS and PostgREST fixture."""

import base64
import hmac
import json
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

from http_contract import request, running, value

SECRET = "fixture-signing-key-" * 3
USER = "11111111-2222-3333-4444-555555555555"


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def decode(s):
    return json.loads(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)))


def local(claims, secret=SECRET):
    h = b64(b'{"alg":"HS256","typ":"JWT"}')
    b = b64(json.dumps(claims).encode())
    data = (h + "." + b).encode()
    return data.decode() + "." + b64(hmac.digest(secret.encode(), data, "sha256"))


def verify(token):
    h, b, sig = token.split(".")
    assert hmac.compare_digest(
        b64(hmac.digest(SECRET.encode(), (h + "." + b).encode(), "sha256")), sig
    )
    return decode(b)


class Rest(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    jwk: ClassVar[dict] = {}
    seen: ClassVar[list] = []
    profiles = 0

    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.answer()

    def do_GET(self):
        self.answer()

    def do_POST(self):
        self.answer()

    def do_PATCH(self):
        self.answer()

    def answer(self):
        body = b""
        if self.headers.get("transfer-encoding") == "chunked":
            while n := int(self.rfile.readline().strip().split(b";")[0], 16):
                body += self.rfile.read(n)
                self.rfile.read(2)
            self.rfile.read(2)
        else:
            body = self.rfile.read(int(self.headers.get("content-length", 0)))
        cls = type(self)
        cls.seen.append((self.command, self.path, dict(self.headers), body))
        status, result = 200, {"ok": True}
        if self.path.endswith("/.well-known/jwks.json"):
            result = {"keys": [cls.jwk]}
        elif self.path == "/profiles" and self.command == "POST":
            self.assert_profile(body)
            cls.profiles += 1
            status, result = 201, None
        elif self.path.startswith("/items"):
            authorization = self.headers.get("authorization")
            claims = verify(authorization[7:]) if authorization else None
            assert not self.headers.get("apikey")
            assert not self.headers.get("x-forwarded-for")
            assert not self.headers.get("cf-connecting-ip")
            result = {
                "method": self.command,
                "path": self.path,
                "claims": claims,
                "body": body.decode(),
            }
        elif self.path == "/function/":
            result = {
                "body": body.decode(),
                "statusSecret": self.headers.get("x-status-secret"),
                "authorization": self.headers.get("authorization"),
            }
        elif self.path == "/redirect":
            status = 307
        data = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.send_header("content-range", "0-1/2")
        self.send_header("location", "/destination")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def assert_profile(self, body):
        assert json.loads(body) == {"id": USER}
        claims = verify(self.headers["authorization"][7:])
        assert claims["role"] == "service_role"
        assert self.headers["prefer"] == "resolution=ignore-duplicates,return=minimal"


class Gateway(unittest.TestCase):
    def test_jwks_claims_rls_streaming_and_function(self):
        with tempfile.TemporaryDirectory() as d:
            key = Path(d) / "private.pem"
            subprocess.run(
                [
                    "openssl",
                    "ecparam",
                    "-name",
                    "prime256v1",
                    "-genkey",
                    "-noout",
                    "-out",
                    str(key),
                ],
                check=True,
                capture_output=True,
            )
            public = subprocess.check_output(
                ["openssl", "ec", "-in", str(key), "-pubout", "-outform", "DER"],
                stderr=subprocess.DEVNULL,
            )[-65:]
            self.assertEqual(public[0], 4)
            Rest.jwk = {
                "kty": "EC",
                "crv": "P-256",
                "kid": "fixture",
                "alg": "ES256",
                "use": "sig",
                "x": b64(public[1:33]),
                "y": b64(public[33:]),
            }
            Rest.seen, Rest.profiles = [], 0
            stub = ThreadingHTTPServer(("127.0.0.1", 0), Rest)
            threading.Thread(target=stub.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{stub.server_port}"
            env = {
                "REST_URL": base,
                "REMINDERS_URL": base + "/function",
                "SUPABASE_URL": base,
                "SUPABASE_ANON_KEY": "fixture-anon",
                "PGRST_JWT_SECRET": SECRET,
            }

            def session(**overrides):
                claims = {
                    "iss": base + "/auth/v1",
                    "aud": "authenticated",
                    "sub": USER,
                    "role": "authenticated",
                    "exp": int(time.time()) + 7200,
                    "session_id": "fixture-session",
                    "aal": "aal1",
                    "is_anonymous": False,
                    **overrides,
                }
                h = b64(b'{"alg":"ES256","kid":"fixture"}')
                body = b64(json.dumps(claims).encode())
                data = (h + "." + body).encode()
                der = subprocess.check_output(
                    ["openssl", "dgst", "-sha256", "-sign", str(key)], input=data
                )
                self.assertEqual(der[0], 0x30)
                self.assertEqual(der[2], 2)
                n = der[3]
                r = der[4 : 4 + n]
                off = 4 + n
                self.assertEqual(der[off], 2)
                s = der[off + 2 : off + 2 + der[off + 1]]
                sig = r.lstrip(b"\0").rjust(32, b"\0") + s.lstrip(b"\0").rjust(
                    32, b"\0"
                )
                return data.decode() + "." + b64(sig)

            try:
                with running("dbgw", **env) as p:
                    for token in [None, "fixture-anon"]:
                        h = (
                            {}
                            if token is None
                            else {"authorization": "Bearer " + token}
                        )
                        b = value(
                            request(
                                p, "/data/rest/v1/items?select=id&limit=2", headers=h
                            )
                        )
                        self.assertIsNone(b["claims"])
                        self.assertEqual(b["path"], "/items?select=id&limit=2")
                    token = local(
                        {"role": "service_role", "exp": int(time.time()) + 120}
                    )
                    b = value(
                        request(
                            p,
                            "/rest/v1/items",
                            headers={"authorization": "Bearer " + token},
                        )
                    )
                    self.assertEqual(b["claims"]["role"], "service_role")
                    self.assertEqual(Rest.profiles, 0)
                    user_token = session()
                    h = {
                        "authorization": "bEaReR  " + user_token,
                        "apikey": "must-strip",
                        "x-forwarded-for": "fixture",
                        "cf-connecting-ip": "fixture",
                        "prefer": "return=representation",
                    }
                    r = request(p, "/rest/v1/items?x=1", "PATCH", b'{"v":1}', h)
                    self.assertEqual(r[0], 200)
                    self.assertEqual(r[1]["content-range"], "0-1/2")
                    b = value(r)
                    self.assertEqual(b["body"], '{"v":1}')
                    self.assertEqual(b["claims"]["sub"], USER)
                    self.assertEqual(b["claims"]["role"], "authenticated")
                    self.assertEqual(b["claims"]["session_id"], "fixture-session")
                    self.assertEqual(b["claims"]["aal"], "aal1")
                    self.assertFalse(b["claims"]["is_anonymous"])
                    self.assertLessEqual(b["claims"]["exp"] - time.time(), 3600)
                    request(p, "/rest/v1/items", headers=h)
                    self.assertEqual(Rest.profiles, 1)
                    for bad in [
                        session(iss="https://evil.invalid/auth/v1"),
                        session(aud="other"),
                        session(role="service_role"),
                        session(exp=int(time.time()) - 1),
                        session(nbf=int(time.time()) + 60),
                        local({"role": "service_role"}, "wrong"),
                        "not-a-jwt",
                    ]:
                        self.assertEqual(
                            request(
                                p,
                                "/rest/v1/items",
                                headers={"authorization": "Bearer " + bad},
                            )[0],
                            401,
                        )
                    r = request(p, "/rest/v1/redirect")
                    self.assertEqual(r[0], 307)
                    self.assertEqual(r[1]["location"], "/destination")
                    h = {
                        "x-status-secret": "fixture-status",
                        "authorization": "Bearer unchanged",
                    }
                    b = value(
                        request(
                            p,
                            "/data/functions/v1/push-reminders",
                            "POST",
                            {"health": True},
                            h,
                        )
                    )
                    self.assertEqual(b["statusSecret"], "fixture-status")
                    self.assertEqual(b["authorization"], "Bearer unchanged")
                    self.assertEqual(json.loads(b["body"]), {"health": True})
                before = Rest.profiles
                with running("dbgw", **env, DBGW_READ_ONLY="true") as p:
                    self.assertEqual(
                        request(
                            p,
                            "/rest/v1/items",
                            headers={"authorization": "Bearer " + user_token},
                        )[0],
                        200,
                    )
                    self.assertEqual(request(p, "/rest/v1/items", "PATCH", {})[0], 503)
                self.assertEqual(Rest.profiles, before)
            finally:
                stub.shutdown()
                stub.server_close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
