"""Wires the push pieces together for the application (``app.state.push``)."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path

from ..config import Settings
from ..nowcast.service import NowcastService
from .dispatcher import PushDispatcher
from .heat import HeatSource
from .sender import Sender, WebPushSender
from .store import SubscriptionStore
from .vapid import VapidKeys, load_or_create

log = logging.getLogger(__name__)

HEAT_EVERY_S = 5 * 60


def heat_max_age(settings: Settings) -> timedelta:
    """A run older than two refresh periods (+1 h for a slow fetch) means updates stopped: don't alert from it."""
    return timedelta(minutes=2 * max(settings.refresh_minutes, 60) + 60)


class PushService:
    def __init__(
        self,
        settings: Settings,
        nowcast: NowcastService,
        sender: Sender | None = None,
        latest_run: Callable[[], object | None] | None = None,
    ) -> None:
        self.keys: VapidKeys = load_or_create(settings)
        self.store = SubscriptionStore(Path(settings.data_dir) / "push")
        self.sender: Sender = sender or WebPushSender(self.keys)
        heat = HeatSource(latest_run, heat_max_age(settings)) if latest_run is not None else None
        self.dispatcher = PushDispatcher(self.store, nowcast, self.sender, heat=heat)
        nowcast.add_listener(self.dispatcher.on_update)
        self._stop = threading.Event()
        self._heat_thread: threading.Thread | None = None

    def start(self) -> None:
        """Check the forecast heat index every few minutes (runs whether or not the radar is enabled)."""
        if self.dispatcher.heat is None or self._heat_thread is not None:
            return

        def loop() -> None:
            while not self._stop.wait(HEAT_EVERY_S):
                try:
                    self.dispatcher.run_heat()
                except Exception:
                    log.exception("heat push check failed")

        self._heat_thread = threading.Thread(target=loop, name="push-heat", daemon=True)
        self._heat_thread.start()

    def status(self) -> dict:
        return {
            "enabled": True,
            "subscriptions": self.store.count(),
            "limit": self.store.limit,
            "last_run": self.dispatcher.last_run,
            "last_heat_run": self.dispatcher.last_heat_run,
        }

    def close(self) -> None:
        # stop the heat worker (and wait for a check in progress) before the store goes away
        self._stop.set()
        if self._heat_thread is not None:
            self._heat_thread.join(timeout=30)
            self._heat_thread = None
        self.store.close()
