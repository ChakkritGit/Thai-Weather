"""Learned temperature bias, per station and hour of day.

``verify tempbias`` compares a month of archived forecasts (24-48 h ahead, where the fresh-observation
correction of :mod:`.observations` has faded) with the stations' reports and writes, for every
assimilated station, how much too warm (+) or too cold (-) the raw forecast runs at each Bangkok hour,
shrunk towards zero where there are few pairs.  A forecast run subtracts it at every lead time,
spread over the grid with the same distance- and height-aware kernel as the observation correction.

Away from the stations the kernel fades and the raw model's bias would come back, so a regional
background (the stations' biases averaged with a 300 km Gaussian, pulled towards the national mean) fills
in where no station speaks.  It is on only while ``verify tempbias`` finds it beats the stations-only
correction on the hold-out stations over the last 14 days (``background`` / ``background_check``).

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
BG_LENGTH_KM = 300.0  # regional background; 150-500 km scored alike on the hold-out (2026-11-13), 300 best


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
    #: apply the regional background (set by verify's hold-out check)
    background: bool = False
    #: that check: hold-out MAE without and with the background, pairs, test days
    background_check: dict | None = None

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
            "background": self.background,
            "background_check": self.background_check,
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
        check = d.get("background_check")
        return TempBias(
            d.get("fitted_at"),
            int(d.get("window_days", 0)),
            int(d.get("pairs", 0)),
            stations,
            bool(d.get("background", False)),
            check if isinstance(check, dict) else None,
        )
    except (OSError, ValueError, TypeError, KeyError):
        return TempBias()


def save(data_dir: str | Path, tb: TempBias) -> None:
    p = path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(tb), indent=1), encoding="utf-8")
    tmp.replace(p)


def kernel(s: StationBias, grid: Grid, elev: np.ndarray) -> np.ndarray:
    """How much a station speaks for each cell: Gaussian in distance (40 km) and in height (300 m)."""
    lat2 = grid.lats[:, None]
    lon2 = grid.lons[None, :]
    dy = (lat2 - s.lat) * KM_PER_DEG
    dx = (lon2 - s.lon) * KM_PER_DEG * np.cos(np.radians(s.lat))
    z = s.elevation if s.elevation is not None else float(elev[grid.index(s.lat, s.lon)])
    return (np.exp(-(dx**2 + dy**2) / LENGTH_KM**2) * np.exp(-((elev - z) ** 2) / HEIGHT_M**2)).astype(np.float32)


def _axes(s: StationBias, lats: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The background Gaussian splits into a north-south and an east-west factor."""
    gy = np.exp(-(((lats - s.lat) * KM_PER_DEG) ** 2) / BG_LENGTH_KM**2)
    gx = np.exp(-(((lons - s.lon) * KM_PER_DEG * np.cos(np.radians(s.lat))) ** 2) / BG_LENGTH_KM**2)
    return gy, gx


class _Background:
    """Regional bias (forecast minus observation) per Bangkok hour on a lat/lon mesh.

    Each station counts by its Gaussian weight times its pairs at that hour; the national mean joins with
    the weight of one average station, so a sparse corner leans on the whole country."""

    def __init__(self, tb: TempBias, lats: np.ndarray, lons: np.ndarray):
        st = tb.stations
        self.b = np.array([s.bias for s in st], dtype=np.float64)  # (k, 24)
        self.n = np.array([s.n for s in st], dtype=np.float64)
        self.national = (self.b * self.n).sum(0) / np.maximum(self.n.sum(0), 1.0)
        self.prior = self.n.mean(0)
        self.gy = np.stack([_axes(s, lats, lons)[0] for s in st], 1)  # (ny, k)
        self.gx = np.stack([_axes(s, lats, lons)[1] for s in st], 0)  # (k, nx)

    def hour(self, h: int) -> np.ndarray:
        if self.prior[h] <= 0:
            return np.zeros((self.gy.shape[0], self.gx.shape[1]), dtype=np.float32)
        num = self.gy @ (self.gx * (self.n[:, h] * self.b[:, h])[:, None])
        den = self.gy @ (self.gx * self.n[:, h][:, None])
        return ((num + self.prior[h] * self.national[h]) / (den + self.prior[h])).astype(np.float32)


def background(tb: TempBias, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """The regional background on a lat/lon mesh: shape (24, ny, nx), °C."""
    bg = _Background(tb, lats, lons)
    return np.stack([bg.hour(h) for h in range(24)])


def fields(tb: TempBias, grid: Grid, elev: np.ndarray) -> np.ndarray | None:
    """The correction to add, per Bangkok hour: shape (24, ny, nx), °C (minus the spread bias)."""
    inside = [s for s in tb.stations if grid.contains(s.lat, s.lon)]
    if not inside or tb.empty:
        return None
    num = np.zeros((24, *grid.shape), dtype=np.float32)
    den = np.full(grid.shape, SHRINK, dtype=np.float32)
    for s in inside:
        w = kernel(s, grid, elev)
        den += w
        for h in range(24):
            if s.bias[h]:
                num[h] -= w * np.float32(s.bias[h])
    if tb.background:
        # the background takes the SHRINK share of the weight: all of it far from the stations, ~10 % at one
        bg = _Background(TempBias(stations=inside), grid.lats, grid.lons)
        for h in range(24):
            num[h] -= SHRINK * bg.hour(h)
    return num / den


def applied_at_stations(corr: np.ndarray, tb: TempBias, grid: Grid) -> dict[str, list[float]]:
    """What a run added at each fitted station's cell, per hour (verify adds it back when refitting)."""
    out = {}
    for s in tb.stations:
        if grid.contains(s.lat, s.lon):
            iy, ix = grid.index(s.lat, s.lon)
            out[s.id] = [round(float(corr[h, iy, ix]), 3) for h in range(24)]
    return out
