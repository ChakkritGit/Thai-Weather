import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings


@pytest.fixture(scope="module")
def client(run_dir):
    mp = pytest.MonkeyPatch()
    mp.setenv("THWX_DATA_DIR", str(run_dir))
    mp.setenv("THWX_RUN_ON_STARTUP", "false")
    mp.setenv("THWX_ADMIN_TOKEN", "secret")
    get_settings.cache_clear()
    from app.main import app

    with TestClient(app) as c:
        yield c
    mp.undo()
    get_settings.cache_clear()


def test_meta_and_layers(client):
    meta = client.get("/api/v1/meta").json()
    assert meta["run"]["demo"] is True
    assert meta["fine_grid"]["resolution_km"] < 2.5
    assert {lyr["id"] for lyr in meta["layers"]} >= {"temp", "rain", "pop", "heat", "storm"}
    r = client.get("/api/v1/layers/temp?step=2")
    ny, nx = int(r.headers["x-grid-ny"]), int(r.headers["x-grid-nx"])
    assert len(r.content) == ny * nx == 751 * 421
    r2 = client.get("/api/v1/layers/temp?step=2", headers={"If-None-Match": r.headers["etag"]})
    assert r2.status_code == 304
    rc = client.get("/api/v1/layers/rain?step=2&res=coarse")
    assert len(rc.content) == int(rc.headers["x-grid-ny"]) * int(rc.headers["x-grid-nx"])
    assert client.get("/api/v1/layers/rain24?day=0").status_code == 200
    assert client.get("/api/v1/layers/nope").status_code == 404
    assert client.get("/api/v1/layers/temp?step=999").status_code == 404


def test_point_forecast_explains_corrections(client):
    d = client.get("/api/v1/point?lat=18.59&lon=98.49").json()  # Doi Inthanon
    assert d["location"]["province"]["id"] == "TH-50"
    assert d["location"]["elevation"] > 1800
    comps = d["temperature_components"]
    assert np.mean(comps["lapse"]) < -3  # far colder than the 22 km model cell
    assert len(d["fine"]["temp"]) == len(d["times"]) == len(d["coarse"]["temp"])
    assert client.get("/api/v1/point?lat=40&lon=100").status_code == 422


def test_provinces_and_alerts(client):
    provs = client.get("/api/v1/provinces").json()["provinces"]
    assert len(provs) == 77
    assert all(p["days"] for p in provs)
    bkk = client.get("/api/v1/provinces/TH-10").json()
    assert bkk["name_th"] == "กรุงเทพมหานคร"
    assert len(bkk["hourly"]["temp"]) == len(bkk["times"])
    alerts = client.get("/api/v1/alerts?min_severity=1").json()["alerts"]
    assert all(a["alerts"] for a in alerts)


def test_admin_endpoints_require_token(client):
    obs = [{"station_id": "48455", "lat": 13.73, "lon": 100.56, "time": "2026-10-09T00:00:00Z", "t2m": 27.5}]
    assert client.post("/api/v1/observations", json=obs).status_code == 401
    r = client.post("/api/v1/observations", json=obs, headers={"Authorization": "Bearer secret"})
    assert r.status_code == 200 and r.json()["accepted"] == 1


def test_static_layers_and_geo(client):
    assert len(client.get("/api/v1/static/hillshade").content) == 751 * 421
    geo = client.get("/api/v1/geo/provinces").json()
    assert len(geo["features"]) == 77
