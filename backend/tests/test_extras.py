"""Days 3-10, conditions, sun and moon, PM2.5: the parts of /api/v1/forecast beyond the 2.2 km run."""

import json
from datetime import UTC, date, datetime, timedelta

import httpx

from app.extras import air, astro, conditions, forecast, met

BKK = timedelta(hours=7)


def test_sunrise_and_sunset_in_bangkok_and_chiang_mai():
    rise, sset = astro.sun_times(date(2026, 10, 16), 13.75, 100.5)
    assert (rise + BKK).strftime("%H:%M") in ("06:07", "06:08", "06:09")
    assert (sset + BKK).strftime("%H:%M") in ("17:57", "17:58", "17:59")
    rise, sset = astro.sun_times(date(2026, 6, 21), 18.79, 98.98)
    assert 13.0 < (sset - rise).total_seconds() / 3600 < 13.4  # longest day in the north


def test_moon_phases_and_thai_lunar_day():
    full = astro.moon(datetime(2026, 10, 26, 4, tzinfo=UTC))  # full moon 26 Oct 2026
    assert (
        full["code"] == "full"
        and full["illumination"] > 0.97
        and full["thai_day"].startswith("ขึ้น 15")
        or full["thai_day"].startswith("แรม 1")
    )
    new = astro.moon(datetime(2026, 10, 10, 16, tzinfo=UTC))
    assert new["code"] == "new" and new["illumination"] < 0.03


def test_conditions_from_numbers_and_met_symbols():
    assert conditions.from_forecast(0.0, 5, 0, 5) == "clear"
    assert conditions.from_forecast(0.0, 5, 0, 70) == "mostly_cloudy"
    assert conditions.from_forecast(0.3, 50, 10, 90) == "drizzle"
    assert conditions.from_forecast(6.0, 90, 20, 100) == "heavy_rain"
    assert conditions.from_forecast(1.0, 60, 55, 100) == "thunderstorm"
    assert conditions.from_met("heavyrainandthunder") == "thunderstorm"
    assert conditions.from_met("fair_day") == "mostly_clear"
    assert conditions.from_met("lightrainshowers_night") == "drizzle"
    # one shower does not make a day rainy; two hours of storms do
    assert conditions.for_day(["partly_cloudy"] * 8 + ["rain"]) == "partly_cloudy"
    assert conditions.for_day(["partly_cloudy"] * 6 + ["thunderstorm"] * 2 + ["rain"] * 3) == "thunderstorm"


def _met_payload(start: datetime) -> dict:
    ts = []
    for h in range(60):
        t = start + timedelta(hours=h)
        ts.append(
            {
                "time": t.isoformat().replace("+00:00", "Z"),
                "data": {
                    "instant": {
                        "details": {
                            "air_temperature": 27 + (h % 24) / 6,
                            "air_pressure_at_sea_level": 1008.5,
                            "ultraviolet_index_clear_sky": 10.5 if (t + BKK).hour == 12 else 0.0,
                            "wind_speed": 2.0,
                        }
                    },
                    "next_1_hours": {
                        "summary": {
                            "symbol_code": "rainshowers_day" if (t + BKK).hour in (15, 16) else "partlycloudy_day"
                        },
                        "details": {"precipitation_amount": 2.0 if (t + BKK).hour in (15, 16) else 0.0},
                    },
                },
            }
        )
    for k in range(40):  # then 6-hour blocks to day 10
        t = start + timedelta(hours=60 + 6 * k)
        ts.append(
            {
                "time": t.isoformat().replace("+00:00", "Z"),
                "data": {
                    "instant": {"details": {"air_temperature": 28.0, "wind_speed": 3.0}},
                    "next_6_hours": {
                        "summary": {"symbol_code": "heavyrainandthunder"},
                        "details": {
                            "precipitation_amount": 6.0,
                            "air_temperature_max": 33.0,
                            "air_temperature_min": 24.0,
                        },
                    },
                },
            }
        )
    return {"properties": {"timeseries": ts}}


def test_met_client_caches_until_expiry_and_revalidates():
    calls = []
    start = datetime(2026, 10, 16, tzinfo=UTC)

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(dict(req.url.params) | {"ims": req.headers.get("if-modified-since")})
        if req.headers.get("if-modified-since"):
            return httpx.Response(304)
        assert "thai-weather" in req.headers["user-agent"]
        return httpx.Response(200, json=_met_payload(start), headers={"last-modified": "Fri, 16 Oct 2026 06:00:00 GMT"})

    clock = [1000.0]
    c = met.MetClient(
        httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": met.USER_AGENT}),
        clock=lambda: clock[0],
    )
    a = c.get(13.7512, 100.5049)
    b = c.get(13.76, 100.51)  # same 0.05° cell
    assert a is b and len(calls) == 1 and calls[0]["lat"] == "13.75" and calls[0]["lon"] == "100.50"
    clock[0] += met.MAX_TTL_S + 1
    assert c.get(13.75, 100.5) is a and calls[-1]["ims"] == "Fri, 16 Oct 2026 06:00:00 GMT"


def test_ten_days_two_from_the_run_then_met():
    start = datetime(2026, 10, 15, 23, tzinfo=UTC)  # 06:00 Bangkok
    times = [start + timedelta(hours=i) for i in range(48)]
    n = len(times)
    fine = {
        "temp": [28.0 + (i % 24) / 4 for i in range(n)],
        "heat": [33.0] * n,
        "rh": [75.0] * n,
        "rain": [0.0] * n,
        "pop": [10.0] * n,
        "storm": [5.0] * n,
        "wind": [2.0] * n,
        "wind_dir": [180.0] * n,
        "cloud": [30.0] * n,
    }
    out = forecast.build(times, fine, 13.75, 100.5, _met_payload(start), None, now=start)
    days = out["daily"]
    assert len(days) == 10
    assert [d["source"] for d in days[:2]] == ["fine", "fine"] and all(d["source"] == "met" for d in days[3:])
    assert days[0]["condition"]["code"] == "mostly_clear" and days[0]["pop_max"] == 10.0
    assert days[5]["tmax"] == 33.0 and days[5]["tmin"] == 24.0 and days[5]["condition"]["code"] == "thunderstorm"
    assert days[0]["uv_clear_sky_max"] == 10.5 and days[0]["sunrise"] and days[0]["moon"]["thai_day"]
    assert out["hourly"][0]["condition"]["night"] is True  # 06:00 Bangkok, before the 06:08 sunrise
    h = out["hourly"][3]  # 09:00
    assert h["pressure"] == 1008.5 and h["dew_point"] < h["temp"] and h["condition"]["night"] is False
    assert out["hourly"][15]["condition"]["night"] is True  # 21:00 Bangkok
    assert out["current"]["time"] == start.isoformat()
    assert out["attribution"][0]["name"] == "MET Norway"


def test_nearest_fresh_air4thai_station():
    now = datetime(2026, 10, 16, 6, tzinfo=UTC)

    def station(sid, lat, lon, pm, hh="12:00", color="2"):
        return {
            "stationID": sid,
            "nameTH": sid,
            "nameEN": sid,
            "areaTH": "x",
            "lat": str(lat),
            "long": str(lon),
            "AQILast": {"date": "2026-10-16", "time": hh, "PM25": {"value": str(pm), "aqi": "28", "color_id": color}},
        }

    svc = air.AirService()
    svc.readings = air.parse(
        {
            "stations": [
                station("near_old", 13.75, 100.51, 50, hh="01:00"),  # 18 h... too old
                station("near", 13.80, 100.55, 15.9),
                station("far", 18.8, 98.9, 80, color="5"),
                station("broken", 13.75, 100.5, -1),
            ]
        }
    )
    r = svc.nearest(13.75, 100.5, now)
    assert (
        r["station"]["id"] == "near" and r["pm25"] == 15.9 and r["label_th"] == "ดี" and r["station"]["distance_km"] < 10
    )
    assert svc.nearest(7.0, 100.5, now) is None  # nothing within 50 km


def test_air4thai_chain_file_is_shipped():
    from app.core.static import DATA_DIR

    pem = (DATA_DIR / "air4thai-chain.pem").read_text()
    assert pem.count("BEGIN CERTIFICATE") == 2
    assert json.dumps(air.LEVELS)  # levels are plain data
