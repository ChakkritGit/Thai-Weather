"""Probability-matched mean: the hourly rain layer rains where a typical member does, not everywhere."""

import numpy as np

from app.downscale.precip import PrecipEnsemble


def test_wet_area_and_total_follow_the_members_not_the_mean():
    rng = np.random.default_rng(3)
    yy, xx = np.mgrid[0:120, 0:90]
    members = []
    for _ in range(8):
        f = np.zeros((120, 90), np.float32)
        for _ in range(6):
            cy, cx = rng.integers(0, 120), rng.integers(0, 90)
            f += 15 * np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / 18.0)
        members.append(f)
    m = np.stack(members)
    pmm = PrecipEnsemble.probability_matched_mean(m)
    mean = m.mean(axis=0)
    wet = lambda a: float((a >= 0.2).mean())  # noqa: E731
    member_wet = np.mean([wet(x) for x in m])
    assert wet(mean) > 2 * member_wet  # the drizzle the plain mean makes
    assert abs(wet(pmm) - member_wet) < 0.02
    assert abs(pmm.sum() - mean.sum()) / mean.sum() < 0.01
    assert pmm.max() > 2 * mean.max()  # cells keep realistic intensities
    # the wettest cell of the mean is the wettest of the matched field
    assert np.unravel_index(pmm.argmax(), pmm.shape) == np.unravel_index(mean.argmax(), mean.shape)


def test_dry_ensemble_stays_dry():
    assert not PrecipEnsemble.probability_matched_mean(np.zeros((4, 10, 10), np.float32)).any()
