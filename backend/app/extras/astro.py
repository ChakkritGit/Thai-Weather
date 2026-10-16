"""Sunrise, sunset and the moon's phase, computed (no service needed).

Sun: the standard sunrise equation (solar transit, declination, hour angle at -0.833° for refraction
and the sun's radius); good to about a minute in the tropics. Moon: age since a known new moon over
the mean synodic month, with the Thai lunar day (ขึ้น/แรม n ค่ำ) as an approximation of the calendar.
"""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta

J2000 = 2451545.0
SYNODIC = 29.530588853
NEW_MOON = datetime(2000, 1, 6, 18, 14, tzinfo=UTC)


def _jd_to_dt(jd: float) -> datetime:
    return datetime(2000, 1, 1, 12, tzinfo=UTC) + timedelta(days=jd - J2000)


def sun_times(day: date, lat: float, lon: float) -> tuple[datetime | None, datetime | None]:
    """Sunrise and sunset (UTC) on a calendar day at a place (east longitude positive)."""
    n = (day - date(2000, 1, 1)).days
    j_star = n - lon / 360.0
    m = math.radians((357.5291 + 0.98560028 * j_star) % 360)
    c = 1.9148 * math.sin(m) + 0.02 * math.sin(2 * m) + 0.0003 * math.sin(3 * m)
    lam = math.radians((math.degrees(m) + c + 180 + 102.9372) % 360)
    transit = J2000 + j_star + 0.0053 * math.sin(m) - 0.0069 * math.sin(2 * lam)
    decl = math.asin(math.sin(lam) * math.sin(math.radians(23.4397)))
    phi = math.radians(lat)
    cos_w = (math.sin(math.radians(-0.833)) - math.sin(phi) * math.sin(decl)) / (math.cos(phi) * math.cos(decl))
    if not -1 <= cos_w <= 1:
        return None, None
    w = math.degrees(math.acos(cos_w))
    return _jd_to_dt(transit - w / 360), _jd_to_dt(transit + w / 360)


PHASES = [
    ("new", "จันทร์ดับ", "New moon"),
    ("waxing_crescent", "ข้างขึ้น เสี้ยว", "Waxing crescent"),
    ("first_quarter", "ข้างขึ้น ครึ่งดวง", "First quarter"),
    ("waxing_gibbous", "ข้างขึ้น ค่อนดวง", "Waxing gibbous"),
    ("full", "จันทร์เต็มดวง", "Full moon"),
    ("waning_gibbous", "ข้างแรม ค่อนดวง", "Waning gibbous"),
    ("last_quarter", "ข้างแรม ครึ่งดวง", "Last quarter"),
    ("waning_crescent", "ข้างแรม เสี้ยว", "Waning crescent"),
]


def moon(at: datetime) -> dict:
    age = ((at - NEW_MOON).total_seconds() / 86400) % SYNODIC
    phase = age / SYNODIC
    idx = int(phase * 8 + 0.5) % 8
    code, th, en = PHASES[idx]
    day = min(15, int(age % (SYNODIC / 2)) + 1)
    return {
        "phase": round(phase, 3),
        "illumination": round((1 - math.cos(2 * math.pi * phase)) / 2, 2),
        "age_days": round(age, 1),
        "code": code,
        "label_th": th,
        "label_en": en,
        # the Thai lunar day, approximately (the calendar has its own rules for 14/15-day halves)
        "thai_day": f"{'ขึ้น' if phase < 0.5 else 'แรม'} {day} ค่ำ",
    }
