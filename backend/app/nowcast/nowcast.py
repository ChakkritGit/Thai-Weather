"""Point nowcast: will rain / thunderstorm reach this location within the hour, and when?

The latest radar frame is advected with the motion field using a semi-Lagrangian
back-trajectory: for each lead time the point is traced *backwards* through the flow, and the
echo found there (max dBZ within ``RADIUS_KM``) is what will be over the point at that lead.
Running the trace with the speed scaled by 0.8 and 1.25 gives the ETA range.  There is no
growth/decay: skill drops after roughly 30-60 minutes (documented in docs/NOWCAST.md).
"""

from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from ..core.grid import KM_PER_DEG, Grid

RADIUS_KM = 4.0  # "rain here": an echo within this distance of the point (owner's rule, 2026-10)
STEP_MIN = 5
HORIZON_MIN = 60
SPELL_HORIZON_MIN = 120  # how long the rain lasts is traced further than the arrival (lower skill)
RAIN_DBZ = 20.0
STORM_DBZ = 45.0
NEAREST_DBZ = 40.0
NEAREST_RANGE_KM = 100.0
MOVING_KMH = 2.0  # slower than this, a cell counts as stationary
CLOSING_KMH = 1.0  # the motion component toward / away from the point that counts as "toward" / "away"
PASS_KM = 8.0  # a cell whose track misses the point by more than this only passes by
SPEED_SCALES = (0.8, 1.25)  # slower / faster than the estimated motion → ETA range
PEAK_WINDOW_MIN = 20  # the reported class is the peak intensity within this time after arrival

CLASSES = ((55.0, "severe"), (45.0, "thunderstorm"), (40.0, "heavy"), (30.0, "moderate"), (20.0, "light"))


def classify(dbz: float | None) -> str:
    """Radar-based rain class from reflectivity (dBZ)."""
    if dbz is None or not math.isfinite(dbz):
        return "none"
    for floor, name in CLASSES:
        if dbz >= floor:
            return name
    return "none"


def _sample(field: np.ndarray, grid: Grid, lat: float, lon: float) -> float:
    """Bilinear sample of a grid field (clamped to the domain)."""
    fy, fx = grid.fractional_index(np.asarray(lat), np.asarray(lon))
    fy = float(np.clip(fy, 0, grid.ny - 1))
    fx = float(np.clip(fx, 0, grid.nx - 1))
    y0, x0 = min(int(fy), grid.ny - 2), min(int(fx), grid.nx - 2)
    wy, wx = fy - y0, fx - x0
    blk = field[y0 : y0 + 2, x0 : x0 + 2]
    return float(
        blk[0, 0] * (1 - wy) * (1 - wx) + blk[0, 1] * (1 - wy) * wx + blk[1, 0] * wy * (1 - wx) + blk[1, 1] * wy * wx
    )


def _local_max(dbz: np.ndarray, grid: Grid, lat: float, lon: float, radius_km: float = RADIUS_KM) -> float:
    """Max dBZ within ``radius_km`` of a coordinate; NaN when nothing (or outside the domain)."""
    if not grid.contains(lat, lon):
        return float("nan")
    iy, ix = grid.index(lat, lon)
    dy_km = grid.dlat * KM_PER_DEG
    dx_km = grid.dlon * KM_PER_DEG * math.cos(math.radians(lat))
    ry, rx = int(math.ceil(radius_km / dy_km)) + 1, int(math.ceil(radius_km / dx_km)) + 1
    y0, y1 = max(iy - ry, 0), min(iy + ry + 1, grid.ny)
    x0, x1 = max(ix - rx, 0), min(ix + rx + 1, grid.nx)
    ky = (grid.lats[y0:y1, None] - lat) * KM_PER_DEG
    kx = (grid.lons[None, x0:x1] - lon) * KM_PER_DEG * math.cos(math.radians(lat))
    window = np.where(np.hypot(ky, kx) <= radius_km, dbz[y0:y1, x0:x1], np.nan)
    return float(np.nanmax(window)) if np.isfinite(window).any() else float("nan")


def _trace(
    u: np.ndarray, v: np.ndarray, grid: Grid, lat: float, lon: float, scale: float, horizon: int = HORIZON_MIN
) -> list[tuple[float, float]]:
    """Positions the air over (lat, lon) came from, for leads 0, 5, ... ``horizon`` min."""
    pts = [(lat, lon)]
    dt_h = STEP_MIN / 60.0
    for _ in range(horizon // STEP_MIN):
        la, lo = pts[-1]
        uu, vv = _sample(u, grid, la, lo) * scale, _sample(v, grid, la, lo) * scale
        pts.append((la - vv * dt_h / KM_PER_DEG, lo - uu * dt_h / (KM_PER_DEG * math.cos(math.radians(la)))))
    return pts


def _lead_series(
    dbz: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    grid: Grid,
    lat: float,
    lon: float,
    scale: float,
    horizon: int = HORIZON_MIN,
) -> list[float]:
    return [_local_max(dbz, grid, la, lo) for la, lo in _trace(u, v, grid, lat, lon, scale, horizon)]


def _spell(series: list[float]) -> dict | None:
    """The coming (or current) spell of rain over the point along a 0-120 min trace.

    ``start_min`` 0 = raining now; ``end_min`` / ``lasts_min`` None = still raining at the end of the
    trace (``open_ended``). None when no rain reaches the point within the trace.
    """
    start = _first_at_least(series, RAIN_DBZ)
    if start is None:
        return None
    end = next((k for k in range(start, len(series)) if not (np.isfinite(series[k]) and series[k] >= RAIN_DBZ)), None)
    horizon = (len(series) - 1) * STEP_MIN
    return {
        "start_min": start * STEP_MIN,
        "end_min": None if end is None else end * STEP_MIN,
        "lasts_min": None if end is None else (end - start) * STEP_MIN,
        "open_ended": end is None,
        "horizon_min": horizon,
    }


def _first_at_least(series: list[float], threshold: float) -> int | None:
    for k, value in enumerate(series):
        if np.isfinite(value) and value >= threshold:
            return k
    return None


def _eta(series: dict[float, list[float]], threshold: float) -> dict | None:
    nominal = series[1.0]
    k = _first_at_least(nominal, threshold)
    if k is None:
        return None
    slow, fast = (_first_at_least(series[s], threshold) for s in SPEED_SCALES)
    lo = min(k, fast if fast is not None else k)
    hi = max(k, slow if slow is not None else HORIZON_MIN // STEP_MIN)
    window = [x for x in nominal[k : k + PEAK_WINDOW_MIN // STEP_MIN + 1] if np.isfinite(x)]
    peak = max(window)
    return {
        "minutes": k * STEP_MIN,
        "minutes_range": [lo * STEP_MIN, hi * STEP_MIN],
        "class": classify(peak),
        "max_dbz": round(peak, 1),
    }


def _bearing(lat: float, lon: float, lat2: float, lon2: float) -> float:
    dy = lat2 - lat
    dx = (lon2 - lon) * math.cos(math.radians((lat + lat2) / 2))
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def _nearest_cell(dbz: np.ndarray, u: np.ndarray, v: np.ndarray, grid: Grid, lat: float, lon: float) -> dict | None:
    iy, ix = grid.index(lat, lon)
    dy_km = grid.dlat * KM_PER_DEG
    dx_km = grid.dlon * KM_PER_DEG * math.cos(math.radians(lat))
    ry, rx = int(NEAREST_RANGE_KM / dy_km) + 1, int(NEAREST_RANGE_KM / dx_km) + 1
    y0, y1 = max(iy - ry, 0), min(iy + ry + 1, grid.ny)
    x0, x1 = max(ix - rx, 0), min(ix + rx + 1, grid.nx)
    ky = (grid.lats[y0:y1, None] - lat) * KM_PER_DEG
    kx = (grid.lons[None, x0:x1] - lon) * KM_PER_DEG * math.cos(math.radians(lat))
    dist = np.hypot(ky, kx)
    sub = dbz[y0:y1, x0:x1]
    hit = np.isfinite(sub) & (sub >= NEAREST_DBZ) & (dist <= NEAREST_RANGE_KM)
    if not hit.any():
        return None
    cand = np.where(hit, dist, np.inf)
    j = np.unravel_index(int(np.argmin(cand)), cand.shape)
    cy, cx = y0 + int(j[0]), x0 + int(j[1])
    clat, clon = float(grid.lats[cy]), float(grid.lons[cx])
    d = float(dist[j])
    peak = _local_max(dbz, grid, clat, clon)
    cu, cv = float(u[cy, cx]), float(v[cy, cx])
    track = _track(-float(kx[0, j[1]]), -float(ky[j[0], 0]), cu, cv)
    closing = (cu * -float(kx[0, j[1]]) + cv * -float(ky[j[0], 0])) / d if d > 0.5 else 0.0
    return {
        "distance_km": round(d, 1),
        "bearing_deg": round(_bearing(lat, lon, clat, clon)),
        "class": classify(peak),
        "max_dbz": round(peak, 1),
        "approaching": track == "toward",
        "closing_kmh": round(closing, 1),
        "track": track,
    }


def _track(dx: float, dy: float, u: float, v: float) -> str:
    """Where a cell at offset (-dx, -dy) km from the point is going, given its motion (u, v) km/h.

    (dx, dy) points from the cell to the point. "toward" = closing and its track passes within
    ``PASS_KM`` of the point (a slow cell drifting across counts, not only one aimed straight at it);
    "passing" = its track misses by more, or it moves across; "away"; "stationary".
    """
    speed = math.hypot(u, v)
    if speed < MOVING_KMH:
        return "stationary"
    d = math.hypot(dx, dy)
    if d <= 0.5:
        return "toward"  # already over the point
    closing = (u * dx + v * dy) / d
    if closing < -CLOSING_KMH:
        return "away"
    if closing <= CLOSING_KMH:
        return "passing"
    miss = abs(u * dy - v * dx) / speed  # distance from the point to the cell's straight track
    return "toward" if miss <= PASS_KM else "passing"


def point_nowcast(
    latest: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    grid: Grid,
    lat: float,
    lon: float,
    coverage: np.ndarray | None = None,
) -> dict:
    """Nowcast for one location from the latest dBZ frame and the motion field (u, v in km/h).

    Cells outside radar ``coverage`` are ignored.  Returns ``now`` (an echo within ``RADIUS_KM``),
    ``eta_rain`` (>= 20 dBZ), ``eta_storm`` (>= 45 dBZ), ``nearest`` (closest cell >= 40 dBZ within
    100 km, with its ``track``: toward / passing / away / stationary), ``rain_spell`` (when the rain over the point starts and stops, traced 120 min) and ``motion``.
    ETAs are ``{"minutes", "minutes_range", "class", "max_dbz"}`` (0 = already happening) or None.
    """
    dbz = latest if coverage is None else np.where(coverage, latest, np.nan)
    series = {s: _lead_series(dbz, u, v, grid, lat, lon, s) for s in (1.0, *SPEED_SCALES)}
    long_trace = _lead_series(dbz, u, v, grid, lat, lon, 1.0, SPELL_HORIZON_MIN)
    now_max = series[1.0][0]
    uu, vv = _sample(u, grid, lat, lon), _sample(v, grid, lat, lon)
    speed = math.hypot(uu, vv)
    return {
        "now": {"class": classify(now_max), "max_dbz": None if not np.isfinite(now_max) else round(now_max, 1)},
        "eta_rain": _eta(series, RAIN_DBZ),
        "eta_storm": _eta(series, STORM_DBZ),
        "nearest": _nearest_cell(dbz, u, v, grid, lat, lon),
        "rain_spell": _spell(long_trace),
        "motion": {
            "speed_kmh": round(speed, 1),
            "heading_deg": round((math.degrees(math.atan2(uu, vv)) + 360.0) % 360.0) if speed >= 1.0 else None,
        },
    }


def advect(dbz: np.ndarray, u: np.ndarray, v: np.ndarray, grid: Grid, minutes: float) -> np.ndarray:
    """The frame moved ``minutes`` along the motion field (semi-Lagrangian, nearest neighbour).

    Nearest-neighbour sampling keeps intensities intact (no smearing of cell cores).  NaN stays
    NaN; echo advected in from outside the domain is unknown and therefore also NaN.
    """
    if minutes <= 0:
        return dbz.copy()
    yy, xx = np.meshgrid(np.arange(grid.ny, dtype=np.float32), np.arange(grid.nx, dtype=np.float32), indexing="ij")
    dy_km = grid.dlat * KM_PER_DEG
    dx_km = (grid.dlon * KM_PER_DEG * np.cos(np.radians(grid.lats)))[:, None].astype(np.float32)
    n = max(1, round(minutes / STEP_MIN))
    dt_h = minutes / 60.0 / n
    for _ in range(n):
        un = ndimage.map_coordinates(u, [yy, xx], order=1, mode="nearest")
        vn = ndimage.map_coordinates(v, [yy, xx], order=1, mode="nearest")
        yy = yy - vn * dt_h / dy_km
        xx = xx - un * dt_h / dx_km
    out = ndimage.map_coordinates(np.nan_to_num(dbz, nan=-99.0), [yy, xx], order=0, mode="constant", cval=-99.0)
    return np.where(out <= -99.0, np.nan, out).astype(np.float32)
