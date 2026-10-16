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


def test_learned_bias_is_subtracted_and_recorded(static, coarse, tmp_path):
    from app.downscale import tempbias as tbmod

    warm = tbmod.StationBias("BKK", LAT, LON, None, [1.5] * 24, [30] * 24)  # runs 1.5 °C warm all day
    plain = _run(static, coarse, tmp_path / "a", None)
    store = RunStore(tmp_path / "b")
    Downscaler(static, members=2, temp_bias=tbmod.TempBias("t", 30, 720, [warm])).run(coarse, store, None)
    fixed = store.latest()
    iy, ix = fixed.fine_grid.index(LAT, LON)
    diff = np.array(fixed.series("fine", "temp", iy, ix)) - np.array(plain.series("fine", "temp", iy, ix))
    # every lead time, ~90 % of the bias at the station (± one 0.28 °C encoding step)
    assert np.all((diff < -1.0) & (diff > -1.8))
    rec = fixed.meta["temp_bias"]
    assert rec["stations"] == 1 and len(rec["applied"]["BKK"]) == 24
    assert plain.meta["temp_bias"] is None


def test_an_active_network_replaces_the_hourly_bias(static, coarse, tmp_path):
    from app.downscale import tempbias as tbmod
    from app.downscale import tempmlp

    # a "network" that always says +1 °C: zero weights, output bias 1
    n = tempmlp.N_FEATURES
    weights = [np.zeros((n, 4)).tolist(), [0.0] * 4, np.zeros((4, 1)).tolist(), [1.0]]
    model = tempmlp.Model(
        {
            "weights": weights,
            "mean": [0.0] * n,
            "std": [1.0] * n,
            "fitted_at": "t",
            "pairs": 1,
            "days": 1,
            "metrics": None,
            "stations": [{"id": "BKK", "lat": LAT, "lon": LON, "elevation": 5.0, "model_elevation": 5.0}],
        }
    )
    hourly = tbmod.TempBias("t", 30, 720, [tbmod.StationBias("BKK", LAT, LON, None, [3.0] * 24, [30] * 24)])
    plain = _run(static, coarse, tmp_path / "a", None)
    store = RunStore(tmp_path / "b")
    Downscaler(static, members=2, temp_bias=hourly, temp_mlp=model).run(coarse, store, None)
    run = store.latest()
    iy, ix = run.fine_grid.index(LAT, LON)
    diff = np.array(run.series("fine", "temp", iy, ix)) - np.array(plain.series("fine", "temp", iy, ix))
    assert np.all((diff > 0.6) & (diff < 1.3))  # the network's +1, not the hourly bias's -3
    rec = run.meta["temp_bias"]
    assert rec["kind"] == "mlp" and len(rec["applied"]["steps"]["BKK"]) == len(run.meta["times"])
