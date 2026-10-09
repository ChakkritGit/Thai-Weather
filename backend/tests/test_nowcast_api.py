import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.core.grid import FINE_GRID
from app.nowcast.cyclones import Cyclone, parse_geometry
from app.nowcast.service import LEADS, STALE_AFTER_MIN, NowcastService

G = FINE_GRID
LAT, LON = 13.75, 100.5
IY, IX = G.index(LAT, LON)
GEO = json.loads((Path(__file__).parent / "data" / "gdacs_tc_geometry.json").read_text())


def _blob(cx: int) -> np.ndarray:
    yy, xx = np.mgrid[0 : G.ny, 0 : G.nx]
    val = 5.0 + 50.0 * np.exp(-((yy - IY) ** 2 + (xx - cx) ** 2) / (2 * 8.0**2))
    return np.where(val >= 12.0, val, np.nan).astype(np.float32)


def _frames(newest_age_min: float) -> list[tuple[datetime, np.ndarray]]:
    newest = datetime.now(UTC) - timedelta(minutes=newest_age_min)
    return [(newest - timedelta(minutes=10 * k), _blob(IX - 30 - 4 * k)) for k in (2, 1, 0)]  # moving east


def _simon() -> Cyclone:
    track, zones = parse_geometry(GEO, datetime(2026, 10, 7, 15, tzinfo=UTC))
    return Cyclone("1001335-7", "Simon", "NOAA", 222.2, "TY", track, zones, "https://www.gdacs.org/report")


def _service(**overrides) -> NowcastService:
    return NowcastService(Settings(nowcast_source="rainviewer", cyclones_enabled=False, **overrides))


@pytest.fixture(scope="module")
def client(run_dir):
    mp = pytest.MonkeyPatch()
    mp.setenv("THWX_DATA_DIR", str(run_dir))
    mp.setenv("THWX_RUN_ON_STARTUP", "false")
    get_settings.cache_clear()
    from app.main import app

    with TestClient(app) as c:
        yield c
    mp.undo()
    get_settings.cache_clear()


@pytest.fixture
def swap(client):
    original = client.app.state.nowcast

    def _swap(service: NowcastService) -> TestClient:
        client.app.state.nowcast = service
        return client

    yield _swap
    client.app.state.nowcast = original


def test_disabled_by_default_in_tests(client):
    d = client.get(f"/api/v1/nowcast?lat={LAT}&lon={LON}").json()
    assert d["available"] is False and d["reason"] == "disabled"
    assert d["cyclones"] == [] and {a["name"] for a in d["attribution"]} == {"RainViewer", "GDACS"}
    assert client.get("/api/v1/nowcast/layer").status_code == 404
    st = client.get("/api/v1/nowcast/status").json()
    assert st["radar_enabled"] is False and st["leads"] == list(LEADS)
    assert client.get("/api/v1/health").json()["nowcast"]["radar_enabled"] is False


def test_available_nowcast(swap):
    service = _service()
    service.ingest(_frames(newest_age_min=3))
    service.set_cyclones([_simon()])
    c = swap(service)
    d = c.get(f"/api/v1/nowcast?lat={LAT}&lon={LON}").json()
    assert d["available"] is True and d["reason"] is None
    assert 2 <= d["age_min"] <= 4
    assert d["frame_time"].endswith("+00:00")
    assert d["now"]["class"] == "none"
    assert d["eta_rain"] is not None and 0 < d["eta_rain"]["minutes"] <= 60
    assert d["eta_rain"]["minutes_range"][0] <= d["eta_rain"]["minutes"] <= d["eta_rain"]["minutes_range"][1]
    assert d["nearest"]["approaching"] is True and 240 <= d["nearest"]["bearing_deg"] <= 300
    assert 30 < d["motion"]["speed_kmh"] < 80 and 60 <= d["motion"]["heading_deg"] <= 120
    cy = d["cyclones"][0]
    assert cy["name"] == "Simon" and cy["category"] == "TY" and cy["distance_now_km"] > 0
    assert {"time", "hours", "distance_km"} <= set(cy["closest"]) and "in_wind_zone_kmh" in cy


def test_stale_frame(swap):
    service = _service()
    service.ingest(_frames(newest_age_min=STALE_AFTER_MIN + 15))
    c = swap(service)
    d = c.get(f"/api/v1/nowcast?lat={LAT}&lon={LON}").json()
    assert d["available"] is False and d["reason"] == "stale"
    assert d["age_min"] >= STALE_AFTER_MIN + 15 and d["eta_rain"] is None
    assert c.get("/api/v1/nowcast/layer").status_code == 404


def test_no_data_yet_and_no_coverage(swap):
    c = swap(_service())
    assert c.get(f"/api/v1/nowcast?lat={LAT}&lon={LON}").json()["reason"] == "no_data"
    assert c.get("/api/v1/nowcast/layer").status_code == 404

    service = _service()
    covered = np.ones(G.shape, bool)
    covered[IY - 5 : IY + 6, IX - 5 : IX + 6] = False
    service.ingest(_frames(2), covered)
    c = swap(service)
    d = c.get(f"/api/v1/nowcast?lat={LAT}&lon={LON}").json()
    assert d["available"] is False and d["reason"] == "no_coverage"


def test_outside_domain_is_422(swap):
    c = swap(_service())
    assert c.get("/api/v1/nowcast?lat=40&lon=100").status_code == 422
    assert c.get("/api/v1/nowcast?lat=13&lon=500").status_code == 422


def test_layer_bytes_and_caching(swap):
    service = _service()
    service.ingest(_frames(2))
    c = swap(service)
    r = c.get("/api/v1/nowcast/layer?lead=0")
    assert r.status_code == 200
    assert len(r.content) == int(r.headers["x-grid-ny"]) * int(r.headers["x-grid-nx"]) == G.ny * G.nx
    assert r.headers["x-frame-time"].startswith("20") and r.headers["x-lead"] == "0"
    assert (r.headers["x-enc-min"], r.headers["x-enc-max"]) == ("-10.0", "75.0")
    codes = np.frombuffer(r.content, np.uint8)
    assert codes.max() > 100 and (codes == 0).mean() > 0.9  # echo present, mostly clear sky
    assert c.get("/api/v1/nowcast/layer?lead=0", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
    ahead = np.frombuffer(c.get("/api/v1/nowcast/layer?lead=60").content, np.uint8).reshape(G.shape)
    now = codes.reshape(G.shape)
    assert np.flatnonzero(ahead[IY] > 60).mean() > np.flatnonzero(now[IY] > 60).mean()  # the storm moved east
    assert c.get("/api/v1/nowcast/layer?lead=25").status_code == 404
    assert c.get("/api/v1/nowcast/layer?lead=90").status_code == 422


# ---------------------------------------------------------------- service
class StubRadar:
    host = "https://tiles.test"

    def __init__(self) -> None:
        t0 = datetime(2026, 10, 9, 6, tzinfo=UTC)
        self.listing = [(t0 + timedelta(minutes=10 * k), f"/v2/radar/{k}") for k in range(5)]
        self.available = 3
        self.fetched: list[str] = []
        self.fail = False

    def frames(self):
        if self.fail:
            raise httpx.ConnectError("down")
        return self.listing[: self.available]

    def fetch_frame(self, host, path, grid):
        self.fetched.append(path)
        return _blob(IX - 40 + 4 * int(path.rsplit("/", 1)[1]))

    def coverage(self, grid):
        return np.ones(grid.shape, bool)


def test_service_ingests_only_new_frames_and_keeps_last_good_state_on_errors():
    service = _service()
    radar = StubRadar()
    service._radar = radar
    assert service.poll_radar() is True
    assert radar.fetched == ["/v2/radar/0", "/v2/radar/1", "/v2/radar/2"]
    assert service.snapshot().frame_time == radar.listing[2][0]
    assert set(service.snapshot().layers) == set(LEADS)
    assert service.poll_radar() is False and len(radar.fetched) == 3  # nothing new: no tile requests
    radar.available = 4
    assert service.poll_radar() is True and radar.fetched[3:] == ["/v2/radar/3"]
    good = service.snapshot()

    radar.fail = True
    service.run_once()
    st = service.status
    assert st["state"] == "error" and "ConnectError" in st["last_error"]
    assert service.snapshot() is good  # last good snapshot retained
    radar.fail = False
    service.run_once()
    assert service.status["state"] == "idle" and service.status["last_error"] is None


def test_service_missed_frames_reset_the_buffer():
    service = _service()
    radar = StubRadar()
    radar.available = 2
    service._radar = radar
    service.poll_radar()
    radar.available = 5  # 3 newer frames appeared; the last known one fell out of the window
    service.poll_radar()
    assert [t for t, _ in service._frames] == [t for t, _ in radar.listing[2:5]]


def test_cyclone_failure_keeps_previous_list():
    service = NowcastService(Settings(nowcast_source="off", cyclones_enabled=True))
    service.set_cyclones([_simon()])
    service._http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    service.run_once()
    assert len(service.snapshot().cyclones) == 1
    assert "HTTPStatusError" in service.status["cyclones_error"]
    assert service.status["cyclones"] == 1


def test_start_does_nothing_when_disabled():
    service = NowcastService(Settings(nowcast_source="off", cyclones_enabled=False))
    service.start()
    assert service._thread is None and service.enabled is False
