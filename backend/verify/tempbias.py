"""Fit the stations' temperature bias by hour of day (``python -m verify tempbias``, daily in ``loop``).

For every assimilated station and Bangkok hour: mean of (raw forecast - observation) over the last
``WINDOW_DAYS`` days, from forecasts 24-48 h ahead (the fresh-observation correction has faded by
then), shrunk towards zero by ``SHRINK_N`` pseudo-pairs, smoothed over neighbouring hours and capped.
"Raw" means the correction the run itself applied (runs.temp_bias) is added back, so the fit never
chases its own output.  Hold-out stations are left out so the report keeps an honest score.
Writes ``<data_dir>/calibration/temp_bias.json``; the next forecast runs apply it
(app.downscale.tempbias).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np

from app.downscale import tempbias as tbmod

from . import db, holdout
from .score import _best_obs, _epoch_min

log = logging.getLogger("verify.tempbias")

WINDOW_DAYS = 30
LEADS = (24, 48)
SHRINK_N = 10.0  # pseudo-pairs of "no bias": a station with 10 pairs at an hour gets half its mean
MIN_N = 5  # fewer pairs at an hour: no correction there


def _smooth(values: np.ndarray) -> np.ndarray:
    """Circular 1-2-1 smoothing over the hours: a bias does not jump from one hour to the next."""
    return 0.25 * np.roll(values, 1) + 0.5 * values + 0.25 * np.roll(values, -1)


def fit(conn: sqlite3.Connection, now: datetime | None = None, days: int = WINDOW_DAYS) -> tbmod.TempBias:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=days)
    held = holdout.load(conn)
    applied: dict[str, dict[str, list[float]]] = {}
    for r in conn.execute(
        "SELECT run_id, temp_bias FROM runs WHERE run_time >= ?", (db.fmt_time(since - timedelta(days=3)),)
    ):
        if r["temp_bias"]:
            try:
                applied[r["run_id"]] = json.loads(r["temp_bias"])
            except ValueError:
                pass
    fc = conn.execute(
        "SELECT run_id, station, valid, t2m FROM forecasts WHERE source='fine' AND t2m IS NOT NULL "
        "AND lead_h BETWEEN ? AND ? AND valid >= ? AND valid <= ?",
        (*LEADS, db.fmt_time(since), db.fmt_time(now)),
    ).fetchall()
    obs = _best_obs(
        conn.execute(
            "SELECT station, valid, t2m FROM obs WHERE valid >= ? AND valid <= ?",
            (db.fmt_time(since - timedelta(hours=1)), db.fmt_time(now + timedelta(hours=1))),
        ).fetchall()
    )
    sums: dict[str, np.ndarray] = defaultdict(lambda: np.zeros(24))
    counts: dict[str, np.ndarray] = defaultdict(lambda: np.zeros(24))
    pairs = 0
    for r in fc:
        if r["station"] in held:
            continue
        o = obs.get((r["station"], _epoch_min(r["valid"])))
        if o is None:
            continue
        hour = (int(r["valid"][11:13]) + 7) % 24
        raw = r["t2m"] - (applied.get(r["run_id"], {}).get(r["station"]) or [0.0] * 24)[hour]
        sums[r["station"]][hour] += raw - o
        counts[r["station"]][hour] += 1
        pairs += 1

    info = {r["id"]: r for r in conn.execute("SELECT id, lat, lon, elevation FROM stations")}
    stations = []
    for sid, s in sums.items():
        if sid not in info:
            continue
        n = counts[sid]
        mean = np.where(n >= MIN_N, s / (n + SHRINK_N), 0.0)
        bias = np.clip(_smooth(mean), -tbmod.MAX_ABS, tbmod.MAX_ABS)
        st = info[sid]
        stations.append(
            tbmod.StationBias(
                sid, st["lat"], st["lon"], st["elevation"], [round(float(b), 3) for b in bias], [int(c) for c in n]
            )
        )
    return tbmod.TempBias(now.isoformat(timespec="minutes"), days, pairs, sorted(stations, key=lambda s: s.id))


def refit(
    conn: sqlite3.Connection, data_root: Path, now: datetime | None = None, days: int = WINDOW_DAYS
) -> tbmod.TempBias:
    tb = fit(conn, now, days)
    tbmod.save(data_root, tb)
    rec = tb.record()
    log.info("tempbias: %d pairs, %d stations, mean |bias| %.2f °C", rec["pairs"], rec["stations"], rec["mean_abs"])
    return tb
