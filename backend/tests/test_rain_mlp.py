"""The chance-of-rain network: the waiting gate, switching itself on, raw values kept for refitting."""

import json
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.downscale import rainmlp
from verify import calibrate, db
from verify import rainmlp as rmod


def _db(tmp_path, days, hour_effect=True, stations=6):
    """Rain that depends on the time of day (afternoon storms) much more than the raw chance says."""
    conn = db.connect(tmp_path / "v.db")
    rng = np.random.default_rng(2)
    t_end = datetime(2026, 12, 31, tzinfo=UTC)
    sids = [f"S{i}" for i in range(stations)]
    for i, sid in enumerate(sids):
        db.upsert_station(conn, sid, sid, 13.0 + i * 0.4, 100.0 + i * 0.3, 10.0 + 20 * i, "iem")
    fc, obs = [], []
    for d in range(days):
        t0 = t_end - timedelta(days=days - d)
        run_id = f"r{d}"
        conn.execute(
            "INSERT INTO runs (run_id, run_time, collected_at, n_stations, baseline_ok) VALUES (?,?,?,?,?)",
            (run_id, db.fmt_time(t0), db.fmt_time(t0), stations, 1),
        )
        for lead in range(1, 25):
            valid = t0 + timedelta(hours=lead)
            bkk = (valid.hour + 7) % 24
            for sid in sids:
                raw = float(rng.uniform(0, 60))
                p = (0.55 if 14 <= bkk <= 18 else 0.03) if hour_effect else raw / 100 * 0.3
                wet = rng.random() < p
                fc.append((run_id, "fine", sid, db.fmt_time(valid), lead, 28.0, 0.5 if raw > 30 else 0.0, raw))
                obs.append((sid, db.fmt_time(valid - timedelta(minutes=30)), 28.0, "RA" if wet else ""))
    conn.executemany(
        "INSERT INTO forecasts (run_id, source, station, valid, lead_h, t2m, rain, pop) VALUES (?,?,?,?,?,?,?,?)", fc
    )
    conn.executemany("INSERT OR REPLACE INTO obs (station, valid, t2m, wx) VALUES (?,?,?,?)", obs)
    conn.commit()
    return conn, t_end + timedelta(days=1)


def test_waits_for_two_thousand_rain_hours_and_writes_the_station_list(tmp_path):
    conn, now = _db(tmp_path, days=4)
    st = rmod.refit(conn, tmp_path, now)
    assert st["active"] is False and st["reason"] == "waiting for data"
    assert st["required_events"] == 2000 and 0 < st["events"] < 2000
    assert rainmlp.load(tmp_path) is None
    assert {s["id"] for s in rainmlp.load_stations(tmp_path)} == {f"S{i}" for i in range(6)}


@pytest.fixture
def small_gate(monkeypatch):
    monkeypatch.setattr(rmod, "MIN_EVENTS", 300)
    monkeypatch.setattr(rmod, "MIN_DAYS", 20)
    monkeypatch.setattr(rmod, "TEST_DAYS", 5)
    monkeypatch.setattr(rmod, "MAX_EPOCHS", 60)


def test_switches_itself_on_when_it_beats_the_logistic_calibration(tmp_path, small_gate):
    conn, now = _db(tmp_path, days=30)
    st = rmod.refit(conn, tmp_path, now)
    m = st["metrics"]
    assert st["active"] is True, st
    assert m["brier_mlp"] < m["brier_logistic"] * 0.98
    model = rainmlp.load(tmp_path)

    # the network learned the afternoon storms: same raw chance, very different probability
    def at(hour_utc):
        x = rainmlp.features(
            np.array([20.0]), np.array([0.0]), datetime(2027, 1, 2, hour_utc, tzinfo=UTC), 12, 30.0, 13.5, 100.4
        )
        return float(model.probability(x)[0])

    assert at(9) > 3 * at(1)  # 16:00 vs 08:00 Bangkok


def test_stays_off_when_the_calibration_is_as_good(tmp_path, small_gate):
    conn, now = _db(tmp_path, days=30, hour_effect=False)
    st = rmod.refit(conn, tmp_path, now)
    assert st["active"] is False and st["reason"] == "does not beat the logistic calibration yet"


def test_refits_use_the_raw_values_a_run_recorded_and_skip_unrecoverable_ones(tmp_path):
    conn, now = _db(tmp_path, days=3, stations=1)
    rec = {"t0": "2026-12-28T00:00:00+00:00", "steps": {"S0": [7.5] * 30}}
    conn.execute("UPDATE runs SET pop_raw = ?, pop_mlp = 1 WHERE run_id = 'r0'", (json.dumps(rec),))
    conn.execute("UPDATE runs SET pop_mlp = 1 WHERE run_id = 'r1'")  # a network run with no raw record
    conn.commit()
    raw, shown, obs = calibrate.hourly_pairs(conn, now - timedelta(days=10), now)
    n_r0 = 24
    assert len(raw) == 2 * n_r0  # r1's hours are left out
    assert (raw[:n_r0] == 7.5).all()


def test_an_active_network_sets_the_chance_of_rain_and_raw_values_are_recorded(static, coarse, tmp_path):
    from app.downscale.pipeline import Downscaler
    from app.store import RunStore

    n = rainmlp.N_FEATURES
    # always 80 %: zero weights, output bias logit(0.8)
    model = rainmlp.Model(
        {
            "weights": [np.zeros((n, 4)).tolist(), [0.0] * 4, np.zeros((4, 1)).tolist(), [float(np.log(4))]],
            "mean": [0.0] * n,
            "std": [1.0] * n,
            "fitted_at": "t",
            "pairs": 1,
            "events": 1,
            "days": 1,
            "metrics": None,
        }
    )
    stations = [{"id": "BKK", "lat": 13.75, "lon": 100.5, "elevation": 5.0}]
    store = RunStore(tmp_path)
    Downscaler(static, members=2, rain_mlp=model, stations=stations).run(coarse, store, None)
    run = store.latest()
    iy, ix = run.fine_grid.index(13.75, 100.5)
    pop = run.series("fine", "pop", iy, ix)
    assert all(79 <= p <= 81 for p in pop)
    assert run.meta["pop_calibration"]["kind"] == "mlp"
    assert len(run.meta["pop_raw"]["steps"]["BKK"]) == len(run.meta["times"])
