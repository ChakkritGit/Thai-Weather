"""Gusts and visibility, estimated from what the 2.2 km forecast already has.

No free source carries them without spending the Open-Meteo quota the forecast runs need (asking for
two more variables would push a day of runs past 10,000 calls), so they are derived and labelled as
estimates everywhere they are shown:

* gust: the mean wind times a typical gust factor over land (1.5), plus a thunderstorm outflow term
  weighted by the chance of a storm (outflow gusts of 10-20 m/s are common under Thai storms).
* visibility: Koschmieder (V = 3.912 / extinction) with the extinctions of rain (from its rate),
  fog/mist (from humidity and a calm wind) and haze (from PM2.5, grown by humidity), on top of a
  clean tropical background of ~25 km.
"""

from __future__ import annotations

GUST_FACTOR = 1.5
STORM_OUTFLOW_MS = 14.0
BACKGROUND_KM = 25.0
MAX_KM = 20.0


def gust(wind_ms: float, storm_pct: float) -> float:
    """Estimated peak gust (m/s) for an hour with mean wind `wind_ms` and `storm_pct` % storm chance."""
    base = GUST_FACTOR * max(wind_ms, 0.0)
    storm = min(max(storm_pct, 0.0), 100.0) / 100.0
    return round(max(base, wind_ms + storm * STORM_OUTFLOW_MS), 1)


def visibility(rain_mm_h: float, rh_pct: float, wind_ms: float, pm25: float | None = None) -> float:
    """Estimated horizontal visibility (km), capped at 20 km."""
    ext = 3.912 / BACKGROUND_KM
    if rain_mm_h >= 0.1:
        # ~8 km in light rain (1 mm/h), ~2.5 km at 10 mm/h, ~1 km in a downpour
        ext += 3.912 / (8.0 * rain_mm_h**-0.5)
    rh = min(max(rh_pct, 0.0), 100.0)
    if rh >= 93.0 and wind_ms < 3.0:
        # mist from 93 % (≈5 km), fog near saturation (≈1 km)
        ext += 3.912 / (5.0 - 4.0 * min(1.0, (rh - 93.0) / 5.0))
    if pm25 is not None and pm25 > 0:
        growth = min(3.0, (1.0 - min(rh, 95.0) / 100.0) ** -0.5)  # humid haze scatters more
        ext += 0.003 * pm25 * growth  # ~3 m²/g dry mass extinction (IMPROVE-style), times growth
    return round(min(MAX_KM, 3.912 / ext), 1)


def visibility_label(km: float) -> tuple[str, str]:
    if km < 1:
        return "หมอกหนา / ฝนหนัก", "Very poor"
    if km < 4:
        return "ต่ำ", "Poor"
    if km < 10:
        return "ปานกลาง", "Moderate"
    return "ดี", "Good"


__all__ = ["gust", "visibility", "visibility_label"]
