"""The neural-network chance of rain, once ``verify rainmlp`` has switched it on.

Until then a run applies the two-parameter logistic calibration (:mod:`.calibration`). The network
takes the ensemble's raw chance of rain together with the rain amount, time of day, season, lead,
height and position, and gives the probability that a station reports rain in that hour. It is
applied to every cell, since every input exists everywhere on the grid.

Each run also records the *raw* chance of rain at the verification stations (``stations.json``,
written by verify) for every step, so the archive can always be refitted on raw values: a network
cannot be inverted the way the logistic calibration can.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np

from ..core.grid import Grid

N_FEATURES = 10
EPS = 0.005


def features(
    raw_pop: np.ndarray,
    rain_mm: np.ndarray,
    valid: datetime,
    lead_h: float,
    elev_m: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
) -> np.ndarray:
    """(n, 10): logit of the raw chance, log rain, Bangkok hour and day of year as circles, lead,
    height (km), position. Arrays broadcast; the scalars are per step."""
    p = np.clip(np.asarray(raw_pop, dtype=np.float64) / 100.0, EPS, 1 - EPS)
    hour = ((valid.hour + valid.minute / 60) + 7) % 24
    doy = valid.timetuple().tm_yday
    n = p.size
    cols = [
        np.log(p / (1 - p)).ravel(),
        np.log1p(np.clip(np.asarray(rain_mm, dtype=np.float64), 0, None)).ravel(),
        np.full(n, math.sin(2 * math.pi * hour / 24)),
        np.full(n, math.cos(2 * math.pi * hour / 24)),
        np.full(n, math.sin(2 * math.pi * doy / 365.25)),
        np.full(n, math.cos(2 * math.pi * doy / 365.25)),
        np.full(n, lead_h / 48.0),
        np.broadcast_to(np.asarray(elev_m, dtype=np.float64) / 1000.0, p.shape).ravel(),
        np.broadcast_to(np.asarray(lat, dtype=np.float64), p.shape).ravel(),
        np.broadcast_to(np.asarray(lon, dtype=np.float64), p.shape).ravel(),
    ]
    return np.stack(cols, axis=1)


def path(data_dir: str | Path) -> Path:
    return Path(data_dir) / "calibration" / "rain_mlp.json"


def stations_path(data_dir: str | Path) -> Path:
    return Path(data_dir) / "calibration" / "stations.json"


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
        self.record = {k: d.get(k) for k in ("fitted_at", "pairs", "events", "days", "metrics")}
        if len(self.mean) != N_FEATURES or self.params[0].shape[0] != N_FEATURES:
            raise ValueError("feature count changed")

    def probability(self, x: np.ndarray) -> np.ndarray:
        """Chance of rain, %."""
        h = (x - self.mean) / self.std
        n = len(self.params) // 2
        for i in range(n):
            h = h @ self.params[2 * i] + self.params[2 * i + 1]
            if i < n - 1:
                h = np.tanh(h)
        return 100.0 / (1.0 + np.exp(-np.clip(h[:, 0], -30, 30)))


def load(data_dir: str | Path) -> Model | None:
    """The active network, or None (waiting for data, switched off, or unreadable)."""
    try:
        d = json.loads(path(data_dir).read_text(encoding="utf-8"))
        return Model(d) if d.get("active") and d.get("weights") else None
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return None


def load_stations(data_dir: str | Path) -> list[dict]:
    try:
        rows = json.loads(stations_path(data_dir).read_text(encoding="utf-8"))
        return [
            r
            for r in rows
            if isinstance(r.get("id"), str)
            and isinstance(r.get("lat"), int | float)
            and isinstance(r.get("lon"), int | float)
        ]
    except (OSError, ValueError, AttributeError):
        return []


class Grids:
    """Per-run inputs that do not change between steps: the grid's heights and coordinates."""

    def __init__(self, grid: Grid, elev: np.ndarray) -> None:
        self.elev = elev
        self.lat = np.broadcast_to(grid.lats[:, None], grid.shape)
        self.lon = np.broadcast_to(grid.lons[None, :], grid.shape)

    def apply(self, model: Model, raw_pop: np.ndarray, rain: np.ndarray, valid: datetime, lead_h: float) -> np.ndarray:
        x = features(raw_pop, rain, valid, lead_h, self.elev, self.lat, self.lon)
        return model.probability(x).reshape(raw_pop.shape).astype(np.float32)


class RawAtStations:
    """The raw chance of rain at each verification station, every step (stored in the run's meta)."""

    def __init__(self, stations: list[dict], grid: Grid) -> None:
        self.cells = {s["id"]: grid.index(s["lat"], s["lon"]) for s in stations if grid.contains(s["lat"], s["lon"])}
        self.steps: dict[str, list[float]] = {sid: [] for sid in self.cells}

    def add(self, raw_pop: np.ndarray) -> None:
        for sid, cell in self.cells.items():
            self.steps[sid].append(round(float(raw_pop[cell]), 2))

    def record(self, t0: datetime) -> dict | None:
        return {"t0": t0.isoformat(), "steps": self.steps} if self.cells else None
