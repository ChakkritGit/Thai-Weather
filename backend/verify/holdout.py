"""Stable hold-out set of stations kept out of the live station correction.

The app can assimilate METAR temperatures (``push``), but a station that was
fed into the correction is no longer an independent test of it.  About one
station in four is therefore chosen once, spread from north to south, stored in
the database and never changed: stations that appear later are assimilated and
never silently join the hold-out, so scores of the hold-out group stay
comparable over time.
"""

from __future__ import annotations

import sqlite3

from . import db

META_KEY = "holdout"


def load(conn: sqlite3.Connection) -> set[str]:
    """The stored hold-out ids; empty when none has been chosen yet."""
    value = db.get_meta(conn, META_KEY)
    return {s for s in value.split(",") if s} if value else set()


def ensure(conn: sqlite3.Connection, every: int = 4) -> set[str]:
    """Return the stored hold-out set, choosing and storing it on first use."""
    if db.get_meta(conn, META_KEY) is not None:
        return load(conn)
    rows = conn.execute("SELECT id FROM stations WHERE source='iem' ORDER BY lat, id").fetchall()
    chosen = {r["id"] for i, r in enumerate(rows) if i % every == every // 2}
    if chosen:  # nothing to store before the station list exists
        db.set_meta(conn, META_KEY, ",".join(sorted(chosen)))
        conn.commit()
    return chosen
