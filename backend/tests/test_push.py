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


def test_store_limit_and_test_rate_limit(tmp_path):
    store = SubscriptionStore(tmp_path, limit=2)
    p, a = _creds()
    subs = [store.upsert(f"https://fcm.googleapis.com/{i}", p, a, 13, 100, "", Prefs()) for i in range(2)]
    with pytest.raises(PushError) as err:
        store.upsert("https://fcm.googleapis.com/3", p, a, 13, 100, "", Prefs())
    assert err.value.status == 503
    assert store.claim_test(subs[0].id, 1000.0) == 0.0
    assert store.claim_test(subs[0].id, 1030.0) == pytest.approx(30.0)
    assert store.claim_test(subs[0].id, 1061.0) == 0.0


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
    from app.main import app

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
    again = _subscribe(client, ep, creds, prefs={"storm": False, "quiet_start": 0, "quiet_end": 0}).json()
    assert again["id"] == d["id"] and again["prefs"]["storm"] is False

    other = _sub_json(ep)  # same endpoint, someone else's auth secret
    assert _subscribe(client, ep, (other["keys"]["p256dh"], other["keys"]["auth"])).status_code == 403
    assert client.post("/api/v1/push/unsubscribe", json=other).status_code == 403
    sub = {"endpoint": ep, "keys": {"p256dh": creds[0], "auth": creds[1]}}
    assert client.post("/api/v1/push/unsubscribe", json=sub).json() == {"ok": True, "deleted": True}
    assert client.post("/api/v1/push/unsubscribe", json=sub).json() == {"ok": True, "deleted": False}


def test_test_notification_is_rate_limited_per_subscription(client):
    creds = _creds()
    ep = "https://fcm.googleapis.com/fcm/send/testing"
    _subscribe(client, ep, creds)
    sub = {"endpoint": ep, "keys": {"p256dh": creds[0], "auth": creds[1]}}
    r = client.post("/api/v1/push/test", json=sub)
    assert r.status_code == 200 and client.sender.calls[-1][1]["kind"] == "test"
    limited = client.post("/api/v1/push/test", json=sub)
    assert limited.status_code == 429 and int(limited.headers["retry-after"]) > 0
    unknown = {"endpoint": "https://fcm.googleapis.com/fcm/send/none", "keys": sub["keys"]}
    assert client.post("/api/v1/push/test", json=unknown).status_code == 404


def test_test_notification_to_expired_subscription_deletes_it(client):
    creds = _creds()
    ep = "https://fcm.googleapis.com/fcm/send/expiring"
    _subscribe(client, ep, creds)
    sub = {"endpoint": ep, "keys": {"p256dh": creds[0], "auth": creds[1]}}
    client.sender.error = PushGone()
    try:
        assert client.post("/api/v1/push/test", json=sub).status_code == 410
    finally:
        client.sender.error = None
    assert client.app.state.push.store.by_endpoint(ep) is None


def test_status_needs_the_admin_token(client):
    assert client.get("/api/v1/push/status").status_code == 401
    d = client.get("/api/v1/push/status", headers={"Authorization": "Bearer secret"}).json()
    assert d["enabled"] is True and d["subscriptions"] >= 1 and d["limit"] == 5000
