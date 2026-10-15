"""Chance-of-rain calibration: the maths, the refit from the verification archive, and its use in runs."""

from datetime import UTC, datetime, timedelta

import numpy as np

from app.downscale import calibration
from app.downscale.calibration import PopCalibration
from app.downscale.pipeline import Downscaler
from app.store import RunStore
from verify import calibrate as vcal
from verify import db


def _sample(n, a, b, seed=1):
    rng = np.random.default_rng(seed)
    raw = rng.beta(0.6, 2.0, n) * 100
    p = PopCalibration(a=a, b=b).apply(raw) / 100
    return raw, (rng.random(n) < p).astype(float)


def test_identity_changes_nothing():
    x = np.array([0.0, 12.5, 100.0], dtype=np.float32)
    assert PopCalibration().apply(x) is x


def test_fit_recovers_known_calibration_and_inverts():
    raw, y = _sample(40_000, -1.4, 0.4)
    a, b = calibration.fit(raw, y, prior=1.0)
    assert abs(a + 1.4) < 0.15 and abs(b - 0.4) < 0.05
    cal = PopCalibration(a=a, b=b)
    x = np.array([1.0, 10.0, 50.0, 90.0])
    assert np.allclose(cal.invert(cal.apply(x)), x, atol=1e-3)
    assert np.all(np.diff(cal.apply(np.array([0.0, 20.0, 40.0, 60.0, 80.0, 100.0]))) > 0)  # order kept


def test_overconfident_forecast_is_pulled_down_and_brier_improves():
    raw, y = _sample(5_000, -1.4, 0.4, seed=2)
    cal = calibration.calibrate(raw, y, fitted_at="t", window_days=30)
    assert not cal.identity
    assert cal.brier_cal < cal.brier_raw
    assert cal.apply(np.array([80.0]))[0] < 50


def test_not_enough_data_means_no_change():
    raw, y = _sample(500, -1.4, 0.4)
    assert calibration.calibrate(raw, y, fitted_at="t", window_days=30).identity
    assert calibration.calibrate(
        np.full(2000, 10.0), np.zeros(2000), fitted_at="t", window_days=30
    ).identity  # no wet hours


def test_save_load_and_bad_file(tmp_path):
    cal = PopCalibration(a=-1.2, b=0.35, pairs=3000, events=200, fitted_at="2026-10-15T00:00", window_days=30)
    calibration.save(tmp_path, cal)
    assert calibration.load(tmp_path) == cal
    calibration.path(tmp_path).write_text("{not json")
    assert calibration.load(tmp_path).identity
    assert calibration.load(tmp_path / "nowhere").identity


def test_refit_undoes_each_runs_own_calibration(tmp_path):
    """Two runs, one raw and one calibrated: the refit must see the same raw values for both."""
    conn = db.connect(tmp_path / "v.sqlite")
    applied = PopCalibration(a=-1.0, b=0.5)
    t0 = datetime(2026, 10, 1, tzinfo=UTC)
    raw, y = _sample(3_000, -1.4, 0.4, seed=3)
    conn.execute("INSERT INTO stations VALUES ('S1','s',13.7,100.5,5,'test')")
    for run_id, cal in (("r-raw", None), ("r-cal", applied)):
        conn.execute(
            "INSERT INTO runs (run_id, run_time, collected_at, n_stations, baseline_ok, pop_a, pop_b) VALUES (?,?,?,?,?,?,?)",
            (run_id, db.fmt_time(t0), db.fmt_time(t0), 1, 0, cal.a if cal else None, cal.b if cal else None),
        )
    for i, (r, o) in enumerate(zip(raw, y, strict=True)):
        valid = t0 + timedelta(hours=i)
        run_id, shown = ("r-cal", float(applied.apply(np.array([r]))[0])) if i % 2 else ("r-raw", float(r))
        conn.execute(
            "INSERT INTO forecasts VALUES (?,?,?,?,?,?,?,?)",
            (run_id, "fine", "S1", db.fmt_time(valid), 1, 30.0, 0.0, shown),
        )
        conn.execute(
            "INSERT INTO obs VALUES (?,?,?,?,?)",
            ("S1", db.fmt_time(valid - timedelta(minutes=30)), 30.0, "RA" if o else "", None),
        )
    conn.commit()
    got_raw, _, got_obs = vcal.hourly_pairs(conn, t0 - timedelta(hours=1), t0 + timedelta(hours=len(raw)))
    assert len(got_raw) == len(raw)
    # below 0.5 % the logit clips (the fit sees those hours the same either way)
    clip = lambda v: np.clip(v, 0.5, 99.5)  # noqa: E731
    assert np.allclose(np.sort(clip(got_raw)), np.sort(clip(raw)), atol=0.05)
    assert got_obs.sum() == y.sum()
    cal = vcal.refit(conn, tmp_path, now=t0 + timedelta(hours=len(raw)), days=400)
    assert not cal.identity and calibration.load(tmp_path) == cal


def test_runs_apply_and_record_the_calibration(static, coarse, tmp_path):
    def run(cal, root):
        store = RunStore(root)
        Downscaler(static, members=2, pop_calibration=cal).run(coarse, store)
        r = store.latest()
        return r, float(r.array("fine", "pop").mean())

    raw_run, raw_mean = run(None, tmp_path / "a")
    cal_run, cal_mean = run(PopCalibration(a=-2.0, b=0.4), tmp_path / "b")
    assert raw_run.meta["pop_calibration"]["b"] == 1.0
    assert cal_run.meta["pop_calibration"] == {"a": -2.0, "b": 0.4, "pairs": 0, "fitted_at": None}
    assert cal_mean != raw_mean
