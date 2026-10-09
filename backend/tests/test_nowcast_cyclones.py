import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from app.nowcast.cyclones import (
    Cyclone,
    TrackPoint,
    category,
    fetch_active,
    haversine_km,
    parse_geometry,
    point_in_polygon,
    position_at,
    proximity,
)

DATA = Path(__file__).parent / "data"
LIST = json.loads((DATA / "gdacs_tc_list.json").read_text())
GEO = json.loads((DATA / "gdacs_tc_geometry.json").read_text())
NOW = datetime(2026, 10, 9, 7, 0, tzinfo=UTC)
BANGKOK = (13.75, 100.5)
SIMON_URL = "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=1001335&episodeid=7"


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _shifted(geo: dict, dlon: float) -> dict:
    def sh(c):
        return [round(c[0] + dlon, 4), c[1]] if isinstance(c[0], int | float) else [sh(x) for x in c]

    out = copy.deepcopy(geo)
    for f in out["features"]:
        f["geometry"]["coordinates"] = sh(f["geometry"]["coordinates"])
    return out


def _simon() -> Cyclone:
    track, zones = parse_geometry(GEO, datetime(2026, 10, 7, 15, tzinfo=UTC))
    return Cyclone("1001335-7", "Simon", "NOAA", 222.2, "TY", track, zones)


def test_parses_track_with_times_classes_and_forecast_flags():
    track, zones = parse_geometry(GEO, datetime(2026, 10, 7, 15, tzinfo=UTC))
    assert len(track) == 14
    assert [p.time for p in track] == sorted(p.time for p in track)
    assert track[0].time == datetime(2026, 10, 7, 15, 0, tzinfo=UTC)
    assert track[-1].time == datetime(2026, 10, 13, 0, 0, tzinfo=UTC)
    assert (track[6].lat, track[6].lon) == pytest.approx((15.6, 110.0), abs=0.01)  # 09/10 03:00 = latest fix
    assert [p.forecast for p in track] == [False] * 7 + [True] * 7
    assert track[0].cls == "TS" and track[5].cls == "TS" and track[6].cls == "HU" and track[13].cls == "TD"
    assert [kmh for kmh, _ in zones] == [60, 90, 120]  # time-labelled rings are ignored
    assert all(len(ring) >= 4 for _, ring in zones)


def test_year_rollover_from_december_to_january():
    geo = {
        "features": [
            {
                "properties": {"Class": "Point_Polygon_Point_0", "polygonlabel": "31/12 18:00 UTC"},
                "geometry": {"type": "Polygon", "coordinates": [[[100, 10], [101, 10], [101, 11], [100, 10]]]},
            },
            {
                "properties": {"Class": "Point_Polygon_Point_1", "polygonlabel": "01/01 06:00 UTC"},
                "geometry": {"type": "Polygon", "coordinates": [[[100, 12], [101, 12], [101, 13], [100, 12]]]},
            },
        ]
    }
    track, _ = parse_geometry(geo, datetime(2025, 12, 30, 0, tzinfo=UTC))
    assert [p.time.year for p in track] == [2025, 2026]


def test_category_thresholds():
    assert [category(w) for w in (0, 62.9, 63, 117.9, 118, 250)] == ["TD", "TD", "TS", "TS", "TY", "TY"]


def test_fetch_active_keeps_only_current_events_near_thailand():
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        if "geteventlist" in request.url.path:
            return httpx.Response(200, json=LIST)
        return httpx.Response(200, json=GEO)

    found = fetch_active(_client(handler))
    assert [c.id for c in found] == ["1001335-7"]
    simon = found[0]
    assert simon.name == "Simon" and simon.source == "NOAA" and simon.category == "TY"
    assert simon.max_wind_kmh == pytest.approx(222.2)
    assert simon.report_url == "https://www.gdacs.org/report.aspx?eventid=1001335&episodeid=7&eventtype=TC"
    assert requested[1:] == [SIMON_URL]  # non-current events never trigger a geometry request


def test_far_events_are_filtered_and_bad_events_do_not_break_others():
    base = LIST["features"][0]
    near_but_far_track = copy.deepcopy(base)  # claims to be near, but its track is in Mexico
    near_but_far_track["properties"].update(eventid=2, url={"geometry": "https://evil.test/far", "report": "r"})
    broken = copy.deepcopy(base)
    broken["properties"].update(eventid=3, url={"geometry": "https://evil.test/broken", "report": "r"})
    far_centroid = copy.deepcopy(base)  # list position in Mexico: prefiltered without a geometry request
    far_centroid["geometry"]["coordinates"] = [-104.6, 15.6]
    far_centroid["properties"].update(eventid=4, url={"geometry": "https://evil.test/never", "report": "r"})
    listing = {"features": [broken, near_but_far_track, far_centroid, base]}
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        if "geteventlist" in request.url.path:
            return httpx.Response(200, json=listing)
        assert request.url.host == "www.gdacs.org"  # URLs from the feed are never followed
        event = request.url.params["eventid"]
        if event == "3":
            return httpx.Response(500)
        if event == "2":
            return httpx.Response(200, json=_shifted(GEO, -214.6))
        assert event != "4", "prefiltered event must not be fetched"
        return httpx.Response(200, json=GEO)

    assert [c.id for c in fetch_active(_client(handler))] == ["1001335-7"]
    assert not any("eventid=4" in u for u in requested)
    assert not any("evil.test" in u for u in requested)


def test_event_list_failure_raises():
    with pytest.raises(httpx.HTTPStatusError):
        fetch_active(_client(lambda r: httpx.Response(503)))


def test_point_in_polygon():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert point_in_polygon(5, 5, square)
    assert not point_in_polygon(11, 5, square) and not point_in_polygon(5, -1, square)
    concave = [(0, 0), (10, 0), (10, 10), (5, 4), (0, 10)]
    assert point_in_polygon(2, 2, concave) and not point_in_polygon(5, 8, concave)


def _straight_track() -> Cyclone:
    t0 = datetime(2026, 10, 9, 0, tzinfo=UTC)
    track = [TrackPoint(t0, 10.0, 95.0, False, "TS"), TrackPoint(t0 + timedelta(hours=20), 10.0, 105.0, True, "TS")]
    return Cyclone("x", "Test", "JTWC", 90.0, "TS", track)


def test_closest_approach_on_a_straight_track():
    cy = _straight_track()
    t0 = cy.track[0].time
    res = proximity(cy, 13.0, 100.0, t0)
    assert res["closest"]["distance_km"] == pytest.approx(haversine_km(10.0, 100.0, 13.0, 100.0), abs=0.5)  # ~333.6
    assert res["closest"]["hours"] == pytest.approx(10.0, abs=0.1)
    assert res["closest"]["time"] == (t0 + timedelta(hours=10)).isoformat()
    assert res["distance_now_km"] == pytest.approx(haversine_km(10.0, 95.0, 13.0, 100.0), abs=0.5)
    assert res["in_wind_zone_kmh"] is None
    later = proximity(cy, 13.0, 100.0, t0 + timedelta(hours=15))  # already past the closest point
    assert later["closest"]["hours"] == 0.0
    assert later["closest"]["distance_km"] == pytest.approx(later["distance_now_km"], abs=0.5)
    assert position_at(cy, t0 + timedelta(hours=10)) == pytest.approx((10.0, 100.0))


def test_wind_zone_uses_the_strongest_swath_containing_the_point():
    simon = _simon()
    on_track = simon.track[9]  # inside all three swaths
    assert proximity(simon, on_track.lat, on_track.lon, NOW)["in_wind_zone_kmh"] == 120
    res = proximity(simon, *BANGKOK, NOW)
    assert res["in_wind_zone_kmh"] is None
    assert res["distance_now_km"] > 900 and res["closest"]["distance_km"] >= 900
    assert res["closest"]["hours"] > 0
    assert res["distance_now_km"] == pytest.approx(haversine_km(*position_at(simon, NOW), *BANGKOK), abs=0.1)


def _run(geo: dict, wind: float, **props) -> list[Cyclone]:
    feat = copy.deepcopy(LIST["features"][0])
    feat["properties"].update({"severitydata": {"severity": wind}, **props})

    def handler(request: httpx.Request) -> httpx.Response:
        if "geteventlist" in request.url.path:
            return httpx.Response(200, json={"features": [feat]})
        return httpx.Response(200, json=geo)

    return fetch_active(_client(handler))


def _relabel(label: str) -> dict:
    geo = copy.deepcopy(GEO)
    for f in geo["features"]:
        if f["properties"].get("Class", "").startswith("Line"):
            f["properties"]["polygonlabel"] = label
    return geo


def test_category_is_current_intensity_and_peak_is_separate():
    (c,) = _run(_relabel("TS"), 150.0)  # currently a tropical storm, forecast peak 150 km/h
    assert (c.category, c.peak_category) == ("TS", "TY")
    (c,) = _run(GEO, 150.0)  # latest observed fix is hurricane class
    assert (c.category, c.peak_category) == ("TY", "TY")
    (c,) = _run(_relabel("TD"), 40.0)
    assert (c.category, c.peak_category) == ("TD", "TD")
    (c,) = _run(_relabel(""), 80.0)  # unknown class falls back to the wind
    assert (c.category, c.peak_category) == ("TS", "TS")


def test_junk_event_ids_skip_the_event():
    assert _run(GEO, 100.0, eventid="1001335/../x") == []
