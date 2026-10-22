def test_rain_spell_start_end_and_open_ended():
    from math import nan

    from app.nowcast.nowcast import _spell

    assert _spell([nan] * 25) is None
    raining = [30.0] * 8 + [nan] * 17  # raining now, stops after 40 min
    assert _spell(raining) == {"start_min": 0, "end_min": 40, "lasts_min": 40, "open_ended": False, "horizon_min": 120}
    later = [nan] * 3 + [25.0] * 22  # arrives in 15 min and is still raining at 120
    s = _spell(later)
    assert s["start_min"] == 15 and s["open_ended"] and s["lasts_min"] is None
