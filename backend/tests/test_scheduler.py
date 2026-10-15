"""The refresher does not refetch a fresh forecast just because the API restarted."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.config import Settings
from app.scheduler import Refresher

NOW = datetime(2026, 10, 16, 0, 0, tzinfo=UTC)


def _refresher(meta):
    r = Refresher.__new__(Refresher)  # no source / thread needed for the timing rule
    r.settings = Settings(refresh_minutes=360, run_on_startup=True)
    r.store = SimpleNamespace(latest=lambda: SimpleNamespace(meta=meta) if meta is not None else None)
    return r


def test_no_run_yet_runs_now():
    assert _refresher(None).first_wait_s(NOW) == 0


def test_fresh_run_waits_until_due():
    meta = {"created": (NOW - timedelta(hours=1)).isoformat(), "demo": False}
    assert _refresher(meta).first_wait_s(NOW) == 5 * 3600


def test_stale_or_demo_run_runs_now():
    assert _refresher({"created": (NOW - timedelta(hours=7)).isoformat(), "demo": False}).first_wait_s(NOW) == 0
    assert _refresher({"created": NOW.isoformat(), "demo": True}).first_wait_s(NOW) == 0
