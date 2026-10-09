import numpy as np
import pytest

from app.core.thermo import heat_index, relative_humidity, wind_components, wind_speed_dir


@pytest.mark.parametrize(
    "t_f, rh, expected_f",
    [(90, 70, 106), (86, 90, 105), (96, 50, 108), (80, 40, 80), (100, 40, 109)],  # NWS heat index chart
)
def test_heat_index_matches_nws_table(t_f, rh, expected_f):
    t_c = (t_f - 32) * 5 / 9
    hi_f = float(heat_index(np.array(t_c), np.array(rh))) * 9 / 5 + 32
    assert hi_f == pytest.approx(expected_f, abs=1.5)


def test_rh_saturated_and_dry():
    assert float(relative_humidity(np.array(25.0), np.array(25.0))) == pytest.approx(100.0)
    assert float(relative_humidity(np.array(35.0), np.array(15.0))) == pytest.approx(30.0, abs=1.5)


def test_wind_roundtrip():
    s, d = np.array([5.0, 10.0]), np.array([225.0, 45.0])
    u, v = wind_components(s, d)
    assert u[0] > 0 and v[0] > 0  # south-westerly blows towards the north-east
    s2, d2 = wind_speed_dir(u, v)
    np.testing.assert_allclose(s2, s, atol=1e-6)
    np.testing.assert_allclose(d2, d, atol=1e-6)
