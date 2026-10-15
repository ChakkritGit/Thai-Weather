"""Learned temperature bias: the fit (verify) and how a run applies it (app)."""

import json
from datetime import UTC, datetime, timedelta

import numpy as np

from app.core.grid import Grid
from app.downscale import tempbias as tbmod
from verify import db, holdout
from verify import tempbias as fitmod


def _db(tmp_path):
    conn = db.connect(tmp_path / "v.db")
    for sid, lat, lon in (("VTBD", 13.91, 100.6), ("VTCC", 18.77, 98.96), ("VTSP", 7.88, 98.31)):
        db.upsert_station(conn, sid, sid, lat, lon, 5.0, "iem")
    db.set_meta(conn, holdout.META_KEY, "VTSP")  # held out: never fitted
    return conn


def _fill(conn, now, warm_by, applied=None):
    """30 days of 24-h forecasts that run `warm_by` °C warm at 06 ICT (23 UTC) at VTBD and VTSP."""
    rows, obs = [], []
    for d in range(1, 29):
        valid = (now - timedelta(days=d)).replace(hour=23, minute=0, second=0, microsecond=0)
        run_id = f"r{d}"
        conn.execute(
            "INSERT INTO runs (run_id, run_time, collected_at, n_stations, baseline_ok, temp_bias) VALUES (?,?,?,?,?,?)",
            (
                run_id,
                db.fmt_time(valid - timedelta(hours=24)),
                db.fmt_time(valid),
                3,
                0,
                json.dumps(applied) if applied else None,
            ),
        )
        for sid in ("VTBD", "VTSP"):
            shown = 25.0 + warm_by + ((applied or {}).get(sid, [0.0] * 24)[6])
            rows.append((run_id, "fine", sid, db.fmt_time(valid), 24, shown, 0.0, 0.0))
            obs.append((sid, db.fmt_time(valid), 25.0))
    conn.executemany(
        "INSERT INTO forecasts (run_id, source, station, valid, lead_h, t2m, rain, pop) VALUES (?,?,?,?,?,?,?,?)", rows
    )
    conn.executemany("INSERT INTO obs (station, valid, t2m) VALUES (?,?,?)", obs)
    conn.commit()


def test_fit_learns_the_hourly_bias_and_skips_the_hold_out(tmp_path):
    conn = _db(tmp_path)
    now = datetime(2026, 11, 20, 12, tzinfo=UTC)
    _fill(conn, now, warm_by=2.0)
    tb = fitmod.fit(conn, now)
    by = {s.id: s for s in tb.stations}
    assert "VTSP" not in by  # hold-out
    b = by["VTBD"]
    assert b.n[6] == 28
    # 28 pairs of +2 shrunk by 10 pseudo-pairs, then 1-2-1 smoothed: 0.5 of it stays at 06 ICT
    assert abs(b.bias[6] - 0.5 * 2.0 * 28 / 38) < 0.01
    assert b.bias[5] > 0 and b.bias[12] == 0


def test_fit_adds_back_what_the_run_applied(tmp_path):
    conn = _db(tmp_path)
    now = datetime(2026, 11, 20, 12, tzinfo=UTC)
    # the runs already subtracted 1.5 °C at 06 ICT: the raw bias (2 °C) must still be learned
    _fill(conn, now, warm_by=2.0, applied={"VTBD": [0.0] * 6 + [-1.5] + [0.0] * 17})
    b = {s.id: s for s in fitmod.fit(conn, now).stations}["VTBD"]
    assert abs(b.bias[6] - 0.5 * 2.0 * 28 / 38) < 0.01


def test_a_run_subtracts_the_bias_near_the_station_only():
    grid = Grid(13.0, 15.0, 100.0, 101.5, 0.02, 0.02)
    elev = np.zeros(grid.shape, dtype=np.float32)
    tb = tbmod.TempBias(
        "t", 30, 100, [tbmod.StationBias("VTBD", 13.91, 100.6, 0.0, [0.0] * 6 + [2.0] + [0.0] * 17, [30] * 24)]
    )
    f = tbmod.fields(tb, grid, elev)
    iy, ix = grid.index(13.91, 100.6)
    assert -2.0 < f[6, iy, ix] < -1.7  # ~90 % of the bias at the station (SHRINK)
    assert abs(f[6][grid.index(14.9, 101.4)]) < 0.01  # >100 km away: nothing
    assert np.all(f[12] == 0)
    applied = tbmod.applied_at_stations(f, tb, grid)
    assert applied["VTBD"][6] == round(float(f[6, iy, ix]), 3)
    assert tbmod.fields(tbmod.TempBias(), grid, elev) is None


def test_load_rejects_broken_files(tmp_path):
    tbmod.save(tmp_path, tbmod.TempBias("t", 30, 5, [tbmod.StationBias("X", 13.0, 100.0, None, [9.0] * 24, [1] * 24)]))
    assert tbmod.load(tmp_path).stations == []  # |bias| > MAX_ABS is a broken fit, not a bias
    assert tbmod.load(tmp_path / "nowhere").empty
