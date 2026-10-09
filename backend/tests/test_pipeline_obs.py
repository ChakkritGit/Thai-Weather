"""Only the report closest to the run start counts per station in the correction."""

from datetime import timedelta

import numpy as np

from app.downscale.observations import Observation
from app.downscale.pipeline import Downscaler
from app.store import RunStore

LAT, LON = 13.75, 100.5


def _run(static, coarse, root, reports):
    store = RunStore(root)
    Downscaler(static, members=2).run(coarse, store, reports)
    return store.latest()


def _obs(sid, t0, minutes, t2m):
    return Observation(sid, LAT, LON, t0 + timedelta(minutes=minutes), t2m)


def test_one_report_per_station_closest_to_t0(static, coarse, tmp_path):
    t0 = coarse.times[0]
    # three reports from one station; only the one at t0 (value 36) may be used
    many = [_obs("BKK", t0, -60, 30.0), _obs("BKK", t0, -30, 31.0), _obs("BKK", t0, 0, 36.0)]
    run_many = _run(static, coarse, tmp_path / "a", many)
    assert run_many.meta["observations_used"] == 1
    assert run_many.meta["observation_stations"] == ["BKK"]

    run_one = _run(static, coarse, tmp_path / "b", [_obs("BKK", t0, 0, 36.0)])
    assert np.array_equal(run_many.array("fine", "temp"), run_one.array("fine", "temp"))

    run_old = _run(static, coarse, tmp_path / "c", [_obs("BKK", t0, -60, 30.0)])
    assert not np.array_equal(run_many.array("fine", "temp"), run_old.array("fine", "temp"))


def test_out_of_window_and_out_of_domain_not_listed(static, coarse, tmp_path):
    t0 = coarse.times[0]
    reports = [
        _obs("OLD", t0, -120, 30.0),  # outside +-90 min
        Observation("FAR", 40.0, 100.0, t0, 30.0),  # outside the domain
        _obs("OK", t0, 45, 31.0),
    ]
    run = _run(static, coarse, tmp_path / "d", reports)
    assert run.meta["observations_used"] == 1
    assert run.meta["observation_stations"] == ["OK"]
