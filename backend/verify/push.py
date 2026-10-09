"""Feed the latest METAR temperatures into the app's station correction.

Every cycle the newest report of each *assimilated* station (everything except
the hold-out set, see :mod:`verify.holdout`) is posted to
``POST /api/v1/observations``.  The app buffers them and, at the start of the
next forecast run, uses the report closest to the run start per station.
Pushing every ~15 min guarantees fresh reports in that +-90 min window whatever
minute the run starts at.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import UTC, datetime, timedelta

import httpx

from . import db, holdout

log = logging.getLogger(__name__)

T_MIN, T_MAX = -30.0, 60.0  # the API's validation range for t2m


def push(
    conn: sqlite3.Connection,
    api: httpx.Client,
    token: str | None,
    max_age_min: int = 120,
    now: datetime | None = None,
) -> int:
    """POST the latest recent report per assimilated station; returns the number accepted."""
    now = (now or datetime.now(UTC)).astimezone(UTC)
    cutoff = db.fmt_time(now - timedelta(minutes=max_age_min))
    held_out = holdout.load(conn)
    rows = conn.execute(
        "SELECT s.id, s.lat, s.lon, s.elevation, o.valid, o.t2m FROM stations s "
        "JOIN obs o ON o.station = s.id AND o.t2m IS NOT NULL AND o.valid >= ? "
        "AND o.valid = (SELECT MAX(valid) FROM obs WHERE station = s.id AND t2m IS NOT NULL) "
        "ORDER BY s.id",
        (cutoff,),
    ).fetchall()
    payload = [
        {
            "station_id": r["id"],
            "lat": r["lat"],
            "lon": r["lon"],
            "time": db.parse_time(r["valid"]).isoformat(),
            "t2m": r["t2m"],
            "elevation": r["elevation"],
        }
        for r in rows
        if r["id"] not in held_out and T_MIN <= r["t2m"] <= T_MAX
    ]
    if not payload:
        log.info("push: nothing to send")
        return 0
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = api.post("/api/v1/observations", json=payload, headers=headers)
    if resp.status_code != 200:
        log.error("push: API rejected %d observations (HTTP %d): %s", len(payload), resp.status_code, resp.text)
        return 0
    accepted = int(resp.json().get("accepted", 0))
    log.info("push: %d observations accepted (%d stations held out)", accepted, len(held_out))
    return accepted
