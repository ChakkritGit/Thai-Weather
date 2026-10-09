"""Push subscription storage (SQLite) and the validation applied before anything is stored.

Only coarse coordinates are kept (rounded to 0.01 deg, ~1 km) and no account or identity: a
subscription is identified by a random id and authorised by its own push endpoint + auth secret.
"""

from __future__ import annotations

import hmac
import json
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

MAX_SUBSCRIPTIONS = 5000
MAX_ENDPOINT_LEN = 600
MAX_LABEL_LEN = 60
COORD_DECIMALS = 2

# Push services browsers use.  Anything else is rejected so the server never POSTs to an arbitrary host.
ALLOWED_HOSTS = ("fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com")
ALLOWED_SUFFIXES = (".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com")


class PushError(Exception):
    """Raised for rejected requests; ``status`` is the HTTP status the API should answer with."""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.status = status


def validate_endpoint(endpoint: str) -> str:
    if len(endpoint) > MAX_ENDPOINT_LEN:
        raise PushError("endpoint too long")
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError:
        raise PushError("invalid endpoint") from None
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or port not in (None, 443):
        raise PushError("endpoint must be a plain https URL")
    if host not in ALLOWED_HOSTS and not host.endswith(ALLOWED_SUFFIXES):
        raise PushError("unsupported push service")
    return endpoint


@dataclass(frozen=True)
class Prefs:
    storm: bool = True
    heavy_rain: bool = True
    cyclone: bool = True
    quiet_start: int = 22  # local (Asia/Bangkok) hour; quiet when start <= hour < end (wraps midnight)
    quiet_end: int = 6


@dataclass
class Subscription:
    id: str
    endpoint: str
    p256dh: str
    auth: str
    lat: float
    lon: float
    label: str
    prefs: Prefs
    created: float
    last_seen: float
    last_sent: dict[str, list[float]] = field(default_factory=dict)  # alert key -> [unix time, tier]

    def info(self) -> dict:
        """The ``subscription_info`` structure pywebpush expects."""
        return {"endpoint": self.endpoint, "keys": {"p256dh": self.p256dh, "auth": self.auth}}


_SCHEMA = """
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created REAL NOT NULL,
    last_seen REAL NOT NULL,
    storm INTEGER NOT NULL DEFAULT 1,
    heavy_rain INTEGER NOT NULL DEFAULT 1,
    cyclone INTEGER NOT NULL DEFAULT 1,
    quiet_start INTEGER NOT NULL DEFAULT 22,
    quiet_end INTEGER NOT NULL DEFAULT 6,
    last_sent TEXT NOT NULL DEFAULT '{}',
    last_test REAL NOT NULL DEFAULT 0
)
"""


def _row(r: sqlite3.Row) -> Subscription:
    return Subscription(
        id=r["id"],
        endpoint=r["endpoint"],
        p256dh=r["p256dh"],
        auth=r["auth"],
        lat=r["lat"],
        lon=r["lon"],
        label=r["label"],
        prefs=Prefs(bool(r["storm"]), bool(r["heavy_rain"]), bool(r["cyclone"]), r["quiet_start"], r["quiet_end"]),
        created=r["created"],
        last_seen=r["last_seen"],
        last_sent=json.loads(r["last_sent"] or "{}"),
    )


def auth_matches(sub: Subscription, auth: str) -> bool:
    return hmac.compare_digest(sub.auth.encode(), auth.encode())


class SubscriptionStore:
    def __init__(self, directory: Path | str, limit: int = MAX_SUBSCRIPTIONS) -> None:
        path = Path(directory)
        path.mkdir(parents=True, exist_ok=True)
        self.limit = limit
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path / "subscriptions.sqlite", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute(_SCHEMA)
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def count(self) -> int:
        with self._lock:
            return int(self._db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0])

    def all(self) -> list[Subscription]:
        with self._lock:
            return [_row(r) for r in self._db.execute("SELECT * FROM subscriptions")]

    def by_endpoint(self, endpoint: str) -> Subscription | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM subscriptions WHERE endpoint = ?", (endpoint,)).fetchone()
        return _row(r) if r else None

    def upsert(
        self, endpoint: str, p256dh: str, auth: str, lat: float, lon: float, label: str, prefs: Prefs
    ) -> Subscription:
        """Create a subscription, or update the one with this endpoint when the auth secret matches."""
        lat, lon = round(lat, COORD_DECIMALS), round(lon, COORD_DECIMALS)
        label = label.strip()[:MAX_LABEL_LEN]
        now = time.time()
        with self._lock:
            r = self._db.execute("SELECT * FROM subscriptions WHERE endpoint = ?", (endpoint,)).fetchone()
            if r is not None:
                if not hmac.compare_digest(r["auth"].encode(), auth.encode()):
                    raise PushError("subscription belongs to different credentials", 403)
                self._db.execute(
                    "UPDATE subscriptions SET p256dh=?, lat=?, lon=?, label=?, last_seen=?, storm=?, heavy_rain=?,"
                    " cyclone=?, quiet_start=?, quiet_end=?, last_sent=CASE WHEN lat!=? OR lon!=? THEN '{}' ELSE last_sent END"
                    " WHERE id=?",
                    (p256dh, lat, lon, label, now, prefs.storm, prefs.heavy_rain, prefs.cyclone, prefs.quiet_start,
                     prefs.quiet_end, lat, lon, r["id"]),
                )  # fmt: skip
                self._db.commit()
                sub_id = r["id"]
            else:
                if int(self._db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]) >= self.limit:
                    raise PushError("subscription limit reached", 503)
                sub_id = secrets.token_urlsafe(16)
                self._db.execute(
                    "INSERT INTO subscriptions (id, endpoint, p256dh, auth, lat, lon, label, created, last_seen, storm,"
                    " heavy_rain, cyclone, quiet_start, quiet_end) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (sub_id, endpoint, p256dh, auth, lat, lon, label, now, now, prefs.storm, prefs.heavy_rain,
                     prefs.cyclone, prefs.quiet_start, prefs.quiet_end),
                )  # fmt: skip
                self._db.commit()
            row = self._db.execute("SELECT * FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()
        return _row(row)

    def delete(self, sub_id: str) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM subscriptions WHERE id = ?", (sub_id,))
            self._db.commit()
            return cur.rowcount > 0

    def record_sent(self, sub_id: str, key: str, when: float, tier: int) -> None:
        with self._lock:
            r = self._db.execute("SELECT last_sent FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()
            if r is None:
                return
            sent = json.loads(r["last_sent"] or "{}")
            sent[key] = [when, tier]
            horizon = when - 7 * 86400  # forget alert keys (e.g. finished cyclones) after a week
            sent = {k: v for k, v in sent.items() if v[0] >= horizon}
            self._db.execute("UPDATE subscriptions SET last_sent = ? WHERE id = ?", (json.dumps(sent), sub_id))
            self._db.commit()

    def claim_test(self, sub_id: str, now: float, min_interval: float = 60.0) -> float:
        """Reserve a test notification; returns 0 when allowed, else the seconds still to wait."""
        with self._lock:
            r = self._db.execute("SELECT last_test FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()
            if r is None:
                return 0.0
            wait = min_interval - (now - r["last_test"])
            if wait > 0:
                return wait
            self._db.execute("UPDATE subscriptions SET last_test = ? WHERE id = ?", (now, sub_id))
            self._db.commit()
            return 0.0
