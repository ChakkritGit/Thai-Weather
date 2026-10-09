import numpy as np

from app.downscale.precip import PrecipEnsemble


def test_conserves_coarse_rain_and_is_intermittent():
    shape = (200, 200)
    ens = PrecipEnsemble(shape, members=6, coarse_ratio=10, seed=1)
    target = np.full(shape, 2.0, dtype=np.float32)
    cape = np.full(shape, 2000.0, dtype=np.float32)
    m = ens.step(target, cape, (0.5, 1.0))
    # unbiased in expectation; a 200×200 domain holds only a few hundred independent cells
    assert abs(m.mean() / 2.0 - 1.0) < 0.15
    wet = (m >= 0.5).mean()
    assert 0.2 < wet < 0.8  # convective rain covers only part of the area
    assert m.max() > 10.0  # but is locally intense


def test_no_rain_where_model_is_dry():
    ens = PrecipEnsemble((50, 50), members=3, coarse_ratio=10, seed=2)
    m = ens.step(np.zeros((50, 50), np.float32), np.full((50, 50), 3000.0, np.float32), (0, 0))
    assert m.max() == 0.0


def test_temporal_coherence():
    shape = (120, 120)
    ens = PrecipEnsemble(shape, members=1, coarse_ratio=10, seed=3)
    target = np.full(shape, 1.5, np.float32)
    cape = np.full(shape, 1500.0, np.float32)
    a = ens.step(target, cape, (0, 0))[0]
    b = ens.step(target, cape, (0, 0))[0]
    assert np.corrcoef(a.ravel(), b.ravel())[0, 1] > 0.5
