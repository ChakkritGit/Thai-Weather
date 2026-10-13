"""Heat-index push alerts from the forecast run's 2.2 km (fine) grid.

``outlook`` is pure (times + values + clock in, peak or None out) so the window, threshold and
data-quality rules are unit-tested without a run on disk.  ``HeatSource`` reads the series for a
saved location from the latest run and applies the stale / expired / outside-domain policy.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import numpy as np

from ..products.scales import weather_scales

WINDOW_H = 3  # look this many hours ahead (plus the current hour)
# The heat layer is stored as 8-bit 0..63.75 °C, NaN encoded as 0: values at either end are not real readings.
VALID_MIN, VALID_MAX = 5.0, 63.5


def _levels() -> list[tuple[float, int, str]]:
    """(threshold °C, tier, level id) of the alerting heat-index levels, highest first (from the design tokens)."""
    out = [
        (float(lvl["min"]), int(lvl["severity"]), lvl["id"])
        for lvl in weather_scales()["categories"]["heatIndex"]["levels"]
        if lvl.get("severity", 0) >= 2 and "min" in lvl
    ]
    return sorted(out, reverse=True)


@dataclass(frozen=True)
class HeatOutlook:
    peak: float  # °C, heat index
    time: datetime  # when the peak is forecast
    tier: int  # 2 = danger (≥ 41 °C), 3 = extreme danger (≥ 54 °C)
    level: str  # "danger" | "extremeDanger"


def outlook(times: list[datetime], values: list[float], now: datetime, window_h: int = WINDOW_H) -> HeatOutlook | None:
    """Peak heat index in the current hour and the next ``window_h`` hours, when it reaches an alert level.

    Returns None when nothing in the window is usable (run expired, no data, implausible values)
    or the peak stays below the danger threshold.
    """
    start, end = now - timedelta(hours=1), now + timedelta(hours=window_h)
    best: tuple[float, datetime] | None = None
    for t, v in zip(times, values, strict=True):
        if not (start < t <= end) or not np.isfinite(v) or not (VALID_MIN <= v <= VALID_MAX):
            continue
        if best is None or v > best[0]:
            best = (float(v), t)
    if best is None:
        return None
    for threshold, tier, level in _levels():
        if best[0] >= threshold:
            return HeatOutlook(round(best[0], 1), best[1], tier, level)
    return None


class HeatSource:
    """Heat-index series at a location from the latest run, or None when the run must not be used."""

    def __init__(self, latest: Callable[[], object | None], max_age: timedelta) -> None:
        self.latest = latest  # RunStore.latest
        self.max_age = max_age

    def usable(self, now: datetime):
        """The latest run when it is fresh enough and still covers ``now``; otherwise None."""
        run = self.latest()
        if run is None:
            return None
        try:
            created = datetime.fromisoformat(run.meta["created"])
        except (KeyError, TypeError, ValueError):
            return None
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        if now - created > self.max_age or not run.times or run.times[-1] < now:
            return None
        return run

    @staticmethod
    def series(run, lat: float, lon: float) -> tuple[list[datetime], list[float]] | None:
        grid = run.fine_grid
        if not grid.contains(lat, lon):
            return None
        iy, ix = grid.index(lat, lon)
        return run.times, run.series("fine", "heat", iy, ix)
