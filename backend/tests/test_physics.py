import numpy as np

from app.downscale.layers import LAYERS
from app.downscale.physics import (
    TerrainAt,
    coastal_convection_factor,
    downscale_humidity,
    downscale_temperature,
    orographic_factor,
    regime,
)
from app.products.scales import categorise


def _terrain(dz=0.0, tpi=0.0, land_delta=0.0, uhi=0.0):
    def a(v):
        return np.array([v], dtype=np.float32)

    return TerrainAt(dz=a(dz), tpi_km=a(tpi), land_delta=a(land_delta), uhi=a(uhi), land=np.array([True]))


def test_lapse_rate_cools_mountain_tops():
    day = regime(np.array([800.0]), np.array([20.0]), np.array([3.0]))
    t, parts = downscale_temperature(np.array([30.0]), _terrain(dz=1000.0), day)
    assert abs(parts["lapse"][0] + 6.5) < 1e-4
    assert t[0] < 24.0


def test_valley_cold_pool_only_on_calm_clear_nights():
    night = regime(np.array([0.0]), np.array([0.0]), np.array([0.5]))
    day = regime(np.array([800.0]), np.array([0.0]), np.array([0.5]))
    _, pn = downscale_temperature(np.array([20.0]), _terrain(tpi=-0.3), night)
    _, pd = downscale_temperature(np.array([20.0]), _terrain(tpi=-0.3), day)
    assert pn["valley"][0] < -1.0
    assert pd["valley"][0] == 0.0


def test_urban_heat_island_is_stronger_at_night():
    night = regime(np.array([0.0]), np.array([10.0]), np.array([1.0]))
    day = regime(np.array([900.0]), np.array([10.0]), np.array([1.0]))
    _, pn = downscale_temperature(np.array([28.0]), _terrain(uhi=3.0), night)
    _, pd = downscale_temperature(np.array([28.0]), _terrain(uhi=3.0), day)
    assert pn["urban"][0] > 2.0 > pd["urban"][0] > 0.0


def test_humidity_conserves_moisture_and_never_supersaturates():
    td, rh = downscale_humidity(np.array([20.0]), np.array([24.0]), np.array([1000.0]), np.array([800.0]))
    assert rh[0] <= 100.0
    assert td[0] <= 20.0 + 1e-3


def test_orographic_factor_windward_vs_lee():
    u = np.array([10.0, 10.0])
    v = np.zeros(2)
    slope_x = np.array([0.1, -0.1])  # rising to the east, then falling
    f = orographic_factor(u, v, slope_x, np.zeros(2), np.array([95.0, 95.0]))
    assert f[0] > 1.5 and f[1] < 0.8


def test_sea_breeze_convection_inland_by_day():
    km = np.array([-30.0, 25.0, 150.0])
    day = coastal_convection_factor(km, np.ones(3), np.zeros(3))
    night = coastal_convection_factor(km, np.zeros(3), np.ones(3))
    assert day[1] > day[2] and night[0] > night[2]


def test_layer_encoding_roundtrip():
    for lyr in LAYERS.values():
        lo, hi = lyr.encoding.min, lyr.encoding.max
        x = np.linspace(lo, hi, 200, dtype=np.float32)
        back = lyr.encoding.decode(lyr.encoding.encode(x))
        step = (hi - lo) / 255 if lyr.encoding.kind == "linear" else 2 * np.sqrt(np.maximum(x, 1e-3) * hi) / 255
        assert np.all(np.abs(back - x) <= step + 1e-3), lyr.id


def test_tmd_categories():
    assert categorise("rainDaily", 35.0)["id"] == "moderate"
    assert categorise("rainDaily", 35.1)["id"] == "heavy"
    assert categorise("rainDaily", 95)["id"] == "veryHeavy"
    assert categorise("heatIndex", 42)["id"] == "danger"
    assert categorise("tempMin", 7.5)["id"] == "veryCold"
    assert categorise("tempMin", 25) is None
