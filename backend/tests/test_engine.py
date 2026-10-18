"""The Rust worker contract, without network calls or background side effects."""

import asyncio
import json
import os
import stat
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from oracle.routes import router

from app.config import Settings
from app.engine.runtime import Services
from app.engine.worker import MAX_REQUEST, dispatch, serve
from app.push.service import PushService
from app.push.vapid import b64url, generate
from app.scheduler import Refresher


@pytest.fixture(scope="module")
def state(run_dir):
    settings = Settings(
        data_dir=run_dir,
        source="demo",
        run_on_startup=False,
        background_tasks=False,
        push_enabled=False,
        extras_enabled=False,
        nowcast_source="off",
        cyclones_enabled=False,
    )
    services = Services(settings)
    services.start()
    yield services
    services.close()


def result(state, op, args=None, etag=""):
    metadata, body = dispatch(state, {"op": op, "args": args or {}, "if_none_match": etag})
    return json.loads(metadata), body


@pytest.mark.parametrize(
    "op,args,url",
    [
        ("health", {}, "/health"),
        ("meta", {}, "/meta"),
        ("point", {"lat": 18.59, "lon": 98.49}, "/point?lat=18.59&lon=98.49"),
        ("forecast", {"lat": 13.75, "lon": 100.5}, "/forecast?lat=13.75&lon=100.5"),
        ("provinces", {}, "/provinces"),
        ("province", {"pid": "TH-10"}, "/provinces/TH-10"),
        ("province", {"pid": "unknown"}, "/provinces/unknown"),
        ("alerts", {"min_severity": 2}, "/alerts?min_severity=2"),
        ("air_forecast", {}, "/air/forecast"),
        ("air_stations", {}, "/air/stations"),
        ("nowcast", {"lat": 13.75, "lon": 100.5}, "/nowcast?lat=13.75&lon=100.5"),
        ("nowcast_status", {}, "/nowcast/status"),
        ("nowcast_frames", {}, "/nowcast/frames"),
        ("nowcast_layer", {"lead": 0}, "/nowcast/layer?lead=0"),
        ("nowcast_frame", {"frame_id": "missing"}, "/nowcast/frame/missing"),
        ("push_public_key", {}, "/push/public-key"),
        ("push_status", {}, "/push/status"),
    ],
)
def test_worker_matches_the_legacy_read_contract(state, op, args, url):
    app = FastAPI()
    app.include_router(router)
    for name in ("store", "refresher", "observations", "nowcast", "push", "met", "air", "pm"):
        setattr(app.state, name, getattr(state, name))
    # No lifespan or real network: this is the in-process legacy HTTP oracle.
    with TestClient(app) as client:
        expected = client.get("/api/v1" + url)
    metadata, body = result(state, op, args)
    assert metadata["status"] == expected.status_code
    assert json.loads(body) == expected.json()
    for name in ("content-type", "cache-control", "etag", "x-grid-ny", "x-grid-nx"):
        assert metadata["headers"].get(name) == expected.headers.get(name)


@pytest.mark.parametrize("name", ["hillshade", "thai", "elevation"])
def test_raw_binary_products_and_304_are_not_base64_encoded(state, name):
    metadata, body = result(state, "static_layer", {"name": name})
    assert metadata["status"] == 200
    assert len(body) == 751 * 421
    headers = metadata["headers"]
    assert headers["content-type"] == "application/octet-stream"
    assert int(headers["x-grid-ny"]) * int(headers["x-grid-nx"]) == len(body)
    cached, content = result(state, "static_layer", {"name": name}, headers["etag"])
    assert cached["status"] == 304 and content == b""
    assert cached["headers"]["etag"] == headers["etag"]


def test_serve_only_mode_enforces_no_workers_even_with_sources_enabled(run_dir):
    state = Services(
        Settings(
            data_dir=run_dir,
            source="open-meteo",
            background_tasks=False,
            run_on_startup=True,
            push_enabled=True,
            extras_enabled=True,
            nowcast_source="rainviewer",
            cyclones_enabled=True,
        )
    )
    try:
        state.start()
        assert state.refresher._thread is None and state.nowcast._thread is None
        assert state.push is state.met is state.air is state.pm is None
        assert state._lease is None
        assert result(state, "trigger_run")[0]["status"] == 503
    finally:
        state.close()


def test_validation_stays_bounded_and_does_not_echo_secrets(state):
    assert result(state, "nowcast", {"lat": float("nan"), "lon": 100})[0]["status"] == 422
    assert result(state, "point", {"lat": 95, "lon": 100})[0]["status"] == 422
    assert (
        result(state, "push_subscribe", {"body": {"subscription": {"keys": {"auth": "private-marker"}}}})[0]["status"]
        == 422
    )
    metadata, body = result(state, "ingest_observations", {"items": [{"station_id": "private-marker"}]})
    assert metadata["status"] == 422 and b"private-marker" not in body
    assert result(state, "__import__")[0]["status"] == 404


def test_production_worker_does_not_import_an_http_framework():
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import app.engine.worker, sys; assert not {'fastapi', 'starlette', 'uvicorn'} & sys.modules.keys()",
        ],
        check=True,
    )


def test_only_one_background_worker_can_own_a_data_directory(run_dir, monkeypatch):
    starts = []
    monkeypatch.setattr(Refresher, "start", lambda self: starts.append(self))
    settings = Settings(
        data_dir=run_dir,
        source="demo",
        background_tasks=True,
        push_enabled=False,
        extras_enabled=False,
        nowcast_source="off",
        cyclones_enabled=False,
    )
    one, two = Services(settings), Services(settings)
    try:
        one.start()
        with pytest.raises(RuntimeError, match="another numerical worker"):
            two.start()
        assert starts == [one.refresher]
        one.close()
        two.start()
        assert starts == [one.refresher, two.refresher]
    finally:
        one.close()
        two.close()


def test_push_worker_round_trip_uses_only_a_fake_sender(state, tmp_path):
    settings = state.settings.model_copy(update={"data_dir": tmp_path})
    push = PushService(settings, state.nowcast, sender=lambda *_a, **_kw: pytest.fail("no notifications in tests"))
    original = state.push
    state.push = push
    subscription = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/isolated-rust-worker",
        "keys": {"p256dh": generate()[1], "auth": b64url(os.urandom(16))},
    }
    try:
        body = {"subscription": subscription, "lat": 13.75, "lon": 100.5, "label": "test", "prefs": {"heat": True}}
        metadata, response = result(state, "push_subscribe", {"body": body})
        assert metadata["status"] == 200 and json.loads(response)["prefs"]["heat"] is True
        wrong = {**subscription, "keys": {**subscription["keys"], "auth": b64url(os.urandom(16))}}
        assert result(state, "push_unsubscribe", {"body": wrong})[0]["status"] == 403
        assert json.loads(result(state, "push_unsubscribe", {"body": subscription})[1]) == {"ok": True, "deleted": True}
        assert json.loads(result(state, "push_unsubscribe", {"body": subscription})[1]) == {
            "ok": True,
            "deleted": False,
        }
    finally:
        state.push = original
        push.close()


def test_ingest_remains_buffered_without_triggering_a_run(state, monkeypatch):
    monkeypatch.setattr(state.refresher, "trigger", lambda: pytest.fail("no forecast during tests"))
    observation = {"station_id": "test-engine", "lat": 13.75, "lon": 100.5, "time": "2026-10-09T00:00:00Z", "t2m": 28}
    metadata, body = result(state, "ingest_observations", {"items": [observation]})
    assert metadata["status"] == 200 and json.loads(body)["accepted"] == 1
    assert json.loads(body)["applied_on"] == "next forecast run"
    observation["time"] = "2026-10-09T00:00:00"
    assert result(state, "ingest_observations", {"items": [observation]})[0]["status"] == 422


def test_actual_unix_framing_permissions_invalid_length_and_graceful_stop(state):
    async def scenario(path):
        stop = asyncio.Event()
        task = asyncio.create_task(serve(path, state, stop))
        try:
            for _ in range(100):
                if path.exists():
                    break
                if task.done():
                    await task
                await asyncio.sleep(0.01)
            assert stat.S_IMODE(path.stat().st_mode) == 0o600

            async def call(payload):
                reader, writer = await asyncio.open_unix_connection(path)
                writer.write(struct.pack("!I", len(payload)) + payload)
                await writer.drain()
                header_len, body_len = struct.unpack("!II", await reader.readexactly(8))
                metadata = json.loads(await reader.readexactly(header_len))
                body = await reader.readexactly(body_len)
                writer.close()
                await writer.wait_closed()
                return metadata, body

            metadata, body = await call(b'{"op":"static_layer","args":{"name":"thai"}}')
            assert metadata["status"] == 200 and len(body) == 751 * 421
            reader, writer = await asyncio.open_unix_connection(path)
            writer.write(struct.pack("!I", MAX_REQUEST + 1))
            await writer.drain()
            assert await reader.read(1) == b""
            writer.close()
            await writer.wait_closed()
            metadata, body = await call(b'{"op":"shutdown"}')
            assert metadata["status"] == 200 and json.loads(body)["ok"] is True
            await task
            assert not path.exists()
        finally:
            stop.set()
            await task

    # macOS's long default pytest TMPDIR exceeds the Unix socket path limit.
    with tempfile.TemporaryDirectory(
        prefix="thwx-ipc-", dir="/private/tmp" if sys.platform == "darwin" else "/tmp"
    ) as root:
        os.chmod(root, 0o700)
        asyncio.run(scenario(Path(root) / "engine.sock"))
