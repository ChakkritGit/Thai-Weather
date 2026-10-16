"""A small neural network for the temperature correction, trained by backpropagation (``loop``, daily).

It waits for enough history and then switches itself on, but only while it beats what runs today:
the per-station, per-hour bias (:mod:`verify.tempbias`). Each day it

1. builds one sample per (run, station, valid time) with a forecast 24-48 h ahead and a report:
   the raw 2.2 km temperature (any learned correction the run applied is added back), the gap to raw
   GFS, Bangkok hour and day of year as circles, lead, the station's height and the model's height
   error, latitude and longitude. The target is observation minus raw forecast.
2. while the history is shorter than ``MIN_DAYS`` or has fewer than ``MIN_PAIRS`` samples, writes
   only its status ("waiting for data") and stops.
3. otherwise holds out the last ``TEST_DAYS`` days, trains a 2-layer tanh MLP (Adam, L2, early
   stopping on the latest 15 % of the training days) and the hourly bias on the same days, and
   compares the MAE on the held-out days. It is switched on only if it beats both the raw forecast
   and the hourly bias by ``MIN_GAIN`` °C and ``MIN_GAIN_REL``. The weights are then refitted on all
   days (same epoch count) and written with ``active: true``; a later failed check switches it off.

Hold-out stations (verify.holdout) are never trained on, as for the other fits.
Writes ``<data_dir>/calibration/temp_mlp.json``; :mod:`app.downscale.tempmlp` applies an active one.
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from app.downscale import tempmlp

from . import db, holdout
from .score import _best_obs, _epoch_min
from .tempbias import LEADS, applied_correction, load_applied

log = logging.getLogger("verify.mlp")

MIN_DAYS = 90
MIN_PAIRS = 20_000
TEST_DAYS = 14
MIN_GAIN = 0.05  # °C of MAE on the held-out days
MIN_GAIN_REL = 0.03
HIDDEN = (24, 12)
L2 = 1e-3
LR = 1e-3
BATCH = 256
MAX_EPOCHS = 300
PATIENCE = 20
SEED = 7


@dataclass
class Samples:
    x: np.ndarray  # (n, features), not normalised
    y: np.ndarray  # observation - raw forecast
    station: np.ndarray  # station id per sample
    hour: np.ndarray  # Bangkok hour
    valid_day: np.ndarray  # days since epoch (for the time split)


def build(conn: sqlite3.Connection, now: datetime | None = None) -> tuple[Samples, dict[str, dict]]:
    now = now or datetime.now(UTC)
    held = holdout.load(conn)
    applied = load_applied(conn, None)
    info = {r["id"]: dict(r) for r in conn.execute("SELECT id, lat, lon, elevation FROM stations")}
    for sid in info:
        e = db.get_meta(conn, f"elev:{sid}")
        info[sid]["model_elevation"] = float(e.split(",")[1]) if e and "," in e else None
    gfs = {
        (r["run_id"], r["station"], r["valid"]): r["t2m"]
        for r in conn.execute(
            "SELECT run_id, station, valid, t2m FROM forecasts WHERE source='gfs_raw' AND t2m IS NOT NULL AND lead_h BETWEEN ? AND ?",
            LEADS,
        )
    }
    obs = _best_obs(
        conn.execute("SELECT station, valid, t2m FROM obs WHERE valid <= ?", (db.fmt_time(now),)).fetchall()
    )
    runs = {r["run_id"]: r["run_time"] for r in conn.execute("SELECT run_id, run_time FROM runs")}
    xs, ys, st, hrs, days = [], [], [], [], []
    for r in conn.execute(
        "SELECT run_id, station, valid, lead_h, t2m FROM forecasts WHERE source='fine' AND t2m IS NOT NULL "
        "AND lead_h BETWEEN ? AND ? AND valid <= ?",
        (*LEADS, db.fmt_time(now)),
    ):
        sid = r["station"]
        if sid in held or sid not in info or info[sid]["model_elevation"] is None or info[sid]["elevation"] is None:
            continue
        o = obs.get((sid, _epoch_min(r["valid"])))
        g = gfs.get((r["run_id"], sid, r["valid"]))
        if o is None or g is None:
            continue
        valid = db.parse_time(r["valid"])
        raw = r["t2m"] - applied_correction(applied.get(r["run_id"]), sid, valid, runs.get(r["run_id"]))
        s = info[sid]
        xs.append(
            tempmlp.features(raw, g, valid, r["lead_h"], s["lat"], s["lon"], s["elevation"], s["model_elevation"])
        )
        ys.append(o - raw)
        st.append(sid)
        hrs.append((valid.hour + 7) % 24)
        days.append(int(valid.timestamp() // 86400))
    samples = Samples(
        np.asarray(xs, dtype=np.float64).reshape(-1, tempmlp.N_FEATURES),
        np.asarray(ys, dtype=np.float64),
        np.asarray(st),
        np.asarray(hrs, dtype=np.int64),
        np.asarray(days, dtype=np.int64),
    )
    return samples, info


# ------------------------------------------------------------------ network
def _init(n_in: int, rng: np.random.Generator) -> list[np.ndarray]:
    sizes = [n_in, *HIDDEN, 1]
    params = []
    for a, b in zip(sizes[:-1], sizes[1:], strict=True):
        params += [rng.normal(0, 1 / math.sqrt(a), (a, b)), np.zeros(b)]
    return params


def _forward(params: list[np.ndarray], x: np.ndarray) -> tuple[np.ndarray, list[np.ndarray]]:
    acts = [x]
    h = x
    n = len(params) // 2
    for i in range(n):
        z = h @ params[2 * i] + params[2 * i + 1]
        h = np.tanh(z) if i < n - 1 else z
        acts.append(h)
    return h[:, 0], acts


def _grads(params: list[np.ndarray], x: np.ndarray, y: np.ndarray) -> list[np.ndarray]:
    """Backpropagation of the mean squared error plus the L2 penalty."""
    pred, acts = _forward(params, x)
    delta = (2.0 / len(y)) * (pred - y)[:, None]
    grads: list[np.ndarray] = [np.zeros(0)] * len(params)
    n = len(params) // 2
    for i in reversed(range(n)):
        w = params[2 * i]
        grads[2 * i] = acts[i].T @ delta + 2 * L2 * w
        grads[2 * i + 1] = delta.sum(axis=0)
        if i:
            delta = (delta @ w.T) * (1 - acts[i] ** 2)
    return grads


def train(x: np.ndarray, y: np.ndarray, epochs: int | None = None, val: tuple[np.ndarray, np.ndarray] | None = None):
    """Adam on minibatches. With ``val``: early stopping, returns (params, best epoch count)."""
    rng = np.random.default_rng(SEED)
    params = _init(x.shape[1], rng)
    m = [np.zeros_like(p) for p in params]
    v = [np.zeros_like(p) for p in params]
    t = 0
    best, best_params, best_epoch, waited = math.inf, [p.copy() for p in params], 0, 0
    for epoch in range(1, (epochs or MAX_EPOCHS) + 1):
        order = rng.permutation(len(y))
        for s in range(0, len(y), BATCH):
            idx = order[s : s + BATCH]
            g = _grads(params, x[idx], y[idx])
            t += 1
            for k, p in enumerate(params):
                m[k] = 0.9 * m[k] + 0.1 * g[k]
                v[k] = 0.999 * v[k] + 0.001 * g[k] ** 2
                p -= LR * (m[k] / (1 - 0.9**t)) / (np.sqrt(v[k] / (1 - 0.999**t)) + 1e-8)
        if val is not None:
            loss = float(np.mean(np.abs(_forward(params, val[0])[0] - val[1])))
            if loss < best - 1e-4:
                best, best_params, best_epoch, waited = loss, [p.copy() for p in params], epoch, 0
            else:
                waited += 1
                if waited >= PATIENCE:
                    break
    return (best_params, best_epoch) if val is not None else (params, epochs or MAX_EPOCHS)


def _hourly_bias(train: Samples) -> dict[tuple[str, int], float]:
    """The method in use today, fitted on the same samples: shrunk mean of forecast - obs by hour."""
    sums: dict[tuple[str, int], list[float]] = defaultdict(lambda: [0.0, 0])
    for sid, h, err in zip(train.station, train.hour, -train.y, strict=True):
        sums[(sid, h)][0] += err
        sums[(sid, h)][1] += 1
    return {k: s / (n + 10.0) for k, (s, n) in sums.items() if n >= 5}


def _subset(s: Samples, mask: np.ndarray) -> Samples:
    return Samples(s.x[mask], s.y[mask], s.station[mask], s.hour[mask], s.valid_day[mask])


# -------------------------------------------------------------------- fit
def refit(conn: sqlite3.Connection, data_root: Path, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    samples, info = build(conn, now)
    n = len(samples.y)
    days = int(samples.valid_day.max() - samples.valid_day.min() + 1) if n else 0
    status = {
        "fitted_at": now.isoformat(timespec="minutes"),
        "active": False,
        "pairs": n,
        "days": days,
        "required_pairs": MIN_PAIRS,
        "required_days": MIN_DAYS,
        "test_days": TEST_DAYS,
        "metrics": None,
    }
    if n < MIN_PAIRS or days < MIN_DAYS:
        status["reason"] = "waiting for data"
        tempmlp.save(data_root, status)
        log.info("mlp: waiting for data (%d/%d pairs, %d/%d days)", n, MIN_PAIRS, days, MIN_DAYS)
        return status

    cut = samples.valid_day.max() - TEST_DAYS + 1
    train_s, test_s = _subset(samples, samples.valid_day < cut), _subset(samples, samples.valid_day >= cut)
    mean, std = train_s.x.mean(axis=0), train_s.x.std(axis=0) + 1e-6
    norm = lambda a: (a - mean) / std  # noqa: E731
    val_cut = np.quantile(train_s.valid_day, 0.85)
    fit_m, val_m = train_s.valid_day < val_cut, train_s.valid_day >= val_cut
    params, epochs = train(norm(train_s.x[fit_m]), train_s.y[fit_m], val=(norm(train_s.x[val_m]), train_s.y[val_m]))
    params, _ = train(norm(train_s.x), train_s.y, epochs=max(epochs, 5))

    bias = _hourly_bias(train_s)
    mae_raw = float(np.mean(np.abs(test_s.y)))
    hourly_pred = np.array([-bias.get((s, h), 0.0) for s, h in zip(test_s.station, test_s.hour, strict=True)])
    mae_hourly = float(np.mean(np.abs(test_s.y - hourly_pred)))
    mae_mlp = float(
        np.mean(np.abs(test_s.y - np.clip(_forward(params, norm(test_s.x))[0], -tempmlp.MAX_ABS, tempmlp.MAX_ABS)))
    )
    best_other = min(mae_raw, mae_hourly)
    passed = mae_mlp <= best_other - MIN_GAIN and mae_mlp <= best_other * (1 - MIN_GAIN_REL)
    status["metrics"] = {
        "test_pairs": int(len(test_s.y)),
        "mae_raw": round(mae_raw, 3),
        "mae_hourly_bias": round(mae_hourly, 3),
        "mae_mlp": round(mae_mlp, 3),
        "epochs": epochs,
    }
    if not passed:
        status["reason"] = "does not beat the hourly bias yet"
        tempmlp.save(data_root, status)
        log.info("mlp: not used (MAE raw %.3f, hourly %.3f, mlp %.3f)", mae_raw, mae_hourly, mae_mlp)
        return status

    # good enough: refit on every day, with the epoch count early stopping chose
    mean, std = samples.x.mean(axis=0), samples.x.std(axis=0) + 1e-6
    params, _ = train((samples.x - mean) / std, samples.y, epochs=max(epochs, 5))
    stations = sorted({str(s) for s in samples.station})
    status.update(
        active=True,
        reason=None,
        mean=mean.tolist(),
        std=std.tolist(),
        weights=[p.tolist() for p in params],
        stations=[{k: info[s][k] for k in ("id", "lat", "lon", "elevation", "model_elevation")} for s in stations],
    )
    tempmlp.save(data_root, status)
    log.info("mlp: active (MAE raw %.3f, hourly %.3f, mlp %.3f, %d epochs)", mae_raw, mae_hourly, mae_mlp, epochs)
    return status


def load_status(data_root: Path) -> dict | None:
    try:
        d = json.loads(tempmlp.path(data_root).read_text(encoding="utf-8"))
        return {k: v for k, v in d.items() if k not in ("weights", "mean", "std", "stations")}
    except (OSError, ValueError):
        return None
