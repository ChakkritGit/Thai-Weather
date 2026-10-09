from datetime import UTC, datetime

import numpy as np

from app.core.grid import FINE_GRID
from app.downscale.observations import Observation, correction_field, residuals


def test_station_residual_spreads_locally(static):
    t = np.full(FINE_GRID.shape, 30.0, np.float32)
    ob = Observation("BKK", 13.75, 100.5, datetime.now(UTC), 32.0)
    res = residuals([ob], t, static.elev_land, FINE_GRID)
    assert res[0][1] == 2.0
    c = correction_field(res, static.elev_land, FINE_GRID)
    near = c[FINE_GRID.index(13.75, 100.5)]
    far = c[FINE_GRID.index(18.8, 99.0)]
    assert 1.3 < near <= 2.0
    assert abs(far) < 0.01
