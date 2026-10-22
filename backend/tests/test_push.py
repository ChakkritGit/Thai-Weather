import os
import stat
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pywebpush import WebPushException

from app.config import Settings, get_settings
from app.core.grid import FINE_GRID
from app.nowcast.cyclones import Cyclone, TrackPoint
from app.nowcast.service import NowcastService
from app.push import dispatcher as disp
from app.push import sender as sender_mod
from app.push.dispatcher import PushDispatcher, candidates
from app.push.sender import PushFailed, PushGone, WebPushSender
from app.push.store import Prefs, PushError, SubscriptionStore, validate_endpoint
from app.push.vapid import VapidKeys, b64url, generate, load_or_create, public_from_private

G = FINE_GRID
LAT, LON = 13.75, 100.5
T0 = datetime(2026, 10, 9, 6, 0, tzinfo=UTC)  # 13:00 in Bangkok
FCM = "https://fcm.googleapis.com/fcm/send/abc123"


def _creds() -> tuple[str, str]:
    return generate()[1], b64url(os.urandom(16))  # a real P-256 point is 65 bytes, like the browser's p256dh


def _sub_json(endpoint: str = FCM, creds: tuple[str, str] | None = None) -> dict:
    p256dh, auth = creds or _creds()
    return {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}


# ------------------------------------------------------------------ endpoint validation
@pytest.mark.parametrize(
    "url",
    [
        "https://fcm.googleapis.com/fcm/send/x",
        "https://updates.push.services.mozilla.com/wpush/v2/x",
        "https://abc.push.services.mozilla.com/wpush/v2/x",
        "https://wns2-par02p.notify.windows.com/w/?token=x",
        "https://web.push.apple.com/Qx",
        "https://api.push.apple.com/3/device/x",
    ],
)
def test_known_push_services_are_accepted(url):
    assert validate_endpoint(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "http://fcm.googleapis.com/fcm/send/x",  # not https
        "https://evil.example.com/x",
        "https://fcm.googleapis.com.evil.com/x",  # look-alike suffix
        "https://evil.com/fcm.googleapis.com",
        "https://fcm.googleapis.com@evil.com/x",  # userinfo trick
        "https://user:pw@fcm.googleapis.com/x",
        "https://fcm.googleapis.com:8443/x",
        "https://notify.windows.com/x",  # bare domain is not a push endpoint
        "https://127.0.0.1/x",
        "https://" + "a" * 700 + ".push.apple.com/",
        "not a url",
    ],
)
def test_other_endpoints_are_rejected(url):
    with pytest.raises(PushError):
        validate_endpoint(url)


# ------------------------------------------------------------------ vapid
def test_vapid_is_generated_once_and_persisted(tmp_path):
    s = Settings(data_dir=tmp_path)
    first = load_or_create(s)
    path = tmp_path / "push" / "vapid.json"
    assert path.exists()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    second = load_or_create(s)
    assert (second.public, second.private) == (first.public, first.private)
    assert public_from_private(first.private) == first.public
    assert "private" not in repr(first) and first.private not in repr(first)


def test_vapid_from_environment_wins_and_derives_the_public_key(tmp_path):
    private, public = generate()
    keys = load_or_create(
        Settings(data_dir=tmp_path, vapid_private_key=private, vapid_public_key="wrong", vapid_subject="mailto:a@b.co")
    )
    assert keys.public == public and keys.subject == "mailto:a@b.co"
    assert not (tmp_path / "push").exists()  # nothing generated when the environment provides the keys


# ------------------------------------------------------------------ store
def test_store_rounds_persists_and_checks_credentials(tmp_path):
    store = SubscriptionStore(tmp_path / "push")
    p256dh, auth = _creds()
    sub = store.upsert(FCM, p256dh, auth, 13.7512, 100.4987, "  บ้าน  ", Prefs())
    assert (sub.lat, sub.lon, sub.label) == (13.75, 100.5, "บ้าน")
    assert len(sub.id) >= 16
    store.close()

    reopened = SubscriptionStore(tmp_path / "push")  # survives a restart
    assert reopened.count() == 1 and reopened.by_endpoint(FCM).id == sub.id
    updated = reopened.upsert(FCM, p256dh, auth, 18.6, 98.5, "ดอย", Prefs(storm=False))
    assert updated.id == sub.id and updated.prefs.storm is False and reopened.count() == 1
    with pytest.raises(PushError) as err:
        reopened.upsert(FCM, p256dh, b64url(os.urandom(16)), 1, 1, "", Prefs())
    assert err.value.status == 403


def test_store_limit(tmp_path):
    store = SubscriptionStore(tmp_path, limit=2)
    p, a = _creds()
    for i in range(2):
        store.upsert(f"https://fcm.googleapis.com/{i}", p, a, 13, 100, "", Prefs())
    with pytest.raises(PushError) as err:
        store.upsert("https://fcm.googleapis.com/3", p, a, 13, 100, "", Prefs())
    assert err.value.status == 503


# ------------------------------------------------------------------ sender
def _fake_webpush(status):
    def fake(**kw):
        raise WebPushException("boom", response=SimpleNamespace(status_code=status))

    return fake


@pytest.mark.parametrize("status,exc", [(410, PushGone), (404, PushGone), (500, PushFailed), (None, PushFailed)])
def test_sender_maps_push_service_errors(monkeypatch, tmp_path, status, exc):
    store = SubscriptionStore(tmp_path)
    p, a = _creds()
    sub = store.upsert(FCM, p, a, LAT, LON, "", Prefs())
    monkeypatch.setattr(sender_mod, "webpush", _fake_webpush(status))
    keys = VapidKeys(*generate()[::-1], "mailto:t@example.org")
    with pytest.raises(exc):
        WebPushSender(keys)(sub, {"title": "x"})


# ------------------------------------------------------------------ dispatcher
def eta(minutes, rng, cls="thunderstorm"):
    return {"minutes": minutes, "minutes_range": list(rng), "class": cls, "max_dbz": 50.0}


def nc(storm=None, rain=None, now="none", near=None):
    return {
        "now": {"class": now, "max_dbz": None},
        "eta_rain": rain,
        "eta_storm": storm,
        "nearest": near,
        "motion": {"speed_kmh": 0, "heading_deg": None},
    }


NEAR = {
    "distance_km": 12.3,
    "bearing_deg": 225,
    "class": "heavy",
    "max_dbz": 43,
    "approaching": False,
    "closing_kmh": 0,
}


class FakeSender:
    def __init__(self):
        self.calls = []
        self.error = None

    def __call__(self, sub, payload, ttl=3600, urgent=False):
        if self.error:
            raise self.error
        self.calls.append((sub.id, payload, ttl, urgent))


class Env:
    """A dispatcher with a controllable clock, radar frame and point-nowcast result."""

    def __init__(self, tmp_path, monkeypatch):
        self.now = T0
        self.result = nc()
        self.frame_age_min = 3.0
        self.sender = FakeSender()
        self.service = NowcastService(Settings(nowcast_source="rainviewer", cyclones_enabled=False, data_dir=tmp_path))
        self.store = SubscriptionStore(tmp_path / "push")
        self.dispatcher = PushDispatcher(self.store, self.service, self.sender, workers=1, clock=lambda: self.now)
        monkeypatch.setattr(disp, "point_nowcast", lambda *a, **k: self.result)
        yy, xx = np.mgrid[0 : G.ny, 0 : G.nx]
        self.blob = np.where(yy % 50 == 0, 30.0, np.nan).astype(np.float32)
        self.refresh()

    def refresh(self):
        newest = self.now - timedelta(minutes=self.frame_age_min)
        self.service.ingest([(newest - timedelta(minutes=10 * k), self.blob) for k in (2, 1, 0)])

    def subscribe(self, endpoint=FCM, label="บ้าน", prefs=None):
        p, a = _creds()
        return self.store.upsert(endpoint, p, a, LAT, LON, label, prefs or Prefs())

    def run(self, kind="radar"):
        return self.dispatcher.run(kind)


@pytest.fixture
def env(tmp_path, monkeypatch):
    return Env(tmp_path, monkeypatch)


def test_storm_alert_text_and_deduplication(env):
    sub = env.subscribe()
    env.result = nc(storm=eta(25, (20, 35)), near=NEAR)
    assert env.run()["sent"] == 1
    _, payload, ttl, urgent = env.sender.calls[0]
    assert payload["title"] == "พายุฝนฟ้าคะนองน่าจะถึงในอีก 20–35 นาที"
    assert payload["body"] == "บ้าน · กลุ่มฝนหนักห่าง 12 กม. ทางตะวันตกเฉียงใต้ ไม่ได้เคลื่อนเข้าหาคุณ"
    assert payload["lang"] == "th" and payload["url"] == "/?lat=13.75&lon=100.50"
    assert payload["tag"].startswith("thwx-storm-") and ttl == 1800 and urgent is True

    env.now += timedelta(minutes=10)  # same alert key within 3 h: nothing more
    env.refresh()
    assert env.run()["sent"] == 0 and len(env.sender.calls) == 1
    env.now += timedelta(hours=3)  # cooldown over, still threatening
    env.refresh()
    assert env.run()["sent"] == 1
    assert env.store.by_endpoint(FCM).id == sub.id


def test_tier_rise_overrides_the_cooldown(env):
    env.subscribe()
    env.result = nc(storm=eta(30, (25, 40), "thunderstorm"))
    assert env.run()["sent"] == 1
    env.now += timedelta(minutes=10)
    env.refresh()
    env.result = nc(storm=eta(20, (15, 25), "severe"))
    assert env.run()["sent"] == 1  # severe outranks the earlier thunderstorm alert
    env.now += timedelta(minutes=10)
    env.refresh()
    env.result = nc(storm=eta(10, (5, 15), "thunderstorm"))  # lower tier again: stay quiet
    assert env.run()["sent"] == 0


def test_not_sent_when_far_away_or_already_over(env):
    env.subscribe()
    env.result = nc(storm=eta(55, (50, 60)))  # beyond the 45 min window
    assert env.run()["alerts"] == 0
    env.result = nc(now="thunderstorm")
    assert env.run()["sent"] == 1
    assert env.sender.calls[0][1]["title"] == "กำลังมีพายุฝนฟ้าคะนองบริเวณนี้"


def test_heavy_rain_alert_respects_preferences(env):
    env.subscribe(prefs=Prefs(storm=False))
    env.result = nc(rain=eta(30, (25, 35), "heavy"))
    assert env.run()["sent"] == 1
    assert env.sender.calls[0][1]["title"] == "ฝนหนักน่าจะถึงในอีก 25–35 นาที"
    assert env.sender.calls[0][1]["tag"].startswith("thwx-rain-")
    env.now += timedelta(hours=4)
    env.refresh()
    env.result = nc(rain=eta(30, (25, 35), "moderate"))  # moderate rain is not worth a notification
    assert env.run()["alerts"] == 0


def test_a_storm_is_one_alert_not_two(env):
    env.subscribe()
    env.result = nc(storm=eta(20, (15, 25)), rain=eta(20, (15, 25), "thunderstorm"))
    env.run()
    assert [c[1]["kind"] for c in env.sender.calls] == ["storm"]


def test_quiet_hours_suppress_but_do_not_consume_the_alert(env):
    env.subscribe()
    env.result = nc(storm=eta(20, (15, 25)))
    env.now = datetime(2026, 10, 9, 18, 0, tzinfo=UTC)  # 01:00 in Bangkok, inside 22-06
    env.refresh()
    assert env.run()["sent"] == 0
    env.now = datetime(2026, 10, 9, 23, 30, tzinfo=UTC)  # 06:30 local
    env.refresh()
    assert env.run()["sent"] == 1


def test_stale_radar_sends_nothing(env):
    env.subscribe()
    env.result = nc(storm=eta(20, (15, 25)))
    env.frame_age_min = 45.0
    env.refresh()
    stats = env.run()
    assert stats["radar_ok"] is False and stats["sent"] == 0


def _cyclone(zone=False):
    track = [
        TrackPoint(T0 - timedelta(hours=6), 11.5, 99.5, False, "TS"),
        TrackPoint(T0 + timedelta(hours=24), 14.2, 101.8, True, "TS"),
    ]
    ring = [(100.0, 13.0), (101.0, 13.0), (101.0, 14.5), (100.0, 14.5)]
    return Cyclone("9-1", "Simon", "JTWC", 90.0, "TS", track, [(60, ring)] if zone else [])


def test_cyclone_alert_and_quiet_hours(env):
    env.subscribe()
    env.service.set_cyclones([_cyclone(zone=False)])
    env.now = datetime(2026, 10, 9, 18, 0, tzinfo=UTC)  # quiet hours; storm track passes within 300 km
    env.refresh()
    assert env.run("cyclones")["sent"] == 0  # a non-zone cyclone alert waits for the morning
    env.now = datetime(2026, 10, 9, 23, 30, tzinfo=UTC)
    stats = env.run("cyclones")
    assert stats["sent"] == 1
    payload = env.sender.calls[0][1]
    assert payload["kind"] == "cyclone" and "Simon" in payload["title"] and payload["body"].startswith("บ้าน · ")
    env.now += timedelta(hours=6)  # 12 h cooldown
    assert env.run("cyclones")["sent"] == 0


def test_cyclone_in_wind_zone_ignores_quiet_hours_and_outranks_earlier_alert(env):
    env.subscribe()
    env.service.set_cyclones([_cyclone(zone=False)])
    env.now = datetime(2026, 10, 9, 8, 0, tzinfo=UTC)
    assert env.run("cyclones")["sent"] == 1
    env.service.set_cyclones([_cyclone(zone=True)])
    env.now = datetime(2026, 10, 9, 18, 30, tzinfo=UTC)  # 01:30 local
    assert env.run("cyclones")["sent"] == 1  # tier 1 -> 2 despite cooldown and quiet hours
    assert "เขตลมแรง" in env.sender.calls[-1][1]["body"]
    assert env.sender.calls[-1][3] is True


def test_cyclone_far_away_is_ignored(env):
    far = _cyclone()
    far.track = [
        TrackPoint(T0, 10.0, 112.0, False, "TS"),
        TrackPoint(T0 + timedelta(hours=24), 12.0, 114.0, True, "TS"),
    ]
    env.subscribe()
    env.service.set_cyclones([far])
    assert env.run("cyclones")["alerts"] == 0


def test_candidates_are_pure_and_honour_prefs(env):
    sub = env.subscribe(prefs=Prefs(storm=False, heavy_rain=False, cyclone=False))
    assert candidates(sub, nc(storm=eta(10, (5, 15))), []) == []


def test_gone_subscriptions_are_removed_via_the_real_sender(env, monkeypatch):
    env.subscribe()
    env.result = nc(storm=eta(20, (15, 25)))
    monkeypatch.setattr(sender_mod, "webpush", _fake_webpush(410))
    env.dispatcher.sender = WebPushSender(VapidKeys(*generate()[::-1], "mailto:t@example.org"))
    stats = env.run()
    assert stats["removed"] == 1 and env.store.count() == 0


def test_failed_sends_are_kept_and_retried(env):
    env.subscribe()
    env.result = nc(storm=eta(20, (15, 25)))
    env.sender.error = PushFailed("push service answered 503")
    assert env.run()["failed"] == 1 and env.store.count() == 1
    env.sender.error = None
    assert env.run()["sent"] == 1  # nothing was recorded as sent, so the next run retries


def test_nowcast_listeners_are_called_and_isolated(tmp_path):
    service = NowcastService(Settings(nowcast_source="off", cyclones_enabled=False, data_dir=tmp_path))
    seen = []

    def boom(_):
        raise RuntimeError("listener bug")

    service.add_listener(boom)
    service.add_listener(seen.append)
    service._notify("radar")
    assert seen == ["radar"]


# ------------------------------------------------------------------ HTTP API
@pytest.fixture(scope="module")
def client(run_dir):
    mp = pytest.MonkeyPatch()
    mp.setenv("THWX_DATA_DIR", str(run_dir))
    mp.setenv("THWX_RUN_ON_STARTUP", "false")
    mp.setenv("THWX_ADMIN_TOKEN", "secret")
    get_settings.cache_clear()
    from oracle.app import app

    with TestClient(app) as c:
        c.sender = FakeSender()
        c.app.state.push.sender = c.sender
        yield c
    mp.undo()
    get_settings.cache_clear()


def _subscribe(client, endpoint=FCM, creds=None, **over):
    body = {"subscription": _sub_json(endpoint, creds), "lat": 13.7512, "lon": 100.4987, "label": "บ้าน", **over}
    return client.post("/api/v1/push/subscribe", json=body)


def test_public_key_matches_the_stored_keypair(client):
    key = client.get("/api/v1/push/public-key").json()["public_key"]
    assert key == client.app.state.push.keys.public and len(key) == 87  # 65 bytes, base64url


def test_subscribe_validates_host_domain_and_keys(client):
    assert _subscribe(client, "https://evil.example.com/x").status_code == 422
    assert _subscribe(client, "http://fcm.googleapis.com/x").status_code == 422
    assert _subscribe(client, FCM, lat=40.0, lon=100.0).status_code == 422  # outside Thailand
    bad = {"subscription": {"endpoint": FCM, "keys": {"p256dh": "AAAA", "auth": "BBBB"}}, "lat": 13.75, "lon": 100.5}
    assert client.post("/api/v1/push/subscribe", json=bad).status_code == 422
    assert (
        client.post(
            "/api/v1/push/subscribe", json={"subscription": _sub_json(), "lat": 13, "lon": 100, "label": "x" * 200}
        ).status_code
        == 422
    )
    big = client.post(
        "/api/v1/push/subscribe", content=b"{" + b" " * 5000 + b"}", headers={"content-type": "application/json"}
    )
    assert big.status_code == 413


def test_subscribe_update_unsubscribe_roundtrip(client):
    creds = _creds()
    ep = "https://fcm.googleapis.com/fcm/send/roundtrip"
    r = _subscribe(client, ep, creds)
    assert r.status_code == 200
    d = r.json()
    assert (d["lat"], d["lon"]) == (13.75, 100.5) and d["prefs"]["quiet_start"] == 22 and d["prefs"]["quiet_end"] == 6
    assert d["prefs"]["heat"] is False  # heat alerts are opt-in
    again = _subscribe(client, ep, creds, prefs={"storm": False, "quiet_start": 0, "quiet_end": 0, "heat": True}).json()
    assert again["id"] == d["id"] and again["prefs"]["storm"] is False and again["prefs"]["heat"] is True

    other = _sub_json(ep)  # same endpoint, someone else's auth secret
    assert _subscribe(client, ep, (other["keys"]["p256dh"], other["keys"]["auth"])).status_code == 403
    assert client.post("/api/v1/push/unsubscribe", json=other).status_code == 403
    sub = {"endpoint": ep, "keys": {"p256dh": creds[0], "auth": creds[1]}}
    assert client.post("/api/v1/push/unsubscribe", json=sub).json() == {"ok": True, "deleted": True}
    assert client.post("/api/v1/push/unsubscribe", json=sub).json() == {"ok": True, "deleted": False}


def test_status_needs_the_admin_token(client):
    _subscribe(client, "https://fcm.googleapis.com/fcm/send/status", _creds())
    assert client.get("/api/v1/push/status").status_code == 401
    d = client.get("/api/v1/push/status", headers={"Authorization": "Bearer secret"}).json()
    assert d["enabled"] is True and d["subscriptions"] >= 1 and d["limit"] == 5000


# ------------------------------------------------------------------ heat index (forecast, fine grid)
from app.push import store as store_mod  # noqa: E402
from app.push.dispatcher import heat_candidate  # noqa: E402
from app.push.heat import HeatSource, outlook  # noqa: E402

HOURS = [T0 + timedelta(hours=h) for h in range(-3, 12)]


def _series(peak_at: int | None = None, peak: float = 0.0, base: float = 36.0) -> list[float]:
    """Hourly heat index for ``HOURS``; ``peak_at`` is the hour offset from T0 of the peak value."""
    return [peak if peak_at is not None and t == T0 + timedelta(hours=peak_at) else base for t in HOURS]


@pytest.mark.parametrize(
    ("value", "tier", "level"),
    [(40.9, None, None), (41.0, 2, "danger"), (53.9, 2, "danger"), (54.0, 3, "extremeDanger")],
)
def test_heat_outlook_thresholds_follow_the_scale(value, tier, level):
    o = outlook(HOURS, _series(2, value), T0)
    assert (o.tier, o.level) == (tier, level) if tier else o is None


def test_heat_outlook_window_is_the_next_three_hours():
    assert outlook(HOURS, _series(3, 45.0), T0).time == T0 + timedelta(hours=3)
    assert outlook(HOURS, _series(4, 45.0), T0) is None  # beyond 3 h
    assert outlook(HOURS, _series(-1, 45.0), T0) is None  # already over
    assert outlook(HOURS, _series(0, 45.0), T0 + timedelta(minutes=30)) is not None  # the current hour counts


def test_heat_outlook_ignores_missing_and_implausible_values():
    assert outlook(HOURS, _series(1, float("nan"), base=float("nan")), T0) is None
    assert outlook(HOURS, _series(1, 63.75, base=0.0), T0) is None  # encoding clip / NaN-as-zero
    assert outlook([], [], T0) is None
    late = T0 + timedelta(hours=20)  # past the end of the run
    assert outlook(HOURS, _series(10, 50.0), late) is None


class FakeRun:
    def __init__(self, values, created=T0 - timedelta(hours=1), times=HOURS):
        self.meta = {"created": created.isoformat()}
        self.times = times
        self.fine_grid = G
        self.values = values
        self.reads = 0

    def series(self, res, layer, iy, ix):
        assert (res, layer) == ("fine", "heat")
        self.reads += 1
        return self.values


class HeatEnv(Env):
    def __init__(self, tmp_path, monkeypatch):
        super().__init__(tmp_path, monkeypatch)
        self.forecast = FakeRun(_series(2, 44.0))
        self.dispatcher.heat = HeatSource(lambda: self.forecast, timedelta(hours=13))

    def heat_sub(self, endpoint=FCM, **prefs):
        return self.subscribe(endpoint, prefs=Prefs(storm=False, heavy_rain=False, cyclone=False, heat=True, **prefs))


@pytest.fixture
def henv(tmp_path, monkeypatch):
    return HeatEnv(tmp_path, monkeypatch)


def test_heat_alert_is_opt_in_and_worded_as_a_forecast(henv):
    henv.subscribe("https://fcm.googleapis.com/old")  # default prefs: heat off
    henv.heat_sub()
    stats = henv.dispatcher.run_heat()
    assert stats["subscriptions"] == 1 and stats["sent"] == 1 and len(henv.sender.calls) == 1
    _, payload, ttl, urgent = henv.sender.calls[0]
    assert payload["title"] == "ดัชนีความร้อนระดับอันตรายตามพยากรณ์"
    assert payload["body"] == "บ้าน · คาดว่าดัชนีความร้อนสูงสุดราว 44°C ช่วง 15:00 น. ใน 3 ชม. ข้างหน้า · เลี่ยงแดดจัดและดื่มน้ำบ่อย ๆ"
    assert payload["kind"] == "heat" and payload["url"] == "/?lat=13.75&lon=100.50"
    assert ttl == 3600 and urgent is False


def test_heat_alone_is_a_valid_subscription(henv):
    sub = henv.heat_sub()
    assert (sub.prefs.storm, sub.prefs.heavy_rain, sub.prefs.cyclone, sub.prefs.heat) == (False, False, False, True)
    henv.result = nc(storm=eta(20, (15, 25)))  # radar dispatch sends nothing for a heat-only subscription
    assert henv.run()["alerts"] == 0


def test_heat_cooldown_and_escalation(henv):
    henv.heat_sub()
    assert henv.dispatcher.run_heat()["sent"] == 1
    henv.now += timedelta(minutes=5)
    assert henv.dispatcher.run_heat()["sent"] == 0  # same tier within 6 h
    henv.forecast = FakeRun(_series(2, 55.0))
    assert henv.dispatcher.run_heat()["sent"] == 1  # extreme danger outranks danger

    later = timedelta(hours=5)  # a new day's danger-level forecast, inside the extreme-danger cooldown
    henv.now += later
    henv.forecast = FakeRun(_series(2, 44.0), created=henv.now - timedelta(hours=1), times=[t + later for t in HOURS])
    assert henv.dispatcher.run_heat()["sent"] == 0
    henv.now += timedelta(hours=1, minutes=5)  # 6 h since the last heat alert
    henv.forecast.times = [t + timedelta(hours=1, minutes=5) for t in henv.forecast.times]
    assert henv.dispatcher.run_heat()["sent"] == 1


def test_heat_respects_quiet_hours_and_escalates_after_them(henv):
    henv.heat_sub(quiet_start=12, quiet_end=14)  # 13:00 local is quiet
    assert henv.dispatcher.run_heat()["sent"] == 0
    henv.now += timedelta(hours=1)  # 14:00 local, peak (15:00) still ahead
    assert henv.dispatcher.run_heat()["sent"] == 1


def test_heat_skips_stale_expired_and_outside_runs(henv):
    henv.heat_sub()
    henv.forecast = FakeRun(_series(2, 50.0), created=T0 - timedelta(hours=14))  # updates stopped
    assert henv.dispatcher.run_heat()["run_ok"] is False
    henv.forecast = FakeRun(_series(2, 50.0), times=[t - timedelta(hours=12) for t in HOURS])  # ends before now
    assert henv.dispatcher.run_heat()["run_ok"] is False
    henv.forecast = None
    assert henv.dispatcher.run_heat()["sent"] == 0
    assert henv.sender.calls == []
    run = FakeRun(_series(2, 50.0))
    assert HeatSource.series(run, 40.0, 100.0) is None  # outside the fine grid


def test_heat_failed_send_does_not_consume_the_cooldown(henv):
    henv.heat_sub()
    henv.sender.error = PushFailed("503")
    assert henv.dispatcher.run_heat()["failed"] == 1
    henv.sender.error = None
    henv.now += timedelta(minutes=5)
    assert henv.dispatcher.run_heat()["sent"] == 1


def test_heat_state_survives_restart_and_resets_when_moved(henv, tmp_path):
    p, a = _creds()
    prefs = Prefs(storm=False, heavy_rain=False, cyclone=False, heat=True)
    henv.store.upsert(FCM, p, a, LAT, LON, "บ้าน", prefs)
    assert henv.dispatcher.run_heat()["sent"] == 1
    henv.store.close()
    henv.store = henv.dispatcher.store = SubscriptionStore(tmp_path / "push")  # restart
    assert henv.dispatcher.run_heat()["sent"] == 0  # cooldown persisted
    henv.store.upsert(FCM, p, a, 14.0, 100.6, "ที่ทำงาน", prefs)  # moved: the old spot's state is dropped
    assert henv.dispatcher.run_heat()["sent"] == 1


def test_heat_reads_each_location_once(henv):
    henv.heat_sub("https://fcm.googleapis.com/a")
    henv.heat_sub("https://fcm.googleapis.com/b")
    henv.dispatcher.run_heat()
    assert henv.forecast.reads == 1 and len(henv.sender.calls) == 2


def test_heat_candidate_is_pure():
    sub = SimpleNamespace(id="abcdefghijkl", lat=LAT, lon=LON, label="", prefs=Prefs(heat=False))
    o = outlook(HOURS, _series(1, 45.0), T0)
    assert heat_candidate(sub, o) is None
    sub.prefs = Prefs(heat=True)
    assert heat_candidate(sub, None) is None
    assert heat_candidate(sub, o).tag == "thwx-heat-abcdefgh"


def test_old_database_gets_heat_off(tmp_path):
    import sqlite3

    db = sqlite3.connect(tmp_path / "subscriptions.sqlite")
    db.execute(store_mod._SCHEMA.replace(",\n    heat INTEGER NOT NULL DEFAULT 0", ""))
    db.execute(
        "INSERT INTO subscriptions (id, endpoint, p256dh, auth, lat, lon, created, last_seen) "
        "VALUES ('x', 'https://fcm.googleapis.com/x', 'p', 'a', 13.75, 100.5, 0, 0)"
    )
    db.commit()
    db.close()
    sub = SubscriptionStore(tmp_path).all()[0]
    assert sub.prefs.heat is False and sub.prefs.storm is True


def test_heat_worker_stops_before_the_store_closes(tmp_path, monkeypatch):
    from app.push import service as svc

    monkeypatch.setattr(svc, "HEAT_EVERY_S", 0.01)
    nowcast = NowcastService(Settings(nowcast_source="off", cyclones_enabled=False, data_dir=tmp_path))
    service = svc.PushService(Settings(data_dir=tmp_path), nowcast, sender=FakeSender(), latest_run=lambda: None)
    service.start()
    deadline = datetime.now() + timedelta(seconds=5)
    while service.dispatcher.last_heat_run is None and datetime.now() < deadline:
        pass
    assert service.dispatcher.last_heat_run is not None
    thread = service._heat_thread
    service.close()
    assert not thread.is_alive()


def test_the_body_says_how_long_the_rain_lasts(env):
    env.subscribe(prefs=Prefs(storm=False))
    result = nc(now="heavy", near=NEAR)
    result["rain_spell"] = {"start_min": 0, "end_min": 40, "lasts_min": 40, "open_ended": False, "horizon_min": 120}
    env.result = result
    assert env.run()["sent"] == 1
    assert env.sender.calls[0][1]["body"].startswith("บ้าน · น่าจะหยุดในอีกราว 40 นาที · กลุ่มฝนหนัก")
