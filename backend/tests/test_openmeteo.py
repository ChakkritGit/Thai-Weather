from datetime import UTC, datetime

import httpx
import numpy as np

from app.sources.openmeteo import OpenMeteoSource


def _handler(request: httpx.Request) -> httpx.Response:
    lats = request.url.params["latitude"].split(",")
    assert request.url.params["elevation"].split(",")[0] == "nan"
    assert request.url.params["cell_selection"] == "nearest"
    hours = 3
    times = [f"2026-10-09T0{h}:00" for h in range(hours)]
    body = []
    for lat in lats:
        body.append(
            {
                "latitude": float(lat),
                "elevation": 120.0,
                "hourly": {
                    "time": times,
                    "temperature_2m": [30.0] * hours,
                    "dew_point_2m": [24.0] * hours,
                    "precipitation": [1.0, None, 0.0],
                    "cape": [None] * hours,
                    "wind_speed_10m": [5.0] * hours,
                    "wind_direction_10m": [225.0] * hours,
                    "wind_speed_850hPa": [10.0] * hours,
                    "wind_direction_850hPa": [270.0] * hours,
                    "cloud_cover": [50.0] * hours,
                    "shortwave_radiation": [400.0] * hours,
                    "surface_pressure": [1005.0] * hours,
                },
            }
        )
    return httpx.Response(200, json=body)


def test_assembles_coarse_grid_from_api():
    src = OpenMeteoSource(spacing_deg=1.0, client=httpx.Client(transport=httpx.MockTransport(_handler)))
    fc = src.fetch(datetime(2026, 10, 9, tzinfo=UTC), 3)
    assert fc.fields["t2m"].shape == (3, *src.grid.shape)
    assert np.all(fc.orography == 120.0)
    assert fc.fields["precip"][1].max() == 0.0  # null → 0
    assert np.all(fc.fields["cape"] == 500.0)  # missing CAPE gap-filled
    assert np.allclose(fc.fields["u10"], 5.0 * np.sin(np.radians(45)), atol=1e-4)  # SW wind → +u
    assert np.allclose(fc.fields["u850"], 10.0, atol=1e-4)  # westerly → +u
    assert fc.times[0] == datetime(2026, 10, 9, tzinfo=UTC)


def test_paces_batches_for_free_tier(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr("app.sources.openmeteo.time.sleep", sleeps.append)
    src = OpenMeteoSource(
        spacing_deg=1.0, calls_per_minute=400, client=httpx.Client(transport=httpx.MockTransport(_handler))
    )
    src.fetch(datetime(2026, 10, 9, tzinfo=UTC), 3)
    n = src.grid.ny * src.grid.nx
    assert len(sleeps) == (n - 1) // 100  # one pause between consecutive batches
    assert all(s == 15.0 for s in sleeps)  # 100 locations every 15 s = 400/min


def test_backs_off_on_rate_limit(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr("app.sources.openmeteo.time.sleep", sleeps.append)
    calls = {"n": 0}

    def limited(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return (
            httpx.Response(429, json={"reason": "Minutely API request limit exceeded"})
            if calls["n"] == 1
            else _handler(request)
        )

    src = OpenMeteoSource(spacing_deg=2.0, client=httpx.Client(transport=httpx.MockTransport(limited)))
    src.fetch(datetime(2026, 10, 9, tzinfo=UTC), 3)
    assert sleeps[0] == 65.0
