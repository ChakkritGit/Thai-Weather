"""Tropical cyclones from GDACS: active storms near Thailand and how they relate to a point.

GDACS (UN/EC Global Disaster Alert and Coordination System) republishes JTWC / NOAA / RSMC
advisories as GeoJSON.  Two endpoints are used: the event list (``iscurrent``, peak wind) and,
per event, a geometry collection holding

* ``Point_Polygon_Point_N`` - one small ring per track point, labelled ``"DD/MM HH:MM UTC"``
  (the track point is the ring's mean; the label has no year, so the event's ``fromdate`` gives it);
* ``Line_Line_N`` - one segment per pair of consecutive track points, labelled with the storm
  class (TD/TS/TY/HU/...) and a ``forecast`` flag; the class and flag are copied onto the
  *later* point of the segment;
* ``Poly_Green/Orange/Red`` labelled ``"60 km/h"`` / ``"90 km/h"`` / ``"120 km/h"`` - the wind
  swaths of the whole track.  Rings labelled with a time instead are ignored.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import NamedTuple

import httpx
import numpy as np

log = logging.getLogger(__name__)

LIST_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC"
GEOMETRY_URL = "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry"  # fixed: never follow URLs from the feed
REPORT_URL = "https://www.gdacs.org/report.aspx"
CENTRE = (13.0, 101.5)  # lat, lon - roughly the middle of Thailand
RADIUS_KM = 1500.0
PREFILTER_KM = 5000.0  # skip the geometry request for storms whose current position is this far away
EARTH_KM = 6371.0
TD_MAX_KMH = 63.0  # < 63 tropical depression, 63-117 tropical storm, >= 118 typhoon
TS_MAX_KMH = 118.0

_TIME_LABEL = re.compile(r"^(\d{2})/(\d{2}) (\d{2}):(\d{2})")
_ZONE_LABEL = re.compile(r"^(\d+) km/h$")
_NAME_YEAR = re.compile(r"-\d{2}$")


class TrackPoint(NamedTuple):
    time: datetime
    lat: float
    lon: float
    forecast: bool
    cls: str  # TD / TS / TY / HU / ... as published by GDACS ("" when unknown)


@dataclass
class Cyclone:
    id: str
    name: str
    source: str
    max_wind_kmh: float  # GDACS peak wind of the event (may include the forecast), not the current wind
    category: str  # CURRENT intensity "TD" | "TS" | "TY" (latest observed track point)
    track: list[TrackPoint]
    zones: list[tuple[int, list[tuple[float, float]]]] = field(default_factory=list)  # (km/h, ring of (lon, lat))
    report_url: str | None = None
    peak_category: str = ""  # category of max_wind_kmh (forecast peak); defaults to `category`

    def __post_init__(self) -> None:
        if not self.peak_category:
            self.peak_category = self.category


def category(max_wind_kmh: float) -> str:
    if max_wind_kmh < TD_MAX_KMH:
        return "TD"
    return "TS" if max_wind_kmh < TS_MAX_KMH else "TY"


_TY_FAMILY = {"TY", "STY", "HU", "MH", "SUPERTY", "SUPER TY"}


def current_category(track: list[TrackPoint]) -> str | None:
    """Category of the latest non-forecast track point (None when its class is unknown)."""
    observed = [p for p in track if not p.forecast and p.cls]
    if not observed:
        return None
    cls = observed[-1].cls.upper()
    if cls in ("TD", "TS"):
        return cls
    return "TY" if cls in _TY_FAMILY else None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def point_in_polygon(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    """Ray casting; ``ring`` is a list of (lon, lat) (closed or not)."""
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


# --------------------------------------------------------------------- parsing
def _parse_time(label: str, start: datetime) -> datetime | None:
    m = _TIME_LABEL.match(label)
    if not m:
        return None
    day, month, hour, minute = (int(g) for g in m.groups())
    year = start.year + (1 if month < start.month else 0)  # Dec -> Jan rollover
    try:
        return datetime(year, month, day, hour, minute, tzinfo=UTC)
    except ValueError:
        return None


def _ring_centre(ring: list[list[float]]) -> tuple[float, float]:
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)  # lat, lon


def parse_geometry(geo: dict, start: datetime) -> tuple[list[TrackPoint], list[tuple[int, list[tuple[float, float]]]]]:
    """Track (time-ordered) and wind-swath polygons from a GDACS geometry collection."""
    raw_points: list[tuple[datetime, float, float]] = []
    lines: list[tuple[list[float], list[float], str, bool]] = []
    zones: list[tuple[int, list[tuple[float, float]]]] = []
    for feat in geo.get("features", []):
        props, geom = feat.get("properties", {}), feat.get("geometry") or {}
        kind, label = str(props.get("Class", "")), str(props.get("polygonlabel", ""))
        if kind.startswith("Point_Polygon"):
            t = _parse_time(label, start)
            if t is not None and geom.get("coordinates"):
                lat, lon = _ring_centre(geom["coordinates"][0])
                raw_points.append((t, lat, lon))
        elif kind.startswith("Line") and len(geom.get("coordinates", [])) >= 2:
            (a, b) = geom["coordinates"][0], geom["coordinates"][-1]
            lines.append((a, b, label, bool(props.get("forecast", False))))
        elif kind.startswith("Poly_") and (m := _ZONE_LABEL.match(label)) and geom.get("coordinates"):
            zones.append((int(m.group(1)), [(float(x), float(y)) for x, y in geom["coordinates"][0]]))
    raw_points.sort()
    cls = [""] * len(raw_points)
    fcst = [False] * len(raw_points)

    def nearest(c: list[float]) -> int | None:
        if not raw_points:
            return None
        d = [abs(p[1] - c[1]) + abs(p[2] - c[0]) for p in raw_points]
        i = int(np.argmin(d))
        return i if d[i] < 0.6 else None

    for a, b, label, forecast in lines:
        ia, ib = nearest(a), nearest(b)
        if ia is None or ib is None or ia == ib:
            continue
        lo, hi = min(ia, ib), max(ia, ib)
        cls[hi], fcst[hi] = label, forecast
        if lo == 0 and not cls[0]:  # the first point has no incoming segment: borrow the outgoing one
            cls[0] = label
    track = [TrackPoint(t, lat, lon, fcst[i], cls[i]) for i, (t, lat, lon) in enumerate(raw_points)]
    return track, sorted(zones, key=lambda z: z[0])


def _display_name(event_name: str) -> str:
    return _NAME_YEAR.sub("", event_name).strip().title() or event_name


def _min_distance_km(track: list[TrackPoint], centre: tuple[float, float]) -> float:
    return min((haversine_km(p.lat, p.lon, *centre) for p in track), default=float("inf"))


def fetch_active(
    client: httpx.Client,
    centre: tuple[float, float] = CENTRE,
    radius_km: float = RADIUS_KM,
    list_url: str = LIST_URL,
) -> list[Cyclone]:
    """Current cyclones with a track point within ``radius_km`` of ``centre``.

    A failing or malformed event is logged and skipped; only a failing event *list* raises.
    """
    resp = client.get(list_url)
    resp.raise_for_status()
    out: list[Cyclone] = []
    for feat in resp.json().get("features", []):
        props = feat.get("properties", {})
        if str(props.get("iscurrent", "")).lower() != "true":
            continue
        eid = f"{props.get('eventid')}-{props.get('episodeid')}"
        try:
            lon, lat = feat["geometry"]["coordinates"][:2]
            if haversine_km(lat, lon, *centre) > PREFILTER_KM:
                continue
            event_id, episode_id = int(props["eventid"]), int(props["episodeid"])  # junk raises -> event skipped
            geo_resp = client.get(
                GEOMETRY_URL, params={"eventtype": "TC", "eventid": event_id, "episodeid": episode_id}
            )
            geo_resp.raise_for_status()
            start = datetime.fromisoformat(props["fromdate"]).replace(tzinfo=UTC)
            track, zones = parse_geometry(geo_resp.json(), start)
            if not track or _min_distance_km(track, centre) > radius_km:
                continue
            wind = float(props["severitydata"]["severity"])
            out.append(
                Cyclone(
                    id=eid,
                    name=_display_name(str(props.get("eventname", ""))),
                    source=str(props.get("source", "")),
                    max_wind_kmh=round(wind, 1),
                    category=current_category(track) or category(wind),
                    peak_category=category(wind),
                    track=track,
                    zones=zones,
                    report_url=f"{REPORT_URL}?eventid={event_id}&episodeid={episode_id}&eventtype=TC",
                )
            )
        except Exception:
            log.exception("skipping GDACS event %s", eid)
    return out


# ------------------------------------------------------------------- proximity
def _densify(track: list[TrackPoint], now: datetime, steps: int = 48) -> list[tuple[datetime, float, float]]:
    """Track positions from ``now`` onward, linearly interpolated (``steps`` samples per segment)."""
    if now <= track[0].time:
        pts = [(track[0].time, track[0].lat, track[0].lon)]
        rest = track[1:]
    else:
        pos = _position(track, now)
        pts = [(now, *pos)]
        rest = [p for p in track if p.time > now]
    out = list(pts)
    prev = pts[-1]
    for p in rest:
        for k in range(1, steps + 1):
            f = k / steps
            out.append(
                (prev[0] + (p.time - prev[0]) * f, prev[1] + (p.lat - prev[1]) * f, prev[2] + (p.lon - prev[2]) * f)
            )
        prev = (p.time, p.lat, p.lon)
    return out


def _position(track: list[TrackPoint], t: datetime) -> tuple[float, float]:
    """Interpolated (lat, lon) at ``t``; clamped to the track ends."""
    if t <= track[0].time:
        return track[0].lat, track[0].lon
    for a, b in zip(track, track[1:], strict=False):
        if a.time <= t <= b.time:
            span = (b.time - a.time).total_seconds()
            f = (t - a.time).total_seconds() / span if span else 0.0
            return a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f
    return track[-1].lat, track[-1].lon


def proximity(cyclone: Cyclone, lat: float, lon: float, now: datetime) -> dict:
    """Where the storm is relative to a point.

    ``closest`` is the nearest approach from ``now`` on (so ``hours`` >= 0; 0 means the storm
    is as close as it will get, i.e. it is moving away).  ``in_wind_zone_kmh`` is the strongest
    forecast wind swath (60/90/120 km/h) that contains the point, or None.
    """
    here = _position(cyclone.track, now)
    samples = _densify(cyclone.track, now)
    dists = [haversine_km(la, lo, lat, lon) for _, la, lo in samples]
    best = int(np.argmin(dists))
    zone = max((kmh for kmh, ring in cyclone.zones if point_in_polygon(lon, lat, ring)), default=None)
    return {
        "distance_now_km": round(haversine_km(here[0], here[1], lat, lon), 1),
        "closest": {
            "time": samples[best][0].isoformat(),
            "hours": round(max((samples[best][0] - now).total_seconds(), 0.0) / 3600.0, 1),
            "distance_km": round(dists[best], 1),
        },
        "in_wind_zone_kmh": zone,
    }


def position_at(cyclone: Cyclone, now: datetime) -> tuple[float, float]:
    """Interpolated storm centre (lat, lon) at ``now``."""
    return _position(cyclone.track, now)
