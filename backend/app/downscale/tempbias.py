"""Learned temperature bias, per station and hour of day.

``verify tempbias`` compares a month of archived forecasts (24-48 h ahead, where the fresh-observation
correction of :mod:`.observations` has faded) with the stations' reports and writes, for every
assimilated station, how much too warm (+) or too cold (-) the raw forecast runs at each Bangkok hour,
shrunk towards zero where there are few pairs.  A forecast run subtracts it at every lead time,
spread over the grid with the same distance- and height-aware kernel as the observation correction.

The hold-out stations are never fitted, so the verification report keeps scoring the forecast where
it learned nothing.  Each run records the correction it applied at the stations (meta
``temp_bias.applied``), so the next fit can add it back and always learns the raw model's bias
instead of chasing its own correction.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np

from ..core.grid import KM_PER_DEG, Grid

LENGTH_KM = 40.0
HEIGHT_M = 300.0
SHRINK = 0.1  # the bias is already shrunk by its sample size: keep ~90 % of it at the station itself
MAX_ABS = 5.0  # °C; anything larger is a broken station or a broken fit, not a bias


@dataclass
class StationBias:
    id: str
    lat: float
    lon: float
    elevation: float | None
    #: forecast minus observation by Bangkok hour 0-23, °C (positive: the forecast runs warm)
    bias: list[float]
    n: list[int]


@dataclass
class TempBias:
    fitted_at: str | None = None
    window_days: int = 0
    pairs: int = 0
    stations: list[StationBias] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not any(any(abs(b) > 0.05 for b in s.bias) for s in self.stations)

    def record(self) -> dict:
        """The summary a forecast run stores in its meta."""
        flat = [abs(b) for s in self.stations for b in s.bias]
        return {
            "fitted_at": self.fitted_at,
            "window_days": self.window_days,
            "pairs": self.pairs,
            "stations": len(self.stations),
            "mean_abs": round(float(np.mean(flat)), 2) if flat else 0.0,
        }


def bkk_hour(t: datetime) -> int:
    return (t.utctimetuple().tm_hour + 7) % 24


def path(data_dir: str | Path) -> Path:
    return Path(data_dir) / "calibration" / "temp_bias.json"


def load(data_dir: str | Path) -> TempBias:
    """The current fit; empty (no correction) when there is none or it cannot be read."""
    try:
        d = json.loads(path(data_dir).read_text(encoding="utf-8"))
        stations = []
        for s in d.get("stations", []):
            bias = [float(b) for b in s["bias"]]
            if len(bias) != 24 or not all(math.isfinite(b) and abs(b) <= MAX_ABS for b in bias):
                continue
            stations.append(
                StationBias(
                    s["id"], float(s["lat"]), float(s["lon"]), s.get("elevation"), bias, [int(n) for n in s["n"]]
                )
            )
        return TempBias(d.get("fitted_at"), int(d.get("window_days", 0)), int(d.get("pairs", 0)), stations)
    except (OSError, ValueError, TypeError, KeyError):
        return TempBias()


def save(data_dir: str | Path, tb: TempBias) -> None:
    p = path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(tb), indent=1), encoding="utf-8")
    tmp.replace(p)


def fields(tb: TempBias, grid: Grid, elev: np.ndarray) -> np.ndarray | None:
    """The correction to add, per Bangkok hour: shape (24, ny, nx), °C (minus the spread bias)."""
    inside = [s for s in tb.stations if grid.contains(s.lat, s.lon)]
    if not inside or tb.empty:
        return None
    lat2 = grid.lats[:, None]
    lon2 = grid.lons[None, :]
    num = np.zeros((24, *grid.shape), dtype=np.float32)
    den = np.full(grid.shape, SHRINK, dtype=np.float32)
    for s in inside:
        dy = (lat2 - s.lat) * KM_PER_DEG
        dx = (lon2 - s.lon) * KM_PER_DEG * np.cos(np.radians(s.lat))
        z = s.elevation if s.elevation is not None else float(elev[grid.index(s.lat, s.lon)])
        w = (np.exp(-(dx**2 + dy**2) / LENGTH_KM**2) * np.exp(-((elev - z) ** 2) / HEIGHT_M**2)).astype(np.float32)
        den += w
        for h in range(24):
            if s.bias[h]:
                num[h] -= w * np.float32(s.bias[h])
    return num / den


def applied_at_stations(corr: np.ndarray, tb: TempBias, grid: Grid) -> dict[str, list[float]]:
    """What a run added at each fitted station's cell, per hour (verify adds it back when refitting)."""
    out = {}
    for s in tb.stations:
        if grid.contains(s.lat, s.lon):
            iy, ix = grid.index(s.lat, s.lon)
            out[s.id] = [round(float(corr[h, iy, ix]), 3) for h in range(24)]
    return out
