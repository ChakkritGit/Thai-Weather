"""Province-level statistics computed from the fine grid.

This is where 2 km resolution pays off for users: a ~25 km global model has 3–4
grid boxes for an average Thai province (and just one for Bangkok or
Phuket), so it cannot say *where* in the province it rains, or what
fraction of the area will be affected.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from .alerts import is_partial, province_alerts
from .scales import categorise

THAI_TZ = timedelta(hours=7)


def _r(x: float, nd: int = 1) -> float:
    return round(float(x), nd)


class ProvinceIndex:
    def __init__(self, province: np.ndarray, provinces: list[dict]) -> None:
        flat = province.ravel().astype(np.int64)
        self.n = len(provinces)
        self.provinces = provinces
        self.counts = np.bincount(flat, minlength=self.n + 1).astype(np.float64)
        order = np.argsort(flat, kind="stable")
        bounds = np.searchsorted(flat[order], np.arange(self.n + 2))
        self.cells = [order[bounds[i] : bounds[i + 1]] for i in range(self.n + 1)]
        self.flat = flat

    def mean(self, values: np.ndarray) -> np.ndarray:
        s = np.bincount(self.flat, weights=values.ravel().astype(np.float64), minlength=self.n + 1)
        return (s / np.maximum(self.counts, 1))[1:]

    def max(self, values: np.ndarray) -> np.ndarray:
        v = values.ravel()
        return np.array([v[c].max() if c.size else np.nan for c in self.cells[1:]])

    def min(self, values: np.ndarray) -> np.ndarray:
        v = values.ravel()
        return np.array([v[c].min() if c.size else np.nan for c in self.cells[1:]])

    def percentile(self, values: np.ndarray, q: float) -> np.ndarray:
        v = values.ravel()
        return np.array([np.percentile(v[c], q) if c.size else np.nan for c in self.cells[1:]])


@dataclass
class DayAccumulator:
    date: str
    shape: tuple[int, int]
    members: int
    hours: int = 0
    since: str = ""  # Thai local HH:MM of the first / last step covered
    until: str = ""
    tmax: np.ndarray = field(init=False)
    tmin: np.ndarray = field(init=False)
    himax: np.ndarray = field(init=False)
    stormmax: np.ndarray = field(init=False)
    windmax: np.ndarray = field(init=False)
    rain_members: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.tmax = np.full(self.shape, -99.0, dtype=np.float32)
        self.tmin = np.full(self.shape, 99.0, dtype=np.float32)
        self.himax = np.full(self.shape, -99.0, dtype=np.float32)
        self.stormmax = np.zeros(self.shape, dtype=np.float32)
        self.windmax = np.zeros(self.shape, dtype=np.float32)
        self.rain_members = np.zeros((self.members, *self.shape), dtype=np.float32)

    def add(self, temp, heat, storm, wind, rain_members, when: datetime | None = None) -> None:
        self.hours += 1
        if when is not None:
            hhmm = thai_hhmm(when)
            self.since = self.since or hhmm
            self.until = hhmm
        np.maximum(self.tmax, temp, out=self.tmax)
        np.minimum(self.tmin, temp, out=self.tmin)
        np.maximum(self.himax, heat, out=self.himax)
        np.maximum(self.stormmax, storm, out=self.stormmax)
        np.maximum(self.windmax, wind, out=self.windmax)
        self.rain_members += rain_members

    @property
    def rain_mean(self) -> np.ndarray:
        return self.rain_members.mean(axis=0)

    def summarise(self, idx: ProvinceIndex) -> list[dict]:
        rain = self.rain_mean
        coverage = np.mean([idx.mean((m >= 1.0).astype(np.float32)) for m in self.rain_members], axis=0) * 100.0
        # typical (median) values drive alerts; extremes describe mountain tops / hot spots
        tmax, tmin = idx.percentile(self.tmax, 50), idx.percentile(self.tmin, 50)
        tmax_hi, tmin_lo = idx.max(self.tmax), idx.min(self.tmin)
        himax = idx.percentile(self.himax, 95)
        rain_mean, rain_p95 = idx.mean(rain), idx.percentile(rain, 95)
        storm, wind = idx.max(self.stormmax), idx.percentile(self.windmax, 95)
        out = []
        for i, _p in enumerate(idx.provinces):
            day = {
                "date": self.date,
                "hours": self.hours,
                "partial": is_partial(self.hours),
                "since": self.since or None,
                "until": self.until or None,
                "tmax": _r(tmax[i]),
                "tmin": _r(tmin[i]),
                "tmax_high": _r(tmax_hi[i]),
                "tmin_low": _r(tmin_lo[i]),
                "heat_max": _r(himax[i]),
                "rain_mean": _r(rain_mean[i]),
                "rain_p95": _r(rain_p95[i]),
                "rain_coverage": _r(coverage[i], 0),
                "storm_max": _r(storm[i], 0),
                "wind_max": _r(wind[i]),
            }
            cov = categorise("rainCoverage", day["rain_coverage"])
            amt = categorise("rainDaily", day["rain_p95"])
            day["rain_coverage_level"] = cov["id"] if cov else None
            day["rain_level"] = amt["id"] if amt else None
            day["alerts"] = province_alerts(day)
            out.append(day)
        return out


def step_stats(idx: ProvinceIndex, temp, heat, pop, rain, storm) -> dict[str, list[float]]:
    return {
        "temp": [_r(x) for x in idx.mean(temp)],
        "heat": [_r(x) for x in idx.percentile(heat, 95)],
        "pop": [_r(x, 0) for x in idx.mean(pop)],
        "rain": [_r(x, 2) for x in idx.mean(rain)],
        "rain_max": [_r(x) for x in idx.max(rain)],
        "storm": [_r(x, 0) for x in idx.max(storm)],
    }


def thai_date(t: datetime) -> str:
    return (t + THAI_TZ).strftime("%Y-%m-%d")


def thai_hhmm(t: datetime) -> str:
    return (t + THAI_TZ).strftime("%H:%M")
