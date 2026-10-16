"""The neural-network temperature correction, once ``verify mlp`` has switched it on.

``verify`` trains a small MLP by backpropagation on the archived forecasts and the stations' reports
(see :mod:`verify.mlp`) and writes ``calibration/temp_mlp.json``; with ``active: true`` a forecast
run uses it instead of the per-station, per-hour bias of :mod:`.tempbias`. At every step it predicts,
for each trained station, how far the raw forecast is off there, and spreads that over the grid with
the same distance- and height-aware kernel. The features are shared with the trainer, so both sides
always build them the same way.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np

from ..core.grid import Grid
from . import tempbias as tbmod

N_FEATURES = 11
MAX_ABS = 5.0  # °C


def features(
    raw: float,
    gfs: float,
    valid: datetime,
    lead_h: float,
    lat: float,
    lon: float,
    elevation: float,
    model_elevation: float,
) -> list[float]:
    """One sample: raw 2.2 km temperature, its gap to raw GFS, Bangkok hour and day of year as
    circles, lead, station height and the model's height error (km), position."""
    hour = ((valid.hour + valid.minute / 60) + 7) % 24
    doy = valid.timetuple().tm_yday
    return [
        raw,
        gfs - raw,
        math.sin(2 * math.pi * hour / 24),
        math.cos(2 * math.pi * hour / 24),
        math.sin(2 * math.pi * doy / 365.25),
        math.cos(2 * math.pi * doy / 365.25),
        lead_h / 48.0,
        elevation / 1000.0,
        (model_elevation - elevation) / 1000.0,
        lat,
        lon,
    ]


def path(data_dir: str | Path) -> Path:
    return Path(data_dir) / "calibration" / "temp_mlp.json"


def save(data_dir: str | Path, model: dict) -> None:
    p = path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(model), encoding="utf-8")
    tmp.replace(p)


class Model:
    def __init__(self, d: dict) -> None:
        self.params = [np.asarray(w, dtype=np.float64) for w in d["weights"]]
        self.mean = np.asarray(d["mean"], dtype=np.float64)
        self.std = np.asarray(d["std"], dtype=np.float64)
        self.stations = d["stations"]
        self.record = {k: d.get(k) for k in ("fitted_at", "pairs", "days", "metrics")}
        if len(self.mean) != N_FEATURES or self.params[0].shape[0] != N_FEATURES:
            raise ValueError("feature count changed")

    def predict(self, x: np.ndarray) -> np.ndarray:
        h = (x - self.mean) / self.std
        n = len(self.params) // 2
        for i in range(n):
            h = h @ self.params[2 * i] + self.params[2 * i + 1]
            if i < n - 1:
                h = np.tanh(h)
        return np.clip(h[:, 0], -MAX_ABS, MAX_ABS)


def load(data_dir: str | Path) -> Model | None:
    """The active model, or None (not trained yet, switched off, or unreadable)."""
    try:
        d = json.loads(path(data_dir).read_text(encoding="utf-8"))
        return Model(d) if d.get("active") and d.get("weights") else None
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return None


class Applier:
    """Per-run state: station cells and kernel weights, computed once; corrections per step."""

    def __init__(self, model: Model, grid: Grid, coarse_grid: Grid, elev: np.ndarray) -> None:
        self.model = model
        self.grid = grid
        self.coarse_grid = coarse_grid
        self.stations = [s for s in model.stations if grid.contains(s["lat"], s["lon"])]
        self.cells = [grid.index(s["lat"], s["lon"]) for s in self.stations]
        self.coarse_cells = [coarse_grid.index(s["lat"], s["lon"]) for s in self.stations]
        biases = [
            tbmod.StationBias(s["id"], s["lat"], s["lon"], s["elevation"], [0.0] * 24, [0] * 24) for s in self.stations
        ]
        self.weights = [tbmod.kernel(b, grid, elev) for b in biases]
        self.den = np.full(grid.shape, tbmod.SHRINK, dtype=np.float32)
        for w in self.weights:
            self.den += w
        self.applied: dict[str, list[float]] = {s["id"]: [] for s in self.stations}

    def field(self, temp: np.ndarray, coarse_t2m: np.ndarray, valid: datetime, lead_h: float) -> np.ndarray | None:
        if not self.stations:
            return None
        x = np.array(
            [
                features(
                    float(temp[c]),
                    float(coarse_t2m[cc]),
                    valid,
                    lead_h,
                    s["lat"],
                    s["lon"],
                    s["elevation"],
                    s["model_elevation"],
                )
                for s, c, cc in zip(self.stations, self.cells, self.coarse_cells, strict=True)
            ]
        )
        corr = self.model.predict(x)
        num = np.zeros(self.grid.shape, dtype=np.float32)
        for w, c in zip(self.weights, corr, strict=True):
            num += w * np.float32(c)
        out = num / self.den
        for s, cell in zip(self.stations, self.cells, strict=True):
            self.applied[s["id"]].append(round(float(out[cell]), 3))
        return out

    def record(self, t0: datetime) -> dict:
        return {
            "kind": "mlp",
            **self.model.record,
            "stations": len(self.stations),
            "applied": {"t0": t0.isoformat(), "steps": self.applied},
        }
