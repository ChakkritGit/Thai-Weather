"""The temperature neural network: backpropagation, the waiting gate, switching itself on, applying it."""

from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.core.grid import Grid
from app.downscale import tempmlp
from verify import db
from verify import mlp as mlpmod
from verify.tempbias import applied_correction


def test_backpropagation_learns_a_nonlinear_correction():
    rng = np.random.default_rng(0)
    x = rng.normal(size=(3000, tempmlp.N_FEATURES))
    y = 1.5 * np.tanh(2 * x[:, 1]) + 0.5 * x[:, 2] * x[:, 3]
    params, _ = mlpmod.train(x[:2500], y[:2500], epochs=60)
    pred = mlpmod._forward(params, x[2500:])[0]
    assert np.mean(np.abs(pred - y[2500:])) < 0.35 * np.mean(np.abs(y[2500:]))


def _db(tmp_path, days, stations=8, gap_effect=1.5):
    """Forecasts whose error depends on the gap to GFS - something an hourly bias cannot learn."""
    conn = db.connect(tmp_path / "v.db")
    rng = np.random.default_rng(1)
    t_end = datetime(2026, 12, 31, tzinfo=UTC)
    sids = [f"S{i}" for i in range(stations)]
    for i, sid in enumerate(sids):
        db.upsert_station(conn, sid, sid, 13.0 + i * 0.3, 100.0 + i * 0.2, 20.0 + i, "iem")
        db.set_meta(conn, f"elev:{sid}", f"{20 + i},{60 + i}")
    fc, obs = [], []
    for d in range(days):
        t0 = t_end - timedelta(days=days - d)
        run_id = f"r{d}"
        conn.execute(
            "INSERT INTO runs (run_id, run_time, collected_at, n_stations, baseline_ok) VALUES (?,?,?,?,?)",
            (run_id, db.fmt_time(t0), db.fmt_time(t0), stations, 1),
        )
        for lead in range(24, 48):
            valid = t0 + timedelta(hours=lead)
            for sid in sids:
                raw = 27 + 4 * np.sin(2 * np.pi * ((valid.hour + 7) % 24) / 24) + rng.normal(0, 1)
                gap = rng.normal(0, 2)
                truth = raw + gap_effect * np.tanh(gap) + rng.normal(0, 0.3)
                fc.append((run_id, "fine", sid, db.fmt_time(valid), lead, float(raw), 0.0, 0.0))
                fc.append((run_id, "gfs_raw", sid, db.fmt_time(valid), lead, float(raw + gap), 0.0, 0.0))
                obs.append((sid, db.fmt_time(valid), float(round(truth, 1))))
    conn.executemany(
        "INSERT INTO forecasts (run_id, source, station, valid, lead_h, t2m, rain, pop) VALUES (?,?,?,?,?,?,?,?)", fc
    )
    conn.executemany("INSERT OR REPLACE INTO obs (station, valid, t2m) VALUES (?,?,?)", obs)
    conn.commit()
    return conn, t_end + timedelta(days=2)


def test_waits_for_enough_history(tmp_path):
    conn, now = _db(tmp_path, days=5, stations=2)
    st = mlpmod.refit(conn, tmp_path, now)
    assert st["active"] is False and st["reason"] == "waiting for data"
    assert st["required_days"] == mlpmod.MIN_DAYS and st["days"] < mlpmod.MIN_DAYS
    assert tempmlp.load(tmp_path) is None
    assert mlpmod.load_status(tmp_path)["reason"] == "waiting for data"


@pytest.fixture
def small_gate(monkeypatch):
    monkeypatch.setattr(mlpmod, "MIN_DAYS", 20)
    monkeypatch.setattr(mlpmod, "MIN_PAIRS", 2000)
    monkeypatch.setattr(mlpmod, "TEST_DAYS", 5)
    monkeypatch.setattr(mlpmod, "MAX_EPOCHS", 80)


def test_switches_itself_on_when_it_beats_the_hourly_bias(tmp_path, small_gate):
    conn, now = _db(tmp_path, days=30)
    st = mlpmod.refit(conn, tmp_path, now)
    m = st["metrics"]
    assert st["active"] is True, st
    assert m["mae_mlp"] < m["mae_hourly_bias"] - 0.05
    model = tempmlp.load(tmp_path)
    assert model is not None and len(model.stations) == 8
    # applied on a grid: the correction at a station follows the gap to GFS
    grid = Grid(12.5, 16.0, 99.5, 102.0, 0.05, 0.05)
    elev = np.full(grid.shape, 25.0, dtype=np.float32)
    ap = tempmlp.Applier(model, grid, grid, elev)
    temp = np.full(grid.shape, 28.0, dtype=np.float32)
    valid = datetime(2027, 1, 2, 6, tzinfo=UTC)
    warm_gfs = ap.field(temp, temp + 3.0, valid, 30)
    cold_gfs = ap.field(temp, temp - 3.0, valid, 30)
    cell = grid.index(13.0, 100.0)
    assert warm_gfs[cell] > 0.5 and cold_gfs[cell] < -0.5
    rec = ap.record(valid - timedelta(hours=30))
    assert rec["kind"] == "mlp" and len(rec["applied"]["steps"]["S0"]) == 2


def test_stays_off_when_there_is_nothing_to_learn(tmp_path, small_gate):
    conn, now = _db(tmp_path, days=30, gap_effect=0.0)
    st = mlpmod.refit(conn, tmp_path, now)
    assert st["active"] is False and st["reason"] == "does not beat the hourly bias yet"
    assert tempmlp.load(tmp_path) is None


def test_applied_corrections_of_both_kinds_are_added_back():
    valid = datetime(2026, 10, 16, 23, tzinfo=UTC)  # 06 ICT
    hourly = {"VTBD": [0.0] * 6 + [-1.2] + [0.0] * 17}
    assert applied_correction(hourly, "VTBD", valid, None) == -1.2
    steps = {"t0": "2026-10-15T23:00:00+00:00", "steps": {"VTBD": [0.1] * 24 + [0.7] + [0.0] * 23}}
    assert applied_correction(steps, "VTBD", valid, None) == 0.7
    assert applied_correction(steps, "VTXX", valid, None) == 0.0
    assert applied_correction(None, "VTBD", valid, None) == 0.0
