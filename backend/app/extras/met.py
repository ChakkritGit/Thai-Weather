"""Days 3-10 and the extra variables, from MET Norway's Locationforecast (free, CC BY 4.0).

It does not touch the Open-Meteo quota the 2.2 km runs depend on. MET's terms are followed: an
identifying User-Agent, coordinates rounded (here to a 0.05° cell, ~5 km, which is also the cache
key), responses cached until their ``Expires`` and refreshed with ``If-Modified-Since``. For Thailand
it carries temperature, apparent temperature, humidity, dew point, sea-level pressure, cloud, fog,
clear-sky UV index, wind and a weather symbol; no gusts and no chance of rain.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime

import httpx

log = logging.getLogger(__name__)

URL = "https://api.met.no/weatherapi/locationforecast/2.0/complete"
USER_AGENT = "thai-weather.chakkritton.com https://thai-weather.chakkritton.com"
CELL = 0.05
MAX_CACHED = 3000
MIN_TTL_S, MAX_TTL_S = 900, 3 * 3600
ATTRIBUTION = {"name": "MET Norway", "url": "https://api.met.no", "license": "CC BY 4.0"}


@dataclass
class Entry:
    data: dict
    expires: float
    last_modified: str | None


def cell(lat: float, lon: float) -> tuple[float, float]:
    return round(round(lat / CELL) * CELL, 2), round(round(lon / CELL) * CELL, 2)


class MetClient:
    def __init__(self, client: httpx.Client | None = None, clock=time.time) -> None:
        self.client = client or httpx.Client(timeout=15.0, headers={"User-Agent": USER_AGENT})
        self.clock = clock
        self.cache: OrderedDict[tuple[float, float], Entry] = OrderedDict()
        self.lock = threading.Lock()

    def get(self, lat: float, lon: float) -> dict | None:
        """MET's JSON for the 0.05° cell around a point; a stale copy when MET is unreachable."""
        key = cell(lat, lon)
        now = self.clock()
        with self.lock:
            hit = self.cache.get(key)
            if hit:
                self.cache.move_to_end(key)
        if hit and hit.expires > now:
            return hit.data
        headers = {"If-Modified-Since": hit.last_modified} if hit and hit.last_modified else {}
        try:
            r = self.client.get(URL, params={"lat": f"{key[0]:.2f}", "lon": f"{key[1]:.2f}"}, headers=headers)
            if r.status_code == 304 and hit:
                data, lm = hit.data, hit.last_modified
            else:
                r.raise_for_status()
                data, lm = r.json(), r.headers.get("last-modified")
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("met.no failed for %s: %s", key, exc)
            return hit.data if hit else None
        expires = now + MIN_TTL_S
        if r.headers.get("expires"):
            try:
                expires = min(
                    now + MAX_TTL_S, max(now + MIN_TTL_S, parsedate_to_datetime(r.headers["expires"]).timestamp())
                )
            except (TypeError, ValueError):
                pass
        with self.lock:
            self.cache[key] = Entry(data, expires, lm)
            self.cache.move_to_end(key)
            while len(self.cache) > MAX_CACHED:
                self.cache.popitem(last=False)
        return data


@dataclass
class Step:
    """One MET time with the interval that follows it (1 h while available, then 6 h)."""

    time: datetime
    hours: int
    instant: dict
    symbol: str | None
    precip: float | None
    tmax: float | None
    tmin: float | None


def steps(data: dict) -> list[Step]:
    """Non-overlapping intervals: hourly while MET gives next_1_hours, then its 6-hour blocks."""
    out: list[Step] = []
    covered_until: datetime | None = None
    for ts in (data or {}).get("properties", {}).get("timeseries", []):
        t = datetime.fromisoformat(ts["time"].replace("Z", "+00:00"))
        d = ts.get("data", {})
        if covered_until and t < covered_until:
            continue
        for key, hours in (("next_1_hours", 1), ("next_6_hours", 6)):
            block = d.get(key)
            if block:
                det = block.get("details", {})
                out.append(
                    Step(
                        t,
                        hours,
                        d.get("instant", {}).get("details", {}),
                        block.get("summary", {}).get("symbol_code"),
                        det.get("precipitation_amount"),
                        det.get("air_temperature_max"),
                        det.get("air_temperature_min"),
                    )
                )
                covered_until = t + timedelta(hours=hours)
                break
    return out


def at(data: dict, when: datetime) -> dict:
    """The instant values nearest to a time (within 3 h), for the hourly extras."""
    best, gap = {}, timedelta(hours=3)
    for ts in (data or {}).get("properties", {}).get("timeseries", []):
        t = datetime.fromisoformat(ts["time"].replace("Z", "+00:00"))
        if abs(t - when) <= gap:
            best, gap = ts.get("data", {}).get("instant", {}).get("details", {}), abs(t - when)
    return best


def now_utc() -> datetime:
    return datetime.now(UTC)
