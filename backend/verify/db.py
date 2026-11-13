"""SQLite storage for archived forecasts and station observations.

The run store keeps only the last few runs, so forecasts must be archived at the
station points as they are produced; scoring happens later from this database.
All times are UTC strings ``YYYY-MM-DDTHH:MM`` (sortable as text).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY, name TEXT, lat REAL NOT NULL, lon REAL NOT NULL,
    elevation REAL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS obs (
    station TEXT NOT NULL, valid TEXT NOT NULL,
    t2m REAL, wx TEXT, rain_1h REAL,
    PRIMARY KEY (station, valid)
);
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, run_time TEXT NOT NULL, collected_at TEXT NOT NULL,
    n_stations INTEGER NOT NULL, baseline_ok INTEGER NOT NULL,
    obs_used INTEGER, obs_stations TEXT, pop_a REAL, pop_b REAL
);
CREATE TABLE IF NOT EXISTS forecasts (
    run_id TEXT NOT NULL, source TEXT NOT NULL, station TEXT NOT NULL, valid TEXT NOT NULL,
    lead_h INTEGER NOT NULL, t2m REAL, rain REAL, pop REAL,
    PRIMARY KEY (run_id, source, station, valid)
);
CREATE INDEX IF NOT EXISTS forecasts_valid ON forecasts (valid);
CREATE TABLE IF NOT EXISTS mlp_runs (
    kind TEXT NOT NULL, fitted_at TEXT NOT NULL, active INTEGER NOT NULL, reason TEXT,
    pairs INTEGER, days INTEGER, events INTEGER, metrics TEXT, curve TEXT,
    PRIMARY KEY (kind, fitted_at)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

TIME_FMT = "%Y-%m-%dT%H:%M"


def fmt_time(t: datetime) -> str:
    """UTC ``YYYY-MM-DDTHH:MM``; naive datetimes are assumed to be UTC already."""
    if t.tzinfo is not None:
        t = t.astimezone(UTC)
    return t.strftime(TIME_FMT)


def parse_time(s: str) -> datetime:
    return datetime.strptime(s, TIME_FMT).replace(tzinfo=UTC)


RUNS_COLUMNS = (
    ("obs_used", "INTEGER"),
    ("obs_stations", "TEXT"),
    ("pop_a", "REAL"),
    ("pop_b", "REAL"),
    ("temp_bias", "TEXT"),  # the learned temperature correction the run applied per station and hour (JSON)
    ("pop_raw", "TEXT"),  # the raw chance of rain at the stations per step (JSON), before any calibration
    ("pop_mlp", "INTEGER"),  # 1: the run's chance of rain came from the network (not invertible)
)


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after the first release to databases created earlier."""
    have = {r["name"] for r in conn.execute("PRAGMA table_info(runs)")}
    for name, decl in RUNS_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE runs ADD COLUMN {name} {decl}")


def connect(path: str | Path) -> sqlite3.Connection:
    """Open (creating if needed) the verification database. Idempotent."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()
    return conn


def upsert_station(
    conn: sqlite3.Connection, sid: str, name: str | None, lat: float, lon: float, elevation: float | None, source: str
) -> None:
    conn.execute(
        "INSERT INTO stations (id, name, lat, lon, elevation, source) VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon, "
        "elevation=excluded.elevation, source=excluded.source",
        (sid, name, lat, lon, elevation, source),
    )


def upsert_obs(conn: sqlite3.Connection, rows: list[tuple[str, str, float | None, str | None, float | None]]) -> int:
    """Insert/replace ``(station, valid, t2m, wx, rain_1h)`` rows; returns the row count."""
    conn.executemany(
        "INSERT INTO obs (station, valid, t2m, wx, rain_1h) VALUES (?,?,?,?,?) "
        "ON CONFLICT(station, valid) DO UPDATE SET t2m=excluded.t2m, wx=excluded.wx, rain_1h=excluded.rain_1h",
        rows,
    )
    return len(rows)


HISTORY_CAP = 365


def record_mlp_run(conn: sqlite3.Connection, kind: str, status: dict, replace: bool = True) -> None:
    """Append one daily refit of the 'temp' or 'rain' network (the curve only exists when it trained).
    Backfilled rows pass ``replace=False`` so they never overwrite a real row."""
    verb = "INSERT OR REPLACE" if replace else "INSERT OR IGNORE"
    metrics, curve = status.get("metrics"), status.get("curve")
    conn.execute(
        f"{verb} INTO mlp_runs (kind, fitted_at, active, reason, pairs, days, events, metrics, curve) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            kind,
            status["fitted_at"],
            1 if status.get("active") else 0,
            status.get("reason"),
            status.get("pairs"),
            status.get("days"),
            status.get("events"),
            json.dumps(metrics) if metrics else None,
            json.dumps(curve) if curve else None,
        ),
    )
    conn.commit()


def mlp_history(conn: sqlite3.Connection, kind: str, cap: int = HISTORY_CAP) -> dict:
    """The newest ``cap`` runs, oldest first, and the learning curve of the latest run that trained."""
    rows = conn.execute(
        "SELECT fitted_at, active, reason, pairs, days, events, metrics FROM mlp_runs "
        "WHERE kind=? ORDER BY fitted_at DESC LIMIT ?",
        (kind, cap),
    ).fetchall()
    history = [
        {
            "fitted_at": r["fitted_at"],
            "active": bool(r["active"]),
            "reason": r["reason"],
            "pairs": r["pairs"],
            "days": r["days"],
            "events": r["events"],
            "metrics": json.loads(r["metrics"]) if r["metrics"] else None,
        }
        for r in reversed(rows)
    ]
    c = conn.execute(
        "SELECT fitted_at, curve FROM mlp_runs WHERE kind=? AND curve IS NOT NULL ORDER BY fitted_at DESC LIMIT 1",
        (kind,),
    ).fetchone()
    curve = {"fitted_at": c["fitted_at"], **json.loads(c["curve"])} if c else None
    return {"history": history, "curve": curve}


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
