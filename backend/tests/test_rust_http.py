"""Real Rust → Python integration against an isolated synthetic run.

Build rust-api first, then set THWX_RUST_TEST_BIN to its executable. These tests
need permission to bind loopback/Unix sockets. They never use production data,
start background workers, contact weather/auth services or send notifications.
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from oracle.routes import router

from app.config import Settings
from app.engine.runtime import Services

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def rust(run_dir, tmp_path_factory):
    executable = os.environ.get("THWX_RUST_TEST_BIN")
    if not executable:
        pytest.skip("set THWX_RUST_TEST_BIN after the locked Rust build; HTTP integration is not yet verified")
    binary = Path(executable).resolve()
    assert binary.is_file(), "THWX_RUST_TEST_BIN must name the built executable"
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    env = {k: v for k, v in os.environ.items() if not k.startswith("THWX_")}
    env.update(
        THWX_HTTP_ADDR=f"127.0.0.1:{port}",
        THWX_PYTHON=sys.executable,
        THWX_DATA_DIR=str(run_dir),
        THWX_STATIC_DIR=str(BACKEND / "app/data"),
        THWX_SOURCE="demo",
        THWX_BACKGROUND_TASKS="false",
        THWX_RUN_ON_STARTUP="false",
        THWX_NOWCAST_SOURCE="off",
        THWX_CYCLONES_ENABLED="false",
        THWX_EXTRAS_ENABLED="false",
        THWX_PUSH_ENABLED="false",
        THWX_ADMIN_TOKEN="test-only-token",
        THWX_CORS_ORIGINS='["*"]',
        THWX_RATE_PER_MIN="2",
        THWX_RATE_PER_DAY="3",
    )
    log = tmp_path_factory.mktemp("rust-http") / "server.log"
    with log.open("wb") as output:
        process = subprocess.Popen([str(binary)], cwd=BACKEND, env=env, stdout=output, stderr=output)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}/api/v1", timeout=35, trust_env=False) as client:
                deadline = time.monotonic() + 90
                while True:
                    if process.poll() is not None:
                        pytest.fail("Rust startup failed:\n" + log.read_text())
                    try:
                        if client.get("/health").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    if time.monotonic() >= deadline:
                        pytest.fail("Rust startup timed out:\n" + log.read_text())
                    time.sleep(0.1)
                yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                pytest.fail("Rust did not stop its serve-only worker gracefully")
            assert process.returncode == 0, log.read_text()


@pytest.fixture(scope="module")
def oracle(run_dir):
    state = Services(
        Settings(
            data_dir=run_dir,
            source="demo",
            background_tasks=False,
            push_enabled=False,
            extras_enabled=False,
            nowcast_source="off",
            cyclones_enabled=False,
        )
    )
    app = FastAPI()
    app.include_router(router)
    for name in ("store", "refresher", "observations", "nowcast", "push", "met", "air", "pm"):
        setattr(app.state, name, getattr(state, name))
    try:
        with TestClient(app) as client:
            yield client
    finally:
        state.close()


@pytest.mark.parametrize(
    "path",
    [
        "/health",
        "/meta",
        "/places?q=ชัยภูมิ",
        "/places?q=CHIANG%20MAI",
        "/places?q=Stra%C3%9Fe",
        "/layers/temp?step=2",
        "/layers/rain?step=1&res=coarse",
        "/layers/rain24?day=0",
        "/static/hillshade",
        "/static/thai",
        "/static/elevation",
        "/geo/provinces",
        "/geo/countries",
        "/point?lat=18.59&lon=98.49",
        "/forecast?lat=13.75&lon=100.5",
        "/provinces",
        "/provinces/TH-10",
        "/provinces/missing",
        "/alerts?min_severity=2",
        "/air/forecast",
        "/air/stations",
        "/nowcast?lat=13.75&lon=100.5",
        "/nowcast/frames",
        "/nowcast/status",
        "/nowcast/layer?lead=0",
        "/nowcast/frame/missing",
        "/push/public-key",
    ],
)
def test_real_http_matches_json_binary_and_cache_contracts(rust, oracle, path):
    expected = oracle.get("/api/v1" + path)
    actual = rust.get(path)
    assert actual.status_code == expected.status_code
    if "json" in expected.headers.get("content-type", ""):
        assert actual.json() == expected.json()
    else:
        assert actual.content == expected.content
    for name in ("content-type", "cache-control", "etag", "last-modified", "x-grid-ny", "x-grid-nx", "x-run-id"):
        assert actual.headers.get(name) == expected.headers.get(name)
    if "etag" in expected.headers and not path.startswith("/geo/"):
        cached = rust.get(path, headers={"If-None-Match": actual.headers["etag"]})
        assert cached.status_code == 304 and cached.content == b""


@pytest.mark.parametrize(
    "path,status",
    [
        ("/places?q=" + "a" * 81, 422),
        ("/point?lat=NaN&lon=100", 422),
        ("/point?lat=13&lon=500", 422),
        ("/point?lat=40&lon=100", 422),
        ("/point", 422),
        ("/alerts?min_severity=4", 422),
        ("/nowcast/layer?lead=61", 422),
        ("/layers/temp?res=../../", 422),
        ("/layers/temp?step=-1", 404),
        ("/layers/temp?step=999", 404),
        ("/layers/missing", 404),
        ("/geo/missing", 404),
        ("/push/status", 401),
        ("/missing", 404),
    ],
)
def test_http_validation_and_unknown_resources(rust, path, status):
    assert rust.get(path).status_code == status


def test_cors_and_public_rate_limit_are_independent_of_internal_health(rust):
    headers = {"X-Real-IP": "198.51.100.75", "Origin": "https://example.test"}
    for _ in range(2):
        r = rust.get("/places?q=Bangkok", headers=headers)
        assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "*"
    limited = rust.get("/places?q=Bangkok", headers=headers)
    assert limited.status_code == 429 and int(limited.headers["retry-after"]) >= 1
    assert "x-ratelimit-remaining-day" in limited.headers
    assert rust.get("/health", headers=headers).status_code == 200
    assert rust.get("/places?q=Bangkok").status_code == 200
    preflight = rust.options(
        "/push/subscribe",
        headers={
            "Origin": "https://example.test",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert preflight.status_code == 200 and "POST" in preflight.headers["access-control-allow-methods"]


def test_admin_auth_buffered_ingestion_and_actual_body_size(rust):
    body = [{"station_id": "rust-test", "lat": 13.75, "lon": 100.5, "time": "2026-10-09T00:00:00Z", "t2m": 28}]
    assert rust.post("/observations", json=body).status_code == 401
    accepted = rust.post("/observations", json=body, headers={"Authorization": "Bearer test-only-token"})
    assert accepted.status_code == 200 and accepted.json()["applied_on"] == "next forecast run"
    assert rust.get("/push/status", headers={"Authorization": "Bearer test-only-token"}).json() == {"enabled": False}
    # Chunked with no Content-Length: cap the actual bytes, not just the header.
    oversized = rust.post(
        "/push/subscribe", content=iter([b"{" + b" " * 4097 + b"}"]), headers={"Content-Type": "application/json"}
    )
    assert oversized.status_code == 413


def test_openapi_document_is_the_existing_public_schema(rust):
    expected = json.loads((BACKEND / "rust-api/openapi.json").read_text())
    assert rust.get("/openapi.json").json() == expected


def test_trailing_slash_redirects_and_method_errors_keep_the_existing_contract(rust):
    redirected = rust.get("/places/?q=Bangkok")
    assert redirected.status_code == 307
    assert redirected.headers["location"] == "/api/v1/places?q=Bangkok"
    assert rust.get("/does-not-exist/").status_code == 404
    wrong_method = rust.put("/meta")
    assert wrong_method.status_code == 405 and wrong_method.json() == {"detail": "Method Not Allowed"}


def test_query_coercions_remain_compatible_with_the_previous_api(rust, oracle):
    for value in ["0.0", " 0 ", "+0", "-0.0", "2.000", "0.01", "1e0", "2."]:
        expected = oracle.get("/api/v1/layers/temp", params={"step": value})
        actual = rust.get("/layers/temp", params={"step": value})
        assert actual.status_code == expected.status_code, value
        if actual.status_code == 200:
            assert actual.content == expected.content
    assert rust.get("/point", params={"lat": " 13.75 ", "lon": " 100.5 "}).status_code == 200
