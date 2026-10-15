"""Calibration of the chance of rain against what the stations saw.

The ensemble's neighbourhood probability (``pop``) is an *area* chance of >= 0.5 mm/h within a few km,
and the convective texture rains somewhere in most wet grid boxes, so as a chance of rain *at a place*
it ran far too high: on the first verification data, hours forecast at 80-90 % rained 19 % of the time
and the mean forecast was twice the observed frequency (Brier worse than always saying the average).

The fix is a two-parameter logistic recalibration (Platt scaling) fitted on station hours:

    logit(p_cal) = a + b * logit(p_raw)

It keeps the ordering of the forecast (b > 0) and only reshapes it. The fit is pulled towards "no change"
(a = 0, b = 1) by a prior worth ``PRIOR`` observations, so a few days of one weather regime cannot swing it
far; the pull fades as data accumulates. ``verify calibrate`` refits it daily on a rolling window and writes
``<data_dir>/calibration/pop.json``; each forecast run reads that file once and records what it applied.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

EPS = 0.005  # raw probabilities are clipped to [0.5 %, 99.5 %] before the logit
PRIOR = 50.0  # weight of the "no change" prior, in observations (validated on held-out hours)
MIN_PAIRS = 1000  # below this, or with too few wet hours, the calibration is not used
MIN_EVENTS = 50
B_RANGE = (0.05, 2.0)


def _logit(p: np.ndarray) -> np.ndarray:
    q = np.clip(p, EPS, 1 - EPS)
    return np.log(q / (1 - q))


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-z))


@dataclass(frozen=True)
class PopCalibration:
    a: float = 0.0
    b: float = 1.0
    pairs: int = 0
    events: int = 0
    fitted_at: str | None = None
    window_days: int | None = None
    brier_raw: float | None = None
    brier_cal: float | None = None

    @property
    def identity(self) -> bool:
        return self.a == 0.0 and self.b == 1.0

    def apply(self, pop_percent: np.ndarray) -> np.ndarray:
        """Raw chance of rain (%) → calibrated (%). The identity leaves values untouched (0 stays 0)."""
        if self.identity:
            return pop_percent
        out = _sigmoid(self.a + self.b * _logit(np.asarray(pop_percent, dtype=np.float64) / 100.0)) * 100.0
        return out.astype(np.float32) if isinstance(pop_percent, np.ndarray) else out

    def invert(self, pop_percent: np.ndarray) -> np.ndarray:
        """Calibrated (%) → the raw value it came from, so archived forecasts can be refitted."""
        if self.identity:
            return np.asarray(pop_percent, dtype=np.float64)
        z = (_logit(np.asarray(pop_percent, dtype=np.float64) / 100.0) - self.a) / self.b
        return _sigmoid(z) * 100.0

    def record(self) -> dict:
        """What a run stores in its meta (and the API returns), so verification can undo it."""
        return {"a": round(self.a, 4), "b": round(self.b, 4), "pairs": self.pairs, "fitted_at": self.fitted_at}


def fit(raw_percent: np.ndarray, observed: np.ndarray, prior: float = PRIOR) -> tuple[float, float]:
    """MAP logistic regression of rain (0/1) on logit(raw), with a Gaussian prior at (a, b) = (0, 1)."""
    x = _logit(np.asarray(raw_percent, dtype=np.float64) / 100.0)
    y = np.asarray(observed, dtype=np.float64)
    X = np.stack([np.ones_like(x), x], axis=1)
    w = np.array([0.0, 1.0])
    mean = np.array([0.0, 1.0])
    for _ in range(100):
        q = _sigmoid(X @ w)
        grad = X.T @ (q - y) + prior * (w - mean)
        hess = (X.T * (q * (1 - q))) @ X + prior * np.eye(2)
        step = np.linalg.solve(hess, grad)
        w -= step
        if np.max(np.abs(step)) < 1e-9:
            break
    return float(w[0]), float(np.clip(w[1], *B_RANGE))


def calibrate(raw_percent: np.ndarray, observed: np.ndarray, fitted_at: str, window_days: int) -> PopCalibration:
    """A fitted calibration, or the identity when there is not enough data to trust one."""
    raw = np.asarray(raw_percent, dtype=np.float64)
    y = np.asarray(observed, dtype=np.float64)
    n, events = len(y), int(y.sum())
    if n < MIN_PAIRS or events < MIN_EVENTS or events == n:
        return PopCalibration(pairs=n, events=events, fitted_at=fitted_at, window_days=window_days)
    a, b = fit(raw, y)
    cal = PopCalibration(a=a, b=b, pairs=n, events=events, fitted_at=fitted_at, window_days=window_days)
    brier = lambda p: float(np.mean((p / 100.0 - y) ** 2))  # noqa: E731
    return PopCalibration(
        **{**asdict(cal), "brier_raw": round(brier(raw), 5), "brier_cal": round(brier(cal.apply(raw)), 5)}
    )


def path(data_dir: str | Path) -> Path:
    return Path(data_dir) / "calibration" / "pop.json"


def load(data_dir: str | Path) -> PopCalibration:
    """The current calibration; the identity when there is none or it cannot be read."""
    try:
        d = json.loads(path(data_dir).read_text(encoding="utf-8"))
        cal = PopCalibration(**{k: d[k] for k in PopCalibration.__dataclass_fields__ if k in d})
        if not (math.isfinite(cal.a) and B_RANGE[0] <= cal.b <= B_RANGE[1]):
            return PopCalibration()
        return cal
    except (OSError, ValueError, TypeError, KeyError):
        return PopCalibration()


def save(data_dir: str | Path, cal: PopCalibration) -> None:
    p = path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(cal), indent=2), encoding="utf-8")
    tmp.replace(p)
