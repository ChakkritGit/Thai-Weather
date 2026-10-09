"""Alert-tier mapping, partial-day flag and cross-endpoint consistency."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.products.alerts import PARTIAL_HOURS, is_partial, normalise_day, province_alerts
from app.products.scales import weather_scales

BASE = {
    "hours": 24,
    "tmax": 31.0,
    "tmin": 24.0,
    "heat_max": 37.0,
    "rain_p95": 10.0,
    "storm_max": 40.0,
    "wind_max": 4.0,
}


def sev(**over) -> dict[str, int]:
    return {a["hazard"]: a["severity"] for a in province_alerts({**BASE, **over})}


@pytest.fixture(scope="module")
def client(run_dir):
    mp = pytest.MonkeyPatch()
    mp.setenv("THWX_DATA_DIR", str(run_dir))
    mp.setenv("THWX_RUN_ON_STARTUP", "false")
    get_settings.cache_clear()
    from app.main import app

    with TestClient(app) as c:
        yield c
    mp.undo()
    get_settings.cache_clear()


def test_ordinary_thai_day_raises_no_alert():
    assert province_alerts(BASE) == []
    # DoH "extreme caution" (32-41 C) is informational, not an alert
    assert sev(heat_max=32.0) == {} and sev(heat_max=40.9) == {}
    assert sev(rain_p95=60.0) == {}  # TMD "heavy rain" alone is routine in the rainy season
    assert sev(storm_max=65.0) == {}


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"heat_max": 41.0}, {"heat": 2}),
        ({"heat_max": 53.9}, {"heat": 2}),
        ({"heat_max": 54.0}, {"heat": 3}),
        ({"rain_p95": 95.0}, {"rain": 1}),
        ({"rain_p95": 150.0}, {"rain": 2}),
        ({"storm_max": 80.0}, {"storm": 1}),
        ({"wind_max": 11.0}, {"wind": 1}),
        ({"wind_max": 18.0}, {"wind": 2}),
        ({"wind_max": 25.0}, {"wind": 3}),
        ({"tmax": 40.5}, {"hot": 1}),
        ({"tmin": 15.0}, {"cold": 1}),
        ({"tmin": 7.0}, {"cold": 2}),
    ],
)
def test_tier_mapping(overrides, expected):
    assert sev(**overrides) == expected


def test_every_level_severity_is_a_defined_tier():
    scales = weather_scales()
    tiers = {int(k) for k in scales["severity"] if k.isdigit()}
    assert tiers == {1, 2, 3}
    for cat in scales["categories"].values():
        assert {lvl["severity"] for lvl in cat["levels"]} <= tiers | {0}
    labels = {k: scales["severity"][k]["label_th"] for k in "123"}
    assert labels == {"1": "เหลือง · ควรติดตาม", "2": "ส้ม · เตรียมพร้อม", "3": "แดง · อันตราย"}
    assert scales["severity"]["3"]["label_en"] == "Red · Take action"
    # tier words never reuse a hazard-level name
    hazard_words = {lvl["label_th"] for cat in scales["categories"].values() for lvl in cat["levels"]}
    assert not hazard_words & set(labels.values())


def test_ordinary_day_alerts_at_most_a_quarter_of_provinces():
    """A realistic Thai rainy-season day (shape taken from live GFS-driven data)."""
    rng = np.random.default_rng(7)
    n = 77
    days = [
        {
            "hours": 24,
            "tmax": float(rng.normal(30.8, 1.2)),
            "tmin": float(rng.normal(23.2, 1.4)),
            "heat_max": float(np.clip(rng.normal(36.5, 1.6), 30, 41.5)),
            "rain_p95": float(rng.gamma(2.0, 7.0)),
            "storm_max": float(np.clip(rng.normal(36, 14), 0, 70)),
            "wind_max": float(rng.gamma(6.0, 0.7)),
        }
        for _ in range(n)
    ]
    flagged = sum(1 for d in days if province_alerts(d))
    assert flagged / n <= 0.25


def test_partial_flag():
    assert PARTIAL_HOURS == 18
    assert is_partial(17) and not is_partial(18) and not is_partial(24)
    d = normalise_day({**BASE, "hours": 12, "heat_max": 45.0, "alerts": [{"stale": True}]})
    assert d["partial"] is True
    assert [a["hazard"] for a in d["alerts"]] == ["heat"]  # partial days still alert
    assert normalise_day(BASE)["partial"] is False


def test_endpoints_agree_on_tiers_and_partial_days(client):
    meta = client.get("/api/v1/meta").json()["run"]
    assert all({"partial", "until", "since", "hours"} <= d.keys() for d in meta["days"])
    assert [d["partial"] for d in meta["days"]] == [d["hours"] < PARTIAL_HOURS for d in meta["days"]]
    assert meta["days"][0]["until"] == "23:00"  # synthetic run starts 07:00 Thai time

    provs = client.get("/api/v1/provinces").json()["provinces"]
    listed = client.get("/api/v1/alerts").json()["alerts"]  # default = every tier
    assert listed == client.get("/api/v1/alerts?min_severity=1").json()["alerts"]

    for i, day in enumerate(meta["days"]):
        from_provinces = sorted(p["id"] for p in provs if p["days"][i]["alerts"])
        from_alerts = sorted(a["province"]["id"] for a in listed if a["date"] == day["date"])
        assert from_provinces == from_alerts
        assert all(a["partial"] == day["partial"] for a in listed if a["date"] == day["date"])
        assert all(p["days"][i]["partial"] == day["partial"] for p in provs)

    one = client.get("/api/v1/provinces/TH-10").json()
    assert one["days"] == next(p for p in provs if p["id"] == "TH-10")["days"]
    high = client.get("/api/v1/alerts?min_severity=3").json()["alerts"]
    assert all(max(x["severity"] for x in a["alerts"]) == 3 for a in high)
