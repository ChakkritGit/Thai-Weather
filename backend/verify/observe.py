"""Station observations: IEM METAR archive and generic CSV import.

Thai METARs report whole degrees C and present-weather codes but no rain
amounts, so rain is verified as *occurrence* (``is_rain``).  Times are stored as
UTC ``YYYY-MM-DDTHH:MM`` with the minute kept, because routine reports arrive at
:00/:30 and specials at arbitrary minutes.
"""

from __future__ import annotations

import csv
import io
import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from . import db

log = logging.getLogger(__name__)

IEM_ASOS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
MAX_SPAN_DAYS = 31
DEFAULT_LOOKBACK = timedelta(days=3)
OVERLAP = timedelta(hours=6)  # late/corrected reports are re-fetched and upserted

# Present-weather descriptors/phenomena that mean precipitation at the station.
PRECIP_CODES = ("RA", "DZ", "GR", "GS", "PL", "SN", "UP")


def is_rain(wx: str | None, rain_1h: float | None = None) -> bool | None:
    """Did it rain at the station? ``None`` when nothing is known about precipitation.

    ``VC*`` tokens (vicinity, 5-10 km away) are excluded; an empty weather field
    on an existing report means "no significant weather" and is a clear *False*.
    """
    if rain_1h is not None and rain_1h > 0:
        return True
    if wx is None:
        return None if rain_1h is None else False
    for token in wx.split():
        token = token.lstrip("+-")
        if token.startswith("VC"):
            continue
        if any(code in token for code in PRECIP_CODES):
            return True
    return False


def _float(s: str | None) -> float | None:
    if s is None:
        return None
    s = s.strip()
    if s in ("", "M"):
        return None
    if s == "T":  # trace
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


def parse_iem_csv(
    text: str, known: set[str] | None = None
) -> list[tuple[str, str, float | None, str | None, float | None]]:
    """Parse an IEM ``format=onlycomma`` response into ``obs`` rows."""
    rows: list[tuple[str, str, float | None, str | None, float | None]] = []
    for rec in csv.DictReader(io.StringIO(text)):
        sid = (rec.get("station") or "").strip()
        valid = (rec.get("valid") or "").strip()
        if not sid or not valid or (known is not None and sid not in known):
            continue
        try:
            t = datetime.strptime(valid, "%Y-%m-%d %H:%M")
        except ValueError:
            continue
        t2m = _float(rec.get("tmpc"))
        p01 = _float(rec.get("p01m"))
        wx_raw = (rec.get("wxcodes") or "").strip()
        # a report with a temperature but no weather code = "no significant weather"
        wx = None if wx_raw == "M" else wx_raw
        if wx is None and t2m is not None:
            wx = ""
        if t2m is None and wx is None and p01 is None:
            continue
        rows.append((sid, db.fmt_time(t), t2m, wx, p01))
    return rows


def fetch_iem(
    conn: sqlite3.Connection,
    client: httpx.Client,
    start: datetime | None = None,
    end: datetime | None = None,
) -> int:
    """Download observations for ``[start, end]`` (UTC) and upsert them; returns rows written."""
    end = (end or datetime.now(UTC)).astimezone(UTC)
    if start is None:
        last = conn.execute("SELECT MAX(valid) AS v FROM obs").fetchone()["v"]
        start = db.parse_time(last) - OVERLAP if last else end - DEFAULT_LOOKBACK
    start = start.astimezone(UTC)
    known = {r["id"] for r in conn.execute("SELECT id FROM stations WHERE source='iem'")} or None

    written = 0
    day = start.date()
    last_day = end.date()
    while day <= last_day:
        chunk_end = min(day + timedelta(days=MAX_SPAN_DAYS - 1), last_day)
        upper = chunk_end + timedelta(days=1)  # IEM's end date is exclusive
        params = [
            ("network", "TH__ASOS"),
            ("data", "tmpc"),
            ("data", "wxcodes"),
            ("data", "p01m"),
            ("tz", "Etc/UTC"),
            ("format", "onlycomma"),
            ("missing", "M"),
            ("trace", "T"),
            ("report_type", "3"),
            ("report_type", "4"),
            ("year1", str(day.year)),
            ("month1", str(day.month)),
            ("day1", str(day.day)),
            ("year2", str(upper.year)),
            ("month2", str(upper.month)),
            ("day2", str(upper.day)),
        ]
        r = client.get(IEM_ASOS_URL, params=params)
        r.raise_for_status()
        rows = parse_iem_csv(r.text, known)
        written += db.upsert_obs(conn, rows)
        day = chunk_end + timedelta(days=1)
    conn.commit()
    log.info("observations: %d rows upserted since %s", written, db.fmt_time(start))
    return written


def import_csv(conn: sqlite3.Connection, path: str | Path) -> int:
    """Import ``station_id,time,lat,lon,elevation,t2m[,rain_1h]`` (time = ISO-8601 *with* timezone)."""
    stations: dict[str, tuple[float, float, float | None]] = {}
    rows: list[tuple[str, str, float | None, str | None, float | None]] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = {"station_id", "time", "lat", "lon", "elevation", "t2m"} - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"CSV is missing columns: {', '.join(sorted(missing))}")
        for rec in reader:
            line = reader.line_num
            try:
                t = datetime.fromisoformat((rec["time"] or "").strip())
            except ValueError as exc:
                raise ValueError(f"line {line}: bad time {rec['time']!r}") from exc
            if t.tzinfo is None:
                raise ValueError(f"line {line}: time {rec['time']!r} has no timezone (use e.g. 2026-10-09T07:00+07:00)")
            sid = (rec["station_id"] or "").strip()
            if not sid:
                raise ValueError(f"line {line}: empty station_id")
            lat, lon = _float(rec["lat"]), _float(rec["lon"])
            if lat is None or lon is None:
                raise ValueError(f"line {line}: lat/lon required")
            stations[sid] = (lat, lon, _float(rec["elevation"]))
            rows.append((sid, db.fmt_time(t), _float(rec["t2m"]), None, _float(rec.get("rain_1h"))))
    for sid, (lat, lon, elev) in stations.items():
        db.upsert_station(conn, sid, sid, lat, lon, elev, "csv")
    n = db.upsert_obs(conn, rows)
    conn.commit()
    return n
