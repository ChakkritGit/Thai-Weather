"""Station list from the Iowa Environmental Mesonet (Thai airport METAR sites).

NOAA ISD stopped updating Thai stations in 2025-08, so the IEM ``TH__ASOS``
network (airport METARs) is the free, key-less observation source.  Stations
outside the forecast domain are dropped because ``/point`` would reject them.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx

from app.core.grid import LAT0, LAT1, LON0, LON1

from . import db

log = logging.getLogger(__name__)

IEM_STATIONS_URL = "https://mesonet.agron.iastate.edu/geojson/network/TH__ASOS.geojson"
META_KEY = "stations_fetched_at"


@dataclass(frozen=True)
class Station:
    id: str
    name: str
    lat: float
    lon: float
    elevation: float | None
    source: str = "iem"


def fetch_iem(client: httpx.Client) -> list[Station]:
    r = client.get(IEM_STATIONS_URL)
    r.raise_for_status()
    out: list[Station] = []
    for f in r.json().get("features", []):
        props = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates") or []
        sid = props.get("sid")
        if not sid or len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        if not (LAT0 <= lat <= LAT1 and LON0 <= lon <= LON1):
            continue
        elev = props.get("elevation")
        out.append(Station(str(sid), str(props.get("sname") or sid), lat, lon, None if elev is None else float(elev)))
    return out


def load(conn: sqlite3.Connection) -> list[Station]:
    rows = conn.execute("SELECT id, name, lat, lon, elevation, source FROM stations ORDER BY id").fetchall()
    return [Station(r["id"], r["name"], r["lat"], r["lon"], r["elevation"], r["source"]) for r in rows]


def ensure(conn: sqlite3.Connection, client: httpx.Client, max_age_days: int = 30) -> list[Station]:
    """Refresh the IEM station table when empty or older than ``max_age_days``."""
    fetched = db.get_meta(conn, META_KEY)
    has_iem = conn.execute("SELECT 1 FROM stations WHERE source='iem' LIMIT 1").fetchone() is not None
    fresh = False
    if fetched and has_iem:
        age = datetime.now(UTC) - datetime.fromisoformat(fetched)
        fresh = age < timedelta(days=max_age_days)
    if not fresh:
        try:
            stations = fetch_iem(client)
        except (httpx.HTTPError, ValueError):
            if not has_iem:
                raise
            log.warning("could not refresh IEM station list; using cached one", exc_info=True)
        else:
            for s in stations:
                db.upsert_station(conn, s.id, s.name, s.lat, s.lon, s.elevation, s.source)
            db.set_meta(conn, META_KEY, datetime.now(UTC).isoformat())
            conn.commit()
            log.info("stored %d IEM stations", len(stations))
    return load(conn)
