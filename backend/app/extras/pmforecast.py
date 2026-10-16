"""PM2.5 forecast over Thailand from FMI's SILAM global air-quality model (0.2°, hourly, ~5 days).

One NetCDF Subset Service request returns the whole Thai box for the next 72 hours (~1 MB), so it costs
nothing against the Open-Meteo quota. Refreshed every 3 hours in the background; the map draws it as a
field under the Air4Thai station dots (measured values). Concentrations come as kg/m³ and are served
as whole µg/m³ in one byte per cell (capped at 255).
"""

from __future__ import annotations

import base64
import io
import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import numpy as np
from scipy.io import netcdf_file

log = logging.getLogger(__name__)

URL = "https://thredds.silam.fmi.fi/thredds/ncss/grid/silam_glob_v6_1_sfc/silam_glob_v6_1_sfc_best.ncd"
BOX = {"north": 21.0, "south": 5.4, "west": 97.0, "east": 106.0}
HOURS = 72
REFRESH_S = 3 * 3600
RETRY_S = 20 * 60
ATTRIBUTION = {"name": "FMI SILAM", "url": "https://silam.fmi.fi", "license": "CC BY 4.0"}


@dataclass(frozen=True)
class Field:
    lat0: float  # southern row centre
    lon0: float  # western column centre
    dlat: float
    dlon: float
    times: list[datetime]
    ug: np.ndarray  # (time, lat, lon) uint8 µg/m³, row 0 = south


def parse(raw: bytes) -> Field:
    f = netcdf_file(io.BytesIO(raw), "r", mmap=False)
    try:
        v = f.variables["cnc_PM2_5"]
        lat = np.array(f.variables["lat"][:], dtype=float)
        lon = np.array(f.variables["lon"][:], dtype=float)
        tv = f.variables[v.dimensions[0]]
        units = tv.units.decode() if isinstance(tv.units, bytes) else str(tv.units)
        origin = datetime.fromisoformat(
            units.split("since", 1)[1].strip().replace(" UTC", "").replace(" ", "T")
        ).replace(tzinfo=UTC)
        times = [origin + timedelta(hours=float(h)) for h in np.array(tv[:], dtype=float)]
        data = np.array(v[:], dtype=float) * 1e9  # kg/m³ → µg/m³
    finally:
        f.close()
    data = np.nan_to_num(data, nan=0.0)
    if lat[0] > lat[-1]:
        lat, data = lat[::-1], data[:, ::-1, :]
    ug = np.clip(np.rint(data), 0, 255).astype(np.uint8)
    return Field(
        round(float(lat[0]), 4),
        round(float(lon[0]), 4),
        round(float(lat[1] - lat[0]), 4),
        round(float(lon[1] - lon[0]), 4),
        times,
        ug,
    )


def to_json(fl: Field) -> dict:
    """Frames as base64 bytes, row-major from the south-west corner."""
    nt, ny, nx = fl.ug.shape
    return {
        "lat0": fl.lat0,
        "lon0": fl.lon0,
        "dlat": fl.dlat,
        "dlon": fl.dlon,
        "nx": nx,
        "ny": ny,
        "units": "µg/m³",
        "times": [t.isoformat() for t in fl.times],
        "frames": [base64.b64encode(fl.ug[i].tobytes()).decode() for i in range(nt)],
        "attribution": ATTRIBUTION,
    }


class PmForecast:
    def __init__(self, client: httpx.Client | None = None) -> None:
        self.client = client
        self.field: Field | None = None
        self.updated: datetime | None = None
        self._stop = threading.Event()

    def refresh(self, now: datetime | None = None) -> int:
        now = (now or datetime.now(UTC)).replace(minute=0, second=0, microsecond=0)
        params = {
            "var": "cnc_PM2_5",
            **{k: str(v) for k, v in BOX.items()},
            "time_start": (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "time_end": (now + timedelta(hours=HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "accept": "netcdf",
        }
        client = self.client or httpx.Client(timeout=120.0, headers={"User-Agent": "thai-weather.chakkritton.com"})
        try:
            r = client.get(URL, params=params)
            r.raise_for_status()
            self.field = parse(r.content)
            self.updated = datetime.now(UTC)
            return len(self.field.times)
        finally:
            if client is not self.client:
                client.close()

    def start(self) -> None:
        def loop() -> None:
            while not self._stop.is_set():
                wait = REFRESH_S
                try:
                    n = self.refresh()
                    log.info("silam: PM2.5 forecast, %d hours", n)
                except Exception as exc:  # network, format: keep the last field
                    log.warning("silam refresh failed: %s", exc)
                    wait = RETRY_S
                self._stop.wait(wait)

        threading.Thread(target=loop, name="silam", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
