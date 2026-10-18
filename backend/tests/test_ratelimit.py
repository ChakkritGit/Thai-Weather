"""Free public API limits: per IP, the site's own pages and internal calls exempt from the quota."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from oracle.ratelimit import Limiter, RateLimitMiddleware, Tier, seconds_to_bkk_midnight


class Clock:
    def __init__(self) -> None:
        self.t = 1_760_000_000.0

    def __call__(self) -> float:
        return self.t


def _client(per_min=3, per_day=5, site_per_min=100):
    clock = Clock()
    app = FastAPI()

    @app.get("/api/v1/point")
    def point() -> dict:
        return {"ok": True}

    @app.get("/api/v1/health")
    def health() -> dict:
        return {"ok": True}

    app.add_middleware(
        RateLimitMiddleware,
        public=Tier("public", per_min, per_day),
        site=Tier("site", site_per_min, 10_000),
        limiter=Limiter(clock),
    )
    return TestClient(app), clock


IP = {"X-Real-IP": "203.0.113.7"}


def test_minute_bucket_then_429_with_retry_after():
    c, clock = _client()
    codes = [c.get("/api/v1/point", headers=IP).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    r = c.get("/api/v1/point", headers=IP)
    assert r.headers["Retry-After"] == "20"  # 3/min refills one every 20 s
    assert r.json()["error"] == "rate_limited"
    clock.t += 20
    ok = c.get("/api/v1/point", headers=IP)
    assert ok.status_code == 200
    assert ok.headers["X-RateLimit-Limit"] == "3" and ok.headers["X-RateLimit-Remaining"] == "0"


def test_daily_quota_resets_at_bangkok_midnight():
    c, clock = _client(per_min=100, per_day=5)
    assert all(c.get("/api/v1/point", headers=IP).status_code == 200 for _ in range(5))
    r = c.get("/api/v1/point", headers=IP)
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) == seconds_to_bkk_midnight(clock.t)
    assert r.headers["X-RateLimit-Remaining-Day"] == "0"
    clock.t += seconds_to_bkk_midnight(clock.t)
    assert c.get("/api/v1/point", headers=IP).status_code == 200


def test_ips_are_counted_separately():
    c, _ = _client(per_min=1)
    assert c.get("/api/v1/point", headers=IP).status_code == 200
    assert c.get("/api/v1/point", headers=IP).status_code == 429
    assert c.get("/api/v1/point", headers={"X-Real-IP": "198.51.100.2"}).status_code == 200


def test_own_pages_internal_calls_and_health_are_not_on_the_quota():
    c, _ = _client(per_min=1)
    site = {**IP, "Sec-Fetch-Site": "same-origin"}
    for _ in range(20):
        r = c.get("/api/v1/point", headers=site)
        assert r.status_code == 200 and "X-RateLimit-Limit" not in r.headers
    assert all(c.get("/api/v1/point").status_code == 200 for _ in range(5))  # no X-Real-IP: inside the network
    assert all(c.get("/api/v1/health", headers=IP).status_code == 200 for _ in range(5))
    # the site's use did not spend the public quota
    assert c.get("/api/v1/point", headers=IP).status_code == 200
