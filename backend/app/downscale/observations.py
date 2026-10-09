"""Station-observation bias correction (residual analysis).

Global models carry systematic local biases (e.g. too warm in northern
valleys at dawn, too cool over Bangkok at night).  When observations are
available – TMD synoptic/AWS stations, the Hydro-Informatics Institute
network or citizen stations – we compute residuals against the downscaled
first guess and spread them with a distance- and elevation-aware Gaussian
kernel.  The correction decays with lead time as the model's own
evolution takes over.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from ..core.grid import KM_PER_DEG, Grid

LENGTH_KM = 40.0
HEIGHT_M = 300.0
SHRINK = 0.3  # prior weight pulling the correction to zero away from stations
DECAY_H = 12.0
LAPSE = -6.5  # K/km, to move the forecast to the station height


@dataclass
class Observation:
    station_id: str
    lat: float
    lon: float
    time: datetime
    t2m: float
    elevation: float | None = None


def residuals(
    obs: list[Observation], t_fine: np.ndarray, elev: np.ndarray, grid: Grid
) -> list[tuple[Observation, float]]:
    out = []
    for o in obs:
        if not grid.contains(o.lat, o.lon):
            continue
        iy, ix = grid.index(o.lat, o.lon)
        fc = float(t_fine[iy, ix])
        if o.elevation is not None:
            fc += LAPSE * (o.elevation - float(elev[iy, ix])) / 1000.0
        out.append((o, o.t2m - fc))
    return out


def correction_field(res: list[tuple[Observation, float]], elev: np.ndarray, grid: Grid) -> np.ndarray:
    lat2 = grid.lats[:, None]
    lon2 = grid.lons[None, :]
    num = np.zeros(grid.shape, dtype=np.float32)
    den = np.full(grid.shape, SHRINK, dtype=np.float32)
    for o, r in res:
        dy = (lat2 - o.lat) * KM_PER_DEG
        dx = (lon2 - o.lon) * KM_PER_DEG * np.cos(np.radians(o.lat))
        station_z = o.elevation if o.elevation is not None else float(elev[grid.index(o.lat, o.lon)])
        w = np.exp(-(dx**2 + dy**2) / LENGTH_KM**2) * np.exp(-((elev - station_z) ** 2) / HEIGHT_M**2)
        num += w * r
        den += w
    return num / den


def lead_weight(hours: float) -> float:
    return float(np.exp(-max(hours, 0.0) / DECAY_H))
