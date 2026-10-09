import math

import numpy as np
import pytest

from app.core.grid import FINE_GRID
from app.nowcast.motion import estimate_motion
from app.nowcast.nowcast import classify, point_nowcast

G = FINE_GRID
LAT, LON = 13.75, 100.5
IY, IX = G.index(LAT, LON)
KM_X = G.dlon * 111.32 * math.cos(math.radians(LAT))  # km per cell, east-west


def blob(cy: int, cx: int, sigma: float = 8.0, peak: float = 50.0) -> np.ndarray:
    yy, xx = np.mgrid[0 : G.ny, 0 : G.nx]
    val = 5.0 + (peak - 5.0) * np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * sigma**2))
    return np.where(val >= 12.0, val, np.nan).astype(np.float32)


def uniform(u_kmh: float, v_kmh: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    return np.full(G.shape, u_kmh, np.float32), np.full(G.shape, v_kmh, np.float32)


def cell(dy: int = 0, dx: int = 0, dbz: float = 50.0) -> np.ndarray:
    field = np.full(G.shape, np.nan, np.float32)
    field[IY + dy, IX + dx] = dbz
    return field


def test_classify_thresholds():
    assert [classify(x) for x in (None, float("nan"), 19.9, 20, 29.9, 30, 40, 45, 54.9, 55, 70)] == [
        "none", "none", "none", "light", "light", "moderate", "heavy", "thunderstorm", "thunderstorm", "severe", "severe",
    ]  # fmt: skip


def test_recovers_translation_of_a_blob():
    frames = [blob(300, 190 + 5 * i) for i in range(3)]  # 5 cells east per 10 min
    u, v = estimate_motion(frames, 10.0, G)
    assert u.shape == G.shape and u.dtype == np.float32
    expected = 5 * KM_X * 6.0  # km/h
    uu, vv = float(u[300, 205]), float(v[300, 205])
    assert math.hypot(uu, vv) == pytest.approx(expected, rel=0.15)
    heading = math.degrees(math.atan2(uu, vv)) % 360
    assert abs(heading - 90) < 15


def test_recovers_northeast_motion_with_two_frames():
    frames = [blob(250 + 3 * i, 180 + 3 * i) for i in range(2)]  # 3 cells N and 3 cells E per 10 min
    u, v = estimate_motion(frames, 10.0, G)
    uu, vv = float(u[253, 183]), float(v[253, 183])
    assert uu > 0 and vv > 0
    assert abs(math.degrees(math.atan2(uu, vv)) - 45) < 15  # ~45° (cells are slightly narrower than tall)


def test_no_echo_or_single_frame_gives_zero_motion():
    empty = np.full(G.shape, np.nan, np.float32)
    for frames in ([empty, empty, empty], [blob(300, 200)]):
        u, v = estimate_motion(frames, 10.0, G)
        assert not u.any() and not v.any()


def test_storm_20_km_west_moving_east_reaches_point_in_about_30_min():
    u, v = uniform(40.0)
    res = point_nowcast(cell(0, -9), u, v, G, LAT, LON)  # 9 cells * 2.16 km = 19.5 km west
    eta = res["eta_storm"]
    assert 25 <= eta["minutes"] <= 35
    lo, hi = eta["minutes_range"]
    assert lo <= eta["minutes"] <= hi and lo <= 30 <= hi
    assert eta["class"] == "thunderstorm" and eta["max_dbz"] == 50.0
    assert res["eta_rain"]["minutes"] == eta["minutes"]
    near = res["nearest"]
    assert near["distance_km"] == pytest.approx(19.5, abs=1.0)
    assert abs(near["bearing_deg"] - 270) <= 5 and near["approaching"] is True
    assert near["closing_kmh"] == pytest.approx(40.0, abs=1.0)
    assert res["now"] == {"class": "none", "max_dbz": None}
    assert res["motion"] == {"speed_kmh": 40.0, "heading_deg": 90}


def test_storm_moving_away_gives_no_eta_but_is_reported():
    u, v = uniform(40.0)
    res = point_nowcast(cell(0, 9), u, v, G, LAT, LON)  # east of the point, also moving east
    assert res["eta_rain"] is None and res["eta_storm"] is None
    assert res["nearest"]["approaching"] is False
    assert abs(res["nearest"]["bearing_deg"] - 90) <= 5
    assert res["nearest"]["closing_kmh"] < 0


def test_point_inside_echo_is_now():
    u, v = uniform(10.0)
    field = np.full(G.shape, np.nan, np.float32)
    field[IY - 2 : IY + 3, IX - 2 : IX + 3] = 34.0
    res = point_nowcast(field, u, v, G, LAT, LON)
    assert res["now"] == {"class": "moderate", "max_dbz": 34.0}
    assert res["eta_rain"]["minutes"] == 0 and res["eta_rain"]["class"] == "moderate"
    assert res["eta_storm"] is None
    field[IY, IX] = 47.0
    res = point_nowcast(field, u, v, G, LAT, LON)
    assert res["now"]["class"] == "thunderstorm"
    assert res["eta_storm"]["minutes"] == 0 and res["eta_storm"]["minutes_range"][0] == 0


def test_empty_field_is_all_none():
    u, v = uniform(0.0)
    res = point_nowcast(np.full(G.shape, np.nan, np.float32), u, v, G, LAT, LON)
    assert res["now"] == {"class": "none", "max_dbz": None}
    assert res["eta_rain"] is None and res["eta_storm"] is None and res["nearest"] is None
    assert res["motion"] == {"speed_kmh": 0.0, "heading_deg": None}


def test_cells_outside_radar_coverage_are_ignored():
    u, v = uniform(40.0)
    covered = np.ones(G.shape, bool)
    covered[:, : IX - 5] = False  # the storm at IX-9 is outside coverage
    res = point_nowcast(cell(0, -9), u, v, G, LAT, LON, covered)
    assert res["eta_storm"] is None and res["nearest"] is None


def test_nearest_ignores_echo_beyond_100_km():
    u, v = uniform(0.0)
    res = point_nowcast(cell(0, -60), u, v, G, LAT, LON)  # ~130 km west
    assert res["nearest"] is None
