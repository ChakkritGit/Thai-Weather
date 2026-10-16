"""PM2.5 now, from the Pollution Control Department's Air4Thai stations (about 170 across Thailand).

One request returns every station's latest hour; it is refreshed in the background every 20 minutes
and a point gets the nearest station within 50 km whose reading is under 6 hours old. Levels and
colours are the PCD's (Thai AQI). Air4Thai's server does not send its intermediate certificate, so
the client trusts that chain explicitly (Let's Encrypt YR1 and its root, in app/data) on top of the
usual roots; verification stays on.
"""

from __future__ import annotations

import logging
import math
import ssl
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import certifi
import httpx

from ..core.static import DATA_DIR

log = logging.getLogger(__name__)

URL = "https://air4thai.pcd.go.th/services/getNewAQI_JSON.php"
REFRESH_S = 20 * 60
MAX_KM = 50.0
MAX_AGE = timedelta(hours=6)
ATTRIBUTION = {"name": "Air4Thai, กรมควบคุมมลพิษ", "url": "https://air4thai.pcd.go.th"}
LEVELS = {
    "1": ("ดีมาก", "Very good", "#3bccff"),
    "2": ("ดี", "Good", "#92d050"),
    "3": ("ปานกลาง", "Moderate", "#ffff00"),
    "4": ("เริ่มมีผลกระทบต่อสุขภาพ", "Starting to affect health", "#ffa200"),
    "5": ("มีผลกระทบต่อสุขภาพ", "Affects health", "#f04646"),
}


@dataclass(frozen=True)
class Reading:
    station: str
    name_th: str
    name_en: str
    area_th: str
    lat: float
    lon: float
    time: datetime
    pm25: float
    aqi: int | None
    level: str


def tls_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context(cafile=certifi.where())
    ctx.load_verify_locations(cafile=str(DATA_DIR / "air4thai-chain.pem"))
    return ctx


def parse(payload: dict) -> list[Reading]:
    out = []
    for s in payload.get("stations", []):
        try:
            last = s["AQILast"]
            pm = last["PM25"]
            value = float(pm["value"])
            if value < 0:
                continue
            t = datetime.fromisoformat(f"{last['date']}T{last['time']}:00+07:00").astimezone(UTC)
            aqi = int(pm.get("aqi")) if str(pm.get("aqi", "")).lstrip("-").isdigit() and int(pm["aqi"]) >= 0 else None
            out.append(
                Reading(
                    s["stationID"],
                    s.get("nameTH", ""),
                    s.get("nameEN", ""),
                    s.get("areaTH", ""),
                    float(s["lat"]),
                    float(s["long"]),
                    t,
                    value,
                    aqi,
                    str(pm.get("color_id", "")),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


class AirService:
    def __init__(self, client: httpx.Client | None = None) -> None:
        self.client = client
        self.readings: list[Reading] = []
        self.updated: datetime | None = None
        self._stop = threading.Event()

    def refresh(self) -> int:
        client = self.client or httpx.Client(
            timeout=30.0, verify=tls_context(), headers={"User-Agent": "thai-weather.chakkritton.com"}
        )
        try:
            r = client.get(URL)
            r.raise_for_status()
            self.readings = parse(r.json())
            self.updated = datetime.now(UTC)
            return len(self.readings)
        finally:
            if client is not self.client:
                client.close()

    def start(self) -> None:
        def loop() -> None:
            while not self._stop.is_set():
                try:
                    n = self.refresh()
                    log.info("air4thai: %d stations with PM2.5", n)
                except Exception as exc:  # network, TLS, format: keep the last readings
                    log.warning("air4thai refresh failed: %s", exc)
                self._stop.wait(REFRESH_S)

        threading.Thread(target=loop, name="air4thai", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def describe(self, r: Reading) -> dict:
        th, en, color = LEVELS.get(r.level, ("", "", None))
        return {
            "id": r.station,
            "name_th": r.name_th.strip(),
            "name_en": r.name_en.strip(),
            "area_th": r.area_th,
            "lat": r.lat,
            "lon": r.lon,
            "pm25": r.pm25,
            "aqi": r.aqi,
            "level": int(r.level) if r.level.isdigit() else None,
            "label_th": th,
            "label_en": en,
            "color": color,
            "time": r.time.isoformat(),
        }

    def all(self, now: datetime | None = None) -> list[dict]:
        """Every station with a reading under MAX_AGE old (for the map)."""
        now = now or datetime.now(UTC)
        return [self.describe(r) for r in self.readings if now - r.time <= MAX_AGE]

    def nearest(self, lat: float, lon: float, now: datetime | None = None) -> dict | None:
        now = now or datetime.now(UTC)
        best, best_km = None, MAX_KM
        for r in self.readings:
            if now - r.time > MAX_AGE:
                continue
            d = km(lat, lon, r.lat, r.lon)
            if d <= best_km:
                best, best_km = r, d
        if best is None:
            return None
        th, en, color = LEVELS.get(best.level, ("", "", None))
        return {
            "pm25": best.pm25,
            "aqi": best.aqi,
            "level": int(best.level) if best.level.isdigit() else None,
            "label_th": th,
            "label_en": en,
            "color": color,
            "time": best.time.isoformat(),
            "station": {
                "id": best.station,
                "name_th": best.name_th,
                "name_en": best.name_en,
                "area_th": best.area_th,
                "distance_km": round(best_km, 1),
            },
        }
