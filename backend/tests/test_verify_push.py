import json
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from verify import db, holdout, push

NOW = datetime(2026, 10, 9, 10, 10, tzinfo=UTC)


def _conn(tmp_path):
    conn = db.connect(tmp_path / "v.sqlite")
    for i, sid in enumerate(["AAAA", "BBBB", "CCCC", "DDDD"]):
        db.upsert_station(conn, sid, sid, 10.0 + i, 100.0 + i, 20.0 * i, "iem")
    db.set_meta(conn, holdout.META_KEY, "BBBB")
    rows = [
        ("AAAA", "2026-10-09T09:00", 30.0),
        ("AAAA", "2026-10-09T10:00", 31.0),  # latest wins
        ("BBBB", "2026-10-09T10:00", 29.0),  # hold-out
        ("CCCC", "2026-10-09T07:30", 28.0),  # stale (> 120 min)
        ("DDDD", "2026-10-09T10:00", 99.0),  # outside the API range
    ]
    db.upsert_obs(conn, [(s, v, t, "", None) for s, v, t in rows])
    conn.commit()
    return conn


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), base_url="http://api")


def test_pushes_latest_report_of_assimilated_stations_only(tmp_path):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"accepted": len(seen["body"])})

    assert push.push(_conn(tmp_path), _client(handler), "tok", now=NOW) == 1
    assert seen["path"] == "/api/v1/observations" and seen["auth"] == "Bearer tok"
    assert seen["body"] == [
        {
            "station_id": "AAAA",
            "lat": 10.0,
            "lon": 100.0,
            "time": "2026-10-09T10:00:00+00:00",
            "t2m": 31.0,
            "elevation": 0.0,
        }
    ]


def test_no_header_without_token_and_nothing_to_send(tmp_path):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"accepted": 1})

    conn = _conn(tmp_path)
    assert push.push(conn, _client(handler), None, now=NOW) == 1
    assert "authorization" not in calls[0].headers
    assert push.push(conn, _client(handler), None, now=datetime(2026, 10, 10, tzinfo=UTC)) == 0
    assert len(calls) == 1  # no request when everything is stale


@pytest.mark.parametrize("status", [401, 422])
def test_rejection_is_logged_not_raised(tmp_path, caplog, status):
    api = _client(lambda request: httpx.Response(status, json={"detail": "nope"}))
    assert push.push(_conn(tmp_path), api, "bad", now=NOW) == 0
    assert "nope" in caplog.text


def test_payload_is_accepted_by_the_real_api(tmp_path, run_dir):
    mp = pytest.MonkeyPatch()
    mp.setenv("THWX_DATA_DIR", str(run_dir))
    mp.setenv("THWX_RUN_ON_STARTUP", "false")
    mp.setenv("THWX_ADMIN_TOKEN", "secret")
    get_settings.cache_clear()
    try:
        from app.main import app

        with TestClient(app) as tc:
            conn = db.connect(tmp_path / "v.sqlite")
            db.upsert_station(conn, "VTBS", "BKK", 13.68, 100.75, 3.0, "iem")
            db.upsert_station(conn, "VTCC", "CM", 18.77, 98.96, 312.0, "iem")
            db.set_meta(conn, holdout.META_KEY, "VTCC")
            db.upsert_obs(
                conn, [("VTBS", "2026-10-09T10:00", 32.0, "", None), ("VTCC", "2026-10-09T10:00", 30.0, "", None)]
            )
            conn.commit()
            assert push.push(conn, tc, "wrong", now=NOW) == 0  # 401
            assert push.push(conn, tc, "secret", now=NOW) == 1
    finally:
        mp.undo()
        get_settings.cache_clear()
