"""PM2.5 forecast over Thailand from FMI's SILAM global air-quality model (0.2°, hourly, ~5 days).

One NetCDF Subset Service request returns the whole Thai box for the next 72 hours (~1 MB), so it costs
nothing against the Open-Meteo quota. Refreshed every 3 hours in the background; the map draws it as a
field under the Air4Thai station dots (measured values). Concentrations come as kg/m³ and are served
as whole µg/m³ in one byte per cell (capped at 255).

A global model at ~22 km misses local emissions both ways (over Bangkok it ran ~3x the stations on
2026-10-17), so the field is adjusted to the stations' latest readings: each station's ratio of measured
to forecast, spread by inverse distance (fading to no correction ~75 km from any station) and blended
back to the raw model with lead time (e-folding 36 h). See `adjust`.
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


R_EARTH_KM = 6371.0
FADE_KM = 75.0  # beyond this from every station the correction fades out
MAX_KM = 200.0
LEAD_EFOLD_H = 36.0
MAX_AGE = timedelta(hours=3)


def _bilinear(fl: Field, t: int, lat: float, lon: float) -> float | None:
    fy, fx = (lat - fl.lat0) / fl.dlat, (lon - fl.lon0) / fl.dlon
    ny, nx = fl.ug.shape[1:]
    if not (0 <= fy <= ny - 1 and 0 <= fx <= nx - 1):
        return None
    y0, x0 = min(int(fy), ny - 2), min(int(fx), nx - 2)
    ty, tx = fy - y0, fx - x0
    a = fl.ug[t].astype(float)
    return float(
        (a[y0, x0] * (1 - tx) + a[y0, x0 + 1] * tx) * (1 - ty)
        + (a[y0 + 1, x0] * (1 - tx) + a[y0 + 1, x0 + 1] * tx) * ty
    )


def adjust(
    fl: Field, stations: list[tuple[float, float, float, datetime]], now: datetime | None = None
) -> tuple[Field, int]:
    """The field corrected to station readings (lat, lon, µg/m³, time); returns it and the stations used."""
    now = now or datetime.now(UTC)
    times = np.array([t.timestamp() for t in fl.times])
    pts = []
    for lat, lon, obs, when in stations:
        if obs < 0 or now - when > MAX_AGE:
            continue
        i = int(np.argmin(np.abs(times - when.timestamp())))
        if abs(times[i] - when.timestamp()) > 5400:
            continue
        f = _bilinear(fl, i, lat, lon)
        if f is None:
            continue
        # +2 keeps clean-air ratios (3 vs 1 µg/m³) from swinging the field
        pts.append((lat, lon, float(np.log(np.clip((obs + 2.0) / (f + 2.0), 0.2, 5.0)))))
    if not pts:
        return fl, 0
    ny, nx = fl.ug.shape[1:]
    glat = np.radians(fl.lat0 + np.arange(ny) * fl.dlat)[:, None, None]
    glon = np.radians(fl.lon0 + np.arange(nx) * fl.dlon)[None, :, None]
    slat = np.radians(np.array([p[0] for p in pts]))[None, None, :]
    slon = np.radians(np.array([p[1] for p in pts]))[None, None, :]
    lr = np.array([p[2] for p in pts])
    # haversine distance from every cell to every station
    h = np.sin((slat - glat) / 2) ** 2 + np.cos(glat) * np.cos(slat) * np.sin((slon - glon) / 2) ** 2
    d = 2 * R_EARTH_KM * np.arcsin(np.sqrt(np.clip(h, 0, 1)))
    w = np.where(d <= MAX_KM, 1.0 / np.maximum(d, 5.0) ** 2, 0.0)
    log_corr = (w * lr).sum(axis=2) / (w.sum(axis=2) + 1.0 / FADE_KM**2)
    obs_time = max(p[3] for p in stations if now - p[3] <= MAX_AGE)
    lead_h = np.array([(t - obs_time).total_seconds() / 3600 for t in fl.times])
    blend = np.exp(-np.clip(lead_h, 0, None) / LEAD_EFOLD_H)[:, None, None]
    out = fl.ug.astype(float) * np.exp(blend * log_corr[None, :, :])
    ug = np.clip(np.rint(out), 0, 255).astype(np.uint8)
    return Field(fl.lat0, fl.lon0, fl.dlat, fl.dlon, fl.times, ug), len(pts)


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
