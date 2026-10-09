import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from verify import collect as collect_mod
from verify import db

HOURS = 4
TIMES = [f"2026-10-09T0{h}:00:00+00:00" for h in range(HOURS)]


def _api_handler(demo=False, run_id="20261009T0000Z-open-meteo", has_run=True):
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/meta":
            run = {"run_id": run_id, "demo": demo, "times": TIMES} if has_run else None
            return httpx.Response(200, json={"run": run})
        assert path == "/api/v1/point"
        if float(request.url.params["lat"]) > 20:
            return httpx.Response(422, json={"detail": "outside"})
        series = {"temp": [30.0, 31.0, 32.0, 33.0], "rain": [0.0, 0.5, 0.0, 0.0], "pop": [10, 20, 30, 40]}
        return httpx.Response(
            200,
            json={
                "run_id": run_id,
                "demo": demo,
                "times": TIMES,
                "fine": series,
                "coarse": {**series, "temp": [29.0, 30.0, 31.0, 32.0]},
            },
        )

    return handler


def _om_handler(request: httpx.Request) -> httpx.Response:
    p = request.url.params
    n = len(p["latitude"].split(","))
    assert p["models"] == "gfs_seamless" and p["timezone"] == "GMT"
    assert p["start_hour"] == "2026-10-09T00:00" and p["end_hour"] == "2026-10-09T03:00"
    assert len(p["elevation"].split(",")) == n
    loc = {
        "hourly": {
            "time": [f"2026-10-09T0{h}:00" for h in range(HOURS)],
            "temperature_2m": [28.0, None, 30.0, 31.0],
            "precipitation": [0.0, None, None, 0.0],
        }
    }
    return httpx.Response(200, json=[loc] * n if n > 1 else loc)


def _setup(tmp_path):
    conn = db.connect(tmp_path / "v.sqlite")
    db.upsert_station(conn, "VTBS", "BANGKOK", 13.68, 100.75, 3, "iem")
    db.upsert_station(conn, "VTCC", "CHIANG MAI", 18.77, 98.96, 312, "iem")
    db.upsert_station(conn, "FAR", "OUTSIDE", 25.0, 100.0, 10, "csv")
    conn.commit()
    return conn


def _count(conn, source):
    return conn.execute("SELECT COUNT(*) FROM forecasts WHERE source=?", (source,)).fetchone()[0]


def test_collect_archives_three_sources_once(tmp_path):
    conn = _setup(tmp_path)
    api = httpx.Client(transport=httpx.MockTransport(_api_handler()), base_url="http://api")
    om = httpx.Client(transport=httpx.MockTransport(_om_handler))
    assert collect_mod.collect(conn, api, om) == "20261009T0000Z-open-meteo"
    assert _count(conn, "fine") == _count(conn, "gfs_raw") == 2 * HOURS  # outside station skipped
    assert _count(conn, "openmeteo") == 2 * (HOURS - 1)  # the all-null hour is skipped
    row = conn.execute("SELECT * FROM forecasts WHERE source='fine' AND station='VTCC' AND lead_h=2").fetchone()
    assert (row["valid"], row["t2m"], row["rain"], row["pop"]) == ("2026-10-09T02:00", 32.0, 0.0, 30.0)
    run = conn.execute("SELECT * FROM runs").fetchone()
    assert (run["n_stations"], run["baseline_ok"], run["run_time"]) == (2, 1, "2026-10-09T00:00")
    assert collect_mod.collect(conn, api, om) is None  # already archived
    assert _count(conn, "fine") == 2 * HOURS


def test_demo_runs_are_skipped(tmp_path):
    conn = _setup(tmp_path)
    api = httpx.Client(transport=httpx.MockTransport(_api_handler(demo=True)), base_url="http://api")
    assert collect_mod.collect(conn, api, None) is None
    assert conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
    assert collect_mod.collect(conn, api, None, include_demo=True) is not None


def test_no_run_returns_none(tmp_path):
    conn = _setup(tmp_path)
    api = httpx.Client(transport=httpx.MockTransport(_api_handler(has_run=False)), base_url="http://api")
    assert collect_mod.collect(conn, api, None) is None


def test_baseline_failure_still_archives_forecasts(tmp_path):
    conn = _setup(tmp_path)
    api = httpx.Client(transport=httpx.MockTransport(_api_handler()), base_url="http://api")
    om = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429, json={"reason": "limit"})))
    assert collect_mod.collect(conn, api, om) is not None
    assert _count(conn, "fine") == 2 * HOURS
    assert _count(conn, "openmeteo") == 0
    assert conn.execute("SELECT baseline_ok FROM runs").fetchone()[0] == 0


def test_integration_against_real_app(run_dir, tmp_path):
    mp = pytest.MonkeyPatch()
    mp.setenv("THWX_DATA_DIR", str(run_dir))
    mp.setenv("THWX_RUN_ON_STARTUP", "false")
    get_settings.cache_clear()
    from app.main import app

    try:
        with TestClient(app) as api:
            conn = _setup(tmp_path)
            run_id = collect_mod.collect(conn, api, None, include_demo=True)
            assert run_id is not None
            n_times = len(api.get("/api/v1/meta").json()["run"]["times"])
            assert _count(conn, "fine") == _count(conn, "gfs_raw") == 2 * n_times
            lead_max = conn.execute("SELECT MAX(lead_h) FROM forecasts").fetchone()[0]
            assert lead_max == n_times - 1
    finally:
        mp.undo()
        get_settings.cache_clear()
