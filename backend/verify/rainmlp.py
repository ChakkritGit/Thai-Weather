"""A neural network for the chance of rain (``loop``, daily), switched on only once it is better.

Rain is rare (about 5 % of station hours), so this waits for ``MIN_EVENTS`` hours in which a station
reported rain, then:

1. one sample per archived forecast hour at a station with a report: the raw chance of rain (from
   the run's own record, or the logistic calibration turned back), the 2.2 km rain amount, Bangkok
   hour and day of year, lead, station height and position (:func:`app.downscale.rainmlp.features`);
   the label is whether the station reported rain in that hour.
2. the last ``TEST_DAYS`` days are held out; a 2-layer tanh MLP with a sigmoid output is trained by
   backpropagation of the binary cross-entropy (Adam, L2, early stopping on the latest 15 % of the
   training days), and the logistic calibration is fitted on the same days.
3. switched on only if its Brier score on the held-out days beats both the raw chance and the
   logistic calibration by ``MIN_GAIN_REL``; then refitted on all days and written ``active``.
   A later failed check switches it off and the logistic calibration takes over again.

Hold-out stations are never trained on. Also writes ``calibration/stations.json`` (every station),
from which forecast runs record the raw chance of rain at the stations.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from app.downscale import calibration, rainmlp

from . import db, holdout
from .calibrate import raw_at
from .mlp import predict, train
from .observe import is_rain

log = logging.getLogger("verify.rainmlp")

MIN_EVENTS = 2000  # station hours with rain
MIN_DAYS = 30  # enough to hold out TEST_DAYS and still train
TEST_DAYS = 14
MIN_GAIN_REL = 0.02  # Brier score
HIDDEN = (16, 8)
MAX_EPOCHS = 200


def _epoch_min(s: str) -> int:
    return int(db.parse_time(s).timestamp() // 60)


def write_stations(conn: sqlite3.Connection, data_root: Path) -> int:
    rows = [
        {"id": r["id"], "lat": r["lat"], "lon": r["lon"], "elevation": r["elevation"]}
        for r in conn.execute("SELECT id, lat, lon, elevation FROM stations ORDER BY id")
    ]
    p = rainmlp.stations_path(data_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows), encoding="utf-8")
    tmp.replace(p)
    return len(rows)


def build(conn: sqlite3.Connection, now: datetime | None = None):
    """(features, label, raw pop %, valid day) for every usable station hour."""
    now = now or datetime.now(UTC)
    held = holdout.load(conn)
    info = {r["id"]: r for r in conn.execute("SELECT id, lat, lon, elevation FROM stations")}
    rained: dict[tuple[str, int], bool] = {}
    for r in conn.execute("SELECT station, valid, wx, rain_1h FROM obs WHERE valid <= ?", (db.fmt_time(now),)):
        flag = is_rain(r["wx"], r["rain_1h"])
        if flag is None:
            continue
        k = (r["station"], -(-_epoch_min(r["valid"]) // 60) * 60)
        rained[k] = rained.get(k, False) or flag
    runs = {}
    for r in conn.execute("SELECT run_id, pop_a, pop_b, pop_raw, pop_mlp FROM runs"):
        try:
            rec = json.loads(r["pop_raw"]) if r["pop_raw"] else None
        except ValueError:
            rec = None
        runs[r["run_id"]] = (r["pop_a"], r["pop_b"], bool(r["pop_mlp"]), rec)
    xs, ys, raws, days = [], [], [], []
    for r in conn.execute(
        "SELECT run_id, station, valid, lead_h, pop, rain FROM forecasts WHERE source='fine' AND pop IS NOT NULL AND valid <= ?",
        (db.fmt_time(now),),
    ):
        sid = r["station"]
        if sid in held or sid not in info or info[sid]["elevation"] is None:
            continue
        o = rained.get((sid, _epoch_min(r["valid"])))
        if o is None:
            continue
        a, b, by_network, rec = runs.get(r["run_id"], (None, None, False, None))
        raw = raw_at(rec, sid, r["valid"])
        if raw is None:
            if by_network:
                continue
            cal = (
                calibration.PopCalibration(a=a, b=b)
                if a is not None and b is not None
                else calibration.PopCalibration()
            )
            raw = float(cal.invert(np.array([r["pop"]]))[0])
        valid = db.parse_time(r["valid"])
        s = info[sid]
        xs.append(
            rainmlp.features(
                np.array([raw]), np.array([r["rain"] or 0.0]), valid, r["lead_h"], s["elevation"], s["lat"], s["lon"]
            )[0]
        )
        ys.append(1.0 if o else 0.0)
        raws.append(raw)
        days.append(int(valid.timestamp() // 86400))
    x = np.asarray(xs, dtype=np.float64).reshape(-1, rainmlp.N_FEATURES)
    return x, np.asarray(ys), np.asarray(raws), np.asarray(days, dtype=np.int64)


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def refit(conn: sqlite3.Connection, data_root: Path, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    write_stations(conn, data_root)
    x, y, raw, day = build(conn, now)
    n, events = len(y), int(y.sum())
    days = int(day.max() - day.min() + 1) if n else 0
    status = {
        "fitted_at": now.isoformat(timespec="minutes"),
        "active": False,
        "pairs": n,
        "events": events,
        "days": days,
        "required_events": MIN_EVENTS,
        "required_days": MIN_DAYS,
        "test_days": TEST_DAYS,
        "metrics": None,
    }
    if events < MIN_EVENTS or days < MIN_DAYS:
        status["reason"] = "waiting for data"
        rainmlp.save(data_root, status)
        log.info("rainmlp: waiting for data (%d/%d rain hours, %d/%d days)", events, MIN_EVENTS, days, MIN_DAYS)
        return status

    cut = day.max() - TEST_DAYS + 1
    tr, te = day < cut, day >= cut
    mean, std = x[tr].mean(axis=0), x[tr].std(axis=0) + 1e-6
    norm = lambda a: (a - mean) / std  # noqa: E731
    val_cut = np.quantile(day[tr], 0.85)
    fit_m, val_m = tr & (day < val_cut), tr & (day >= val_cut)
    params, epochs = train(
        norm(x[fit_m]), y[fit_m], val=(norm(x[val_m]), y[val_m]), hidden=HIDDEN, classify=True, max_epochs=MAX_EPOCHS
    )
    params, _ = train(norm(x[tr]), y[tr], epochs=max(epochs, 5), hidden=HIDDEN, classify=True)

    logistic = calibration.calibrate(raw[tr], y[tr], fitted_at=status["fitted_at"], window_days=days)
    b_raw = brier(raw[te] / 100.0, y[te])
    b_log = brier(logistic.apply(raw[te]) / 100.0, y[te])
    b_mlp = brier(predict(params, norm(x[te]), classify=True), y[te])
    status["metrics"] = {
        "test_hours": int(te.sum()),
        "test_rain_hours": int(y[te].sum()),
        "brier_raw": round(b_raw, 5),
        "brier_logistic": round(b_log, 5),
        "brier_mlp": round(b_mlp, 5),
        "epochs": epochs,
    }
    if b_mlp > min(b_raw, b_log) * (1 - MIN_GAIN_REL):
        status["reason"] = "does not beat the logistic calibration yet"
        rainmlp.save(data_root, status)
        log.info("rainmlp: not used (Brier raw %.4f, logistic %.4f, mlp %.4f)", b_raw, b_log, b_mlp)
        return status

    mean, std = x.mean(axis=0), x.std(axis=0) + 1e-6
    params, _ = train((x - mean) / std, y, epochs=max(epochs, 5), hidden=HIDDEN, classify=True)
    status.update(active=True, reason=None, mean=mean.tolist(), std=std.tolist(), weights=[p.tolist() for p in params])
    rainmlp.save(data_root, status)
    log.info("rainmlp: active (Brier raw %.4f, logistic %.4f, mlp %.4f, %d epochs)", b_raw, b_log, b_mlp, epochs)
    return status


def load_status(data_root: Path) -> dict | None:
    try:
        d = json.loads(rainmlp.path(data_root).read_text(encoding="utf-8"))
        return {k: v for k, v in d.items() if k not in ("weights", "mean", "std")}
    except (OSError, ValueError):
        return None
