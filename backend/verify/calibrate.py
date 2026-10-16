"""Refit the chance-of-rain calibration (app/downscale/calibration.py) from the archive.

Pairs every archived ``fine`` forecast hour with whether the station reported rain in that hour
(``(T-1h, T]``, the same convention as forecast rain), over a rolling window. Runs made with a
calibration in place stored its parameters (``runs.pop_a``/``pop_b``), so their values are turned back
into raw ones before fitting: the fit is always raw → observed, never a fit on top of a fit.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np

from app.downscale import calibration

from . import db
from .observe import is_rain

log = logging.getLogger("verify.calibrate")

WINDOW_DAYS = 30
BINS = (0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 101)


def _epoch_min(s: str) -> int:
    return int(db.parse_time(s).timestamp() // 60)


def raw_at(record: dict | None, station: str, valid: str) -> float | None:
    """The raw chance of rain a run recorded at a station for a step ({"t0", "steps": {station: [...]}})."""
    if not record:
        return None
    series = (record.get("steps") or {}).get(station)
    t0 = record.get("t0")
    if not series or not t0:
        return None
    i = round((db.parse_time(valid) - datetime.fromisoformat(t0)).total_seconds() / 3600)
    return float(series[i]) if 0 <= i < len(series) else None


def hourly_pairs(
    conn: sqlite3.Connection, since: datetime, until: datetime | None = None
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(raw pop %, shown pop %, rained 0/1) for each archived fine forecast hour with a known observation."""
    until = until or datetime.now(UTC)
    lo, hi = db.fmt_time(since - timedelta(hours=1)), db.fmt_time(until)
    rained: dict[tuple[str, int], bool] = {}
    for r in conn.execute("SELECT station, valid, wx, rain_1h FROM obs WHERE valid > ? AND valid <= ?", (lo, hi)):
        flag = is_rain(r["wx"], r["rain_1h"])
        if flag is None:
            continue
        m = _epoch_min(r["valid"])
        k = (r["station"], -(-m // 60) * 60)  # the hour ending at or after the report
        rained[k] = rained.get(k, False) or flag
    params, raws = {}, {}
    for r in conn.execute("SELECT run_id, pop_a, pop_b, pop_raw, pop_mlp FROM runs"):
        params[r["run_id"]] = (r["pop_a"], r["pop_b"], bool(r["pop_mlp"]))
        if r["pop_raw"]:
            try:
                raws[r["run_id"]] = json.loads(r["pop_raw"])
            except ValueError:
                pass
    raw, shown, obs = [], [], []
    for r in conn.execute(
        "SELECT run_id, station, valid, pop FROM forecasts WHERE source = 'fine' AND pop IS NOT NULL AND valid > ? AND valid <= ?",
        (db.fmt_time(since), hi),
    ):
        o = rained.get((r["station"], _epoch_min(r["valid"])))
        if o is None:
            continue
        a, b, by_network = params.get(r["run_id"], (None, None, False))
        stored = raw_at(raws.get(r["run_id"]), r["station"], r["valid"])
        if stored is not None:
            raw.append(stored)  # recorded by the run itself
        elif by_network:
            continue  # a network's output cannot be turned back into the raw value
        else:
            cal = (
                calibration.PopCalibration(a=a, b=b)
                if a is not None and b is not None
                else calibration.PopCalibration()
            )
            raw.append(float(cal.invert(np.array([r["pop"]]))[0]))
        shown.append(r["pop"])
        obs.append(1.0 if o else 0.0)
    return np.array(raw), np.array(shown), np.array(obs)


def refit(
    conn: sqlite3.Connection, data_root: Path, now: datetime | None = None, days: int = WINDOW_DAYS
) -> calibration.PopCalibration:
    """Fit on the last ``days`` days and write ``<data_root>/calibration/pop.json`` for the next forecast runs."""
    now = now or datetime.now(UTC)
    raw, _, obs = hourly_pairs(conn, now - timedelta(days=days), now)
    cal = calibration.calibrate(raw, obs, fitted_at=now.isoformat(timespec="minutes"), window_days=days)
    calibration.save(data_root, cal)
    log.info(
        "calibrate: %d hours, %d wet → a=%.3f b=%.3f (Brier raw %s → %s)%s",
        cal.pairs,
        cal.events,
        cal.a,
        cal.b,
        cal.brier_raw,
        cal.brier_cal,
        " [identity: not enough data]" if cal.identity else "",
    )
    return cal


def reliability(shown: np.ndarray, obs: np.ndarray) -> list[tuple[str, int, float, float]]:
    """(forecast band, hours, mean forecast %, observed %) — what a reliability diagram plots."""
    out = []
    for lo, hi in zip(BINS[:-1], BINS[1:], strict=True):
        m = (shown >= lo) & (shown < hi)
        if m.any():
            out.append(
                (
                    f"{lo}–{min(hi, 100) - (0 if hi > 100 else 1)}",
                    int(m.sum()),
                    float(shown[m].mean()),
                    float(obs[m].mean() * 100),
                )
            )
    return out
