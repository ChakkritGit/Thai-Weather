"""Driving model from the Open-Meteo forecast API (GFS, ECMWF IFS, ICON …).

The API is queried on a regular coarse lattice with ``elevation=nan`` and
``cell_selection=nearest`` so we receive the *raw* model grid-cell values –
exactly what a ~22–25 km global model knows – and do all high-resolution
downscaling ourselves.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta

import httpx
import numpy as np

from ..core.grid import Grid, grid_for
from ..core.static import load_static
from ..core.thermo import wind_components
from .base import CoarseForecast

log = logging.getLogger(__name__)

HOURLY = (
    "temperature_2m",
    "dew_point_2m",
    "precipitation",
    "cape",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_speed_850hPa",
    "wind_direction_850hPa",
    "cloud_cover",
    "shortwave_radiation",
    "surface_pressure",
)
BATCH = 100


class OpenMeteoSource:
    name = "open-meteo"

    def __init__(
        self,
        model: str = "gfs_seamless",
        spacing_deg: float = 0.25,
        api_key: str | None = None,
        base_url: str | None = None,
        client: httpx.Client | None = None,
        calls_per_minute: int | None = None,
    ) -> None:
        self.model = model
        self.grid: Grid = grid_for(spacing_deg)
        self.api_key = api_key
        self.base_url = base_url or (
            "https://customer-api.open-meteo.com/v1/forecast" if api_key else "https://api.open-meteo.com/v1/forecast"
        )
        self.client = client or httpx.Client(timeout=60.0)
        # Open-Meteo counts every location as one call (free tier: 600/min,
        # 5,000/h, 10,000/day), so batches are spaced out to stay under the
        # per-minute cap. None disables pacing (paid plans, tests).
        self.batch_interval = 60.0 * BATCH / calls_per_minute if calls_per_minute else 0.0

    def _request(self, lats: list[float], lons: list[float], start: datetime, hours: int) -> list[dict]:
        end = start + timedelta(hours=hours - 1)
        params = {
            "latitude": ",".join(f"{v:.3f}" for v in lats),
            "longitude": ",".join(f"{v:.3f}" for v in lons),
            "elevation": ",".join("nan" for _ in lats),
            "hourly": ",".join(HOURLY),
            "models": self.model,
            "wind_speed_unit": "ms",
            "timezone": "GMT",
            "cell_selection": "nearest",
            "start_hour": start.strftime("%Y-%m-%dT%H:00"),
            "end_hour": end.strftime("%Y-%m-%dT%H:00"),
        }
        if self.api_key:
            params["apikey"] = self.api_key
        for attempt in range(4):
            try:
                r = self.client.get(self.base_url, params=params)
                r.raise_for_status()
                data = r.json()
                return data if isinstance(data, list) else [data]
            except (httpx.HTTPError, ValueError) as exc:
                if attempt == 3:
                    raise
                limited = isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429
                wait = 65.0 if limited else 2.0**attempt
                log.warning("open-meteo request failed (%s), retrying in %.0fs", exc, wait)
                time.sleep(wait)
        raise RuntimeError("unreachable")

    def fetch(self, start: datetime, hours: int) -> CoarseForecast:
        g = self.grid
        lat2, lon2 = np.meshgrid(g.lats, g.lons, indexing="ij")
        flat_lat, flat_lon = lat2.ravel().tolist(), lon2.ravel().tolist()
        n = len(flat_lat)

        raw = {v: np.full((hours, n), np.nan, dtype=np.float32) for v in HOURLY}
        elev = np.full(n, np.nan, dtype=np.float32)
        times: list[datetime] | None = None
        for b0 in range(0, n, BATCH):
            if b0 and self.batch_interval:
                time.sleep(self.batch_interval)
            chunk = self._request(flat_lat[b0 : b0 + BATCH], flat_lon[b0 : b0 + BATCH], start, hours)
            for k, loc in enumerate(chunk):
                idx = b0 + k
                if loc.get("elevation") is not None:
                    elev[idx] = loc["elevation"]
                hourly = loc["hourly"]
                if times is None:
                    times = [datetime.fromisoformat(s).replace(tzinfo=UTC) for s in hourly["time"]][:hours]
                for v in HOURLY:
                    vals = hourly.get(v) or []
                    arr = np.array([np.nan if x is None else x for x in vals[:hours]], dtype=np.float32)
                    raw[v][: arr.size, idx] = arr

        assert times is not None
        nt = len(times)
        shape = (nt, *g.shape)

        def grid_of(v: str, fill: float | np.ndarray) -> np.ndarray:
            a = raw[v][:nt].reshape(shape)
            fill_arr = np.broadcast_to(fill, shape)
            return np.where(np.isnan(a), fill_arr, a).astype(np.float32)

        static = load_static()
        dem = static.block_mean(static.elev_land, g)
        orog = np.where(np.isnan(elev.reshape(g.shape)), dem, elev.reshape(g.shape)).astype(np.float32)

        u10, v10 = wind_components(grid_of("wind_speed_10m", 0.0), grid_of("wind_direction_10m", 0.0))
        s850 = grid_of("wind_speed_850hPa", np.hypot(u10, v10) * 1.5)
        d850 = grid_of("wind_direction_850hPa", grid_of("wind_direction_10m", 0.0))
        u850, v850 = wind_components(s850, d850)

        t2m = grid_of("temperature_2m", 27.0)
        fields = {
            "t2m": t2m,
            "td2m": np.minimum(grid_of("dew_point_2m", t2m - 3.0), t2m),
            "precip": np.clip(grid_of("precipitation", 0.0), 0, None),
            "cape": np.clip(grid_of("cape", 500.0), 0, None),
            "u10": u10.astype(np.float32),
            "v10": v10.astype(np.float32),
            "u850": u850.astype(np.float32),
            "v850": v850.astype(np.float32),
            "cloud": grid_of("cloud_cover", 50.0),
            "sw": np.clip(grid_of("shortwave_radiation", 0.0), 0, None),
            "psfc": grid_of("surface_pressure", 1008.0),
        }
        missing = int(np.isnan(raw["temperature_2m"][:nt]).sum())
        notes = [f"{missing} missing temperature values were gap-filled"] if missing else []
        fc = CoarseForecast(
            source=self.name,
            model=self.model,
            grid=g,
            times=times,
            orography=orog,
            fields=fields,
            issued=datetime.now(UTC),
            notes=notes,
        )
        fc.validate()
        return fc
