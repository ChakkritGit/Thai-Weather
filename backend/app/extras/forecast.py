"""Everything a weather app shows for one place: now, 48 hours, 10 days, sun, moon and air.

The first two days come from the 2.2 km forecast; a day it does not cover for at least 18 hours
comes from MET Norway instead (``source`` says which). MET also fills pressure and the clear-sky UV
index. Days and hours are Bangkok time.
"""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta

from . import astro, conditions, met

BKK = timedelta(hours=7)
FULL_DAY_H = 18


def dew_point(temp: float, rh: float) -> float:
    """Magnus formula (°C)."""
    rh = min(max(rh, 1.0), 100.0)
    g = math.log(rh / 100.0) + 17.62 * temp / (243.12 + temp)
    return round(243.12 * g / (17.62 - g), 1)


def _bkk_date(t: datetime) -> date:
    return (t + BKK).date()


def _is_night(t: datetime, lat: float, lon: float) -> bool:
    rise, sset = astro.sun_times(_bkk_date(t), lat, lon)
    return rise is None or not (rise <= t < sset)


def build(
    times: list[datetime],
    fine: dict[str, list[float]],
    lat: float,
    lon: float,
    met_data: dict | None,
    air: dict | None,
    now: datetime | None = None,
    days: int = 10,
) -> dict:
    now = now or datetime.now(UTC)
    hourly = []
    for i, t in enumerate(times):
        temp, rh = fine["temp"][i], fine["rh"][i]
        code = conditions.from_forecast(fine["rain"][i], fine["pop"][i], fine["storm"][i], fine["cloud"][i])
        extra = met.at(met_data, t) if met_data else {}
        hourly.append(
            {
                "time": t.isoformat(),
                "temp": temp,
                "feels_like": fine["heat"][i],
                "rh": rh,
                "dew_point": dew_point(temp, rh),
                "rain": fine["rain"][i],
                "pop": fine["pop"][i],
                "storm": fine["storm"][i],
                "wind": fine["wind"][i],
                "wind_dir": fine["wind_dir"][i],
                "cloud": fine["cloud"][i],
                "pressure": extra.get("air_pressure_at_sea_level"),
                "uv_clear_sky": extra.get("ultraviolet_index_clear_sky"),
                "condition": conditions.describe(code, _is_night(t, lat, lon)),
            }
        )

    current = next(
        (h for h, t in zip(hourly, times, strict=True) if t >= now - timedelta(minutes=30)),
        hourly[0] if hourly else None,
    )

    # -- days
    by_day: dict[date, list[int]] = {}
    for i, t in enumerate(times):
        by_day.setdefault(_bkk_date(t), []).append(i)
    met_steps = met.steps(met_data) if met_data else []
    today = _bkk_date(now)
    daily = []
    for k in range(days):
        d = today + timedelta(days=k)
        idx = by_day.get(d, [])
        rise, sset = astro.sun_times(d, lat, lon)
        sky = {
            "sunrise": rise.isoformat() if rise else None,
            "sunset": sset.isoformat() if sset else None,
            "daylight_h": round((sset - rise).total_seconds() / 3600, 2) if rise and sset else None,
            "moon": astro.moon(datetime(d.year, d.month, d.day, 12, tzinfo=UTC) - BKK),
        }
        uv = [s.instant.get("ultraviolet_index_clear_sky") for s in met_steps if _bkk_date(s.time) == d]
        uv_max = max((u for u in uv if u is not None), default=None)
        if idx and (len(idx) >= FULL_DAY_H or k == 0):
            day_codes = [h["condition"]["code"] for h in (hourly[i] for i in idx) if not h["condition"]["night"]]
            codes = day_codes or [hourly[i]["condition"]["code"] for i in idx]
            daily.append(
                {
                    "date": d.isoformat(),
                    "source": "fine",
                    "partial": len(idx) < FULL_DAY_H,
                    "tmax": max(fine["temp"][i] for i in idx),
                    "tmin": min(fine["temp"][i] for i in idx),
                    "feels_like_max": max(fine["heat"][i] for i in idx),
                    "rain_mm": round(sum(fine["rain"][i] for i in idx), 1),
                    "pop_max": max(fine["pop"][i] for i in idx),
                    "storm_max": max(fine["storm"][i] for i in idx),
                    "wind_max": max(fine["wind"][i] for i in idx),
                    "uv_clear_sky_max": uv_max,
                    "condition": conditions.describe(conditions.for_day(codes)),
                    **sky,
                }
            )
            continue
        steps = [s for s in met_steps if _bkk_date(s.time) == d]
        if not steps:
            break
        temps = [s.instant.get("air_temperature") for s in steps] + [s.tmax for s in steps] + [s.tmin for s in steps]
        temps = [v for v in temps if v is not None]
        local_hour = lambda s: (s.time + BKK).hour  # noqa: E731
        day_codes = [c for s in steps if 6 <= local_hour(s) < 18 and (c := conditions.from_met(s.symbol))]
        codes = day_codes or [c for s in steps if (c := conditions.from_met(s.symbol))]
        winds = [s.instant.get("wind_speed") for s in steps if s.instant.get("wind_speed") is not None]
        daily.append(
            {
                "date": d.isoformat(),
                "source": "met",
                "partial": False,
                "tmax": round(max(temps), 1) if temps else None,
                "tmin": round(min(temps), 1) if temps else None,
                "feels_like_max": None,
                "rain_mm": round(sum(s.precip or 0.0 for s in steps), 1),
                "pop_max": None,
                "storm_max": None,
                "wind_max": round(max(winds), 1) if winds else None,
                "uv_clear_sky_max": uv_max,
                "condition": conditions.describe(conditions.for_day(codes)),
                **sky,
            }
        )

    attribution = [met.ATTRIBUTION] if met_data else []
    if air:
        from .air import ATTRIBUTION as AIR

        attribution.append(AIR)
    return {"current": current, "hourly": hourly, "daily": daily, "air": air, "attribution": attribution}
