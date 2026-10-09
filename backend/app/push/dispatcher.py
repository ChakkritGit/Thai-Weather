"""Decides which saved locations get a notification after each radar / cyclone update.

``candidates`` is pure (nowcast dict + cyclone proximity in, alerts out) and ``allowed`` applies
the de-duplication and quiet-hours rules, so both are unit-tested without I/O.  ``PushDispatcher``
glues them to the stores, the nowcast snapshot and the sender.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from ..nowcast.cyclones import Cyclone, proximity
from ..nowcast.nowcast import point_nowcast
from ..nowcast.service import STALE_AFTER_MIN, NowcastService
from . import messages as msg
from .sender import PushFailed, PushGone, Sender
from .store import Prefs, Subscription, SubscriptionStore

log = logging.getLogger(__name__)

ETA_LIMIT_MIN = 45  # notify when the storm / heavy rain is expected within this many minutes
CYCLONE_APPROACH_KM = 300.0
CYCLONE_WITHIN_H = 48.0
COOLDOWN_S = {"storm": 3 * 3600, "heavy_rain": 3 * 3600, "cyclone": 12 * 3600}
BANGKOK = timedelta(hours=7)
RANK = {"none": 0, "light": 0, "moderate": 0, "heavy": 1, "thunderstorm": 2, "severe": 3}
TTL_S = {"storm": 30 * 60, "heavy_rain": 30 * 60, "cyclone": 3 * 3600}


@dataclass(frozen=True)
class Alert:
    key: str  # de-duplication key: "storm", "heavy_rain" or "cyclone:<id>"
    kind: str  # "storm" | "heavy_rain" | "cyclone"
    tier: int  # re-send before the cooldown ends only when this rises
    title: str
    body: str
    url: str
    tag: str
    urgent: bool = False  # asks the push service for high urgency; urgent cyclones also bypass quiet hours

    def payload(self) -> dict:
        return {
            "title": self.title,
            "body": self.body,
            "lang": msg.LANG,
            "url": self.url,
            "tag": self.tag,
            "kind": self.kind,
        }


def local_hour(now: datetime) -> int:
    return (now.astimezone(UTC) + BANGKOK).hour


def in_quiet_hours(prefs: Prefs, hour: int) -> bool:
    s, e = prefs.quiet_start, prefs.quiet_end
    if s == e:
        return False
    return s <= hour < e if s < e else hour >= s or hour < e


def location_url(sub: Subscription) -> str:
    return f"/?lat={sub.lat:.2f}&lon={sub.lon:.2f}"


def candidates(
    sub: Subscription,
    nowcast: dict | None,
    cyclones: list[tuple[Cyclone, dict]],
) -> list[Alert]:
    """Alerts the conditions justify for one subscription (before de-duplication / quiet hours).

    ``nowcast`` is ``point_nowcast`` output, or None when radar data is unusable (stale / no coverage).
    ``cyclones`` pairs each active cyclone with its ``proximity`` to the subscription's point.
    """
    out: list[Alert] = []
    url, short = location_url(sub), sub.id[:8]
    prefs = sub.prefs

    if nowcast is not None and (prefs.storm or prefs.heavy_rain):
        now_cls = (nowcast.get("now") or {}).get("class", "none")
        storm, rain = nowcast.get("eta_storm"), nowcast.get("eta_rain")
        # a "0 minute" ETA means it is already here, even if the point sample itself shows nothing
        here = (
            now_cls
            if RANK[now_cls] >= 1
            else next((e["class"] for e in (storm, rain) if e and e["minutes"] == 0), "none")
        )
        body = msg.with_label(sub.label, msg.detail(nowcast))

        storm_cls, storm_title = None, ""
        if RANK[here] >= RANK["thunderstorm"]:
            storm_cls, storm_title = here, msg.present(here)
        elif storm and storm["minutes"] <= ETA_LIMIT_MIN:
            storm_cls, storm_title = storm["class"], msg.arrival(storm)

        if storm_cls is not None and prefs.storm:
            out.append(
                Alert("storm", "storm", RANK[storm_cls], storm_title, body, url, f"thwx-storm-{short}", urgent=True)
            )
        elif prefs.heavy_rain:  # (a storm cell is also heavy rain when storm alerts are switched off)
            if storm_cls is not None:
                cls, title = storm_cls, storm_title
            elif RANK[here] >= RANK["heavy"]:
                cls, title = here, msg.present(here)
            elif rain and RANK[rain["class"]] >= RANK["heavy"] and rain["minutes"] <= ETA_LIMIT_MIN:
                cls, title = rain["class"], msg.arrival(rain)
            else:
                cls, title = None, ""
            if cls is not None:
                out.append(Alert("heavy_rain", "heavy_rain", RANK[cls], title, body, url, f"thwx-rain-{short}"))

    if prefs.cyclone:
        for c, prox in cyclones:
            zone = prox["in_wind_zone_kmh"]
            closest = prox["closest"]
            near = closest["distance_km"] <= CYCLONE_APPROACH_KM and closest["hours"] <= CYCLONE_WITHIN_H
            if not (zone or near):
                continue
            tier = (3 if zone >= 120 else 2) if zone else 1
            out.append(
                Alert(
                    f"cyclone:{c.id}",
                    "cyclone",
                    tier,
                    msg.cyclone_title(c.name, c.category, prox),
                    msg.with_label(sub.label, msg.cyclone_sentence(c.name, c.category, c.peak_category, prox)),
                    url,
                    f"thwx-cyclone-{c.id}-{short}",
                    urgent=tier >= 2,  # inside a forecast wind swath: worth waking someone for
                )
            )
    return out


def allowed(sub: Subscription, alert: Alert, now: datetime) -> bool:
    """De-duplication and quiet hours."""
    if in_quiet_hours(sub.prefs, local_hour(now)) and not (alert.kind == "cyclone" and alert.urgent):
        return False
    last = sub.last_sent.get(alert.key)
    if last is not None and now.timestamp() - last[0] < COOLDOWN_S[alert.kind] and alert.tier <= last[1]:
        return False
    return True


class PushDispatcher:
    def __init__(
        self,
        store: SubscriptionStore,
        nowcast: NowcastService,
        sender: Sender,
        workers: int = 8,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.store, self.nowcast, self.sender, self.workers, self.clock = store, nowcast, sender, workers, clock
        self._run_lock = threading.Lock()
        self.last_run: dict | None = None

    def on_update(self, kind: str) -> None:
        """Hook for ``NowcastService``: ``kind`` is "radar" (new frame) or "cyclones" (refresh)."""
        try:
            self.run(kind)
        except Exception:
            log.exception("push dispatch failed")

    def _radar_ok(self, now: datetime) -> bool:
        snap = self.nowcast.snapshot()
        if not self.nowcast.radar_enabled or snap.frame_time is None or snap.latest is None or snap.u is None:
            return False
        return (now - snap.frame_time).total_seconds() / 60.0 <= STALE_AFTER_MIN

    def run(self, kind: str = "radar") -> dict:
        if not self._run_lock.acquire(blocking=False):
            return {"skipped": "busy"}
        try:
            now = self.clock()
            subs = self.store.all()
            stats = {
                "time": now.isoformat(),
                "kind": kind,
                "subscriptions": len(subs),
                "sent": 0,
                "failed": 0,
                "removed": 0,
            }
            snap = self.nowcast.snapshot()
            use_radar = kind == "radar" and self._radar_ok(now)
            stats["radar_ok"] = use_radar
            grid = self.nowcast.grid
            cache: dict[tuple[float, float], dict | None] = {}
            cyc_cache: dict[tuple[str, float, float], dict] = {}
            work: list[tuple[Subscription, Alert]] = []
            for sub in subs:
                nc = None
                if use_radar and (sub.prefs.storm or sub.prefs.heavy_rain):
                    pos = (sub.lat, sub.lon)
                    if pos not in cache:
                        cache[pos] = self._nowcast_at(snap, grid, sub)
                    nc = cache[pos]
                cyc: list[tuple[Cyclone, dict]] = []
                if sub.prefs.cyclone:
                    for c in snap.cyclones:
                        ck = (c.id, sub.lat, sub.lon)
                        if ck not in cyc_cache:
                            cyc_cache[ck] = proximity(c, sub.lat, sub.lon, now)
                        cyc.append((c, cyc_cache[ck]))
                work.extend((sub, a) for a in candidates(sub, nc, cyc) if allowed(sub, a, now))
            stats["alerts"] = len(work)
            if work:
                with ThreadPoolExecutor(max_workers=self.workers) as pool:
                    for res in pool.map(lambda w: self._deliver(w[0], w[1], now), work):
                        stats[res] += 1
            self.last_run = stats
            if work:
                log.info("push: %s", {k: v for k, v in stats.items() if k != "time"})
            return stats
        finally:
            self._run_lock.release()

    @staticmethod
    def _nowcast_at(snap, grid, sub: Subscription) -> dict | None:
        if not grid.contains(sub.lat, sub.lon):
            return None
        iy, ix = grid.index(sub.lat, sub.lon)
        if snap.coverage is not None and not snap.coverage[iy, ix]:
            return None
        return point_nowcast(snap.latest, snap.u, snap.v, grid, sub.lat, sub.lon, snap.coverage)

    def _deliver(self, sub: Subscription, alert: Alert, now: datetime) -> str:
        try:
            self.sender(sub, alert.payload(), ttl=TTL_S[alert.kind], urgent=alert.urgent)
        except PushGone:
            self.store.delete(sub.id)
            return "removed"
        except PushFailed as exc:
            log.warning("push to subscription %s failed: %s", sub.id[:8], exc)
            return "failed"
        self.store.record_sent(sub.id, alert.key, now.timestamp(), alert.tier)
        return "sent"
