"""Wires the push pieces together for the application (``app.state.push``)."""

from __future__ import annotations

from pathlib import Path

from ..config import Settings
from ..nowcast.service import NowcastService
from .dispatcher import PushDispatcher
from .sender import Sender, WebPushSender
from .store import SubscriptionStore
from .vapid import VapidKeys, load_or_create


class PushService:
    def __init__(self, settings: Settings, nowcast: NowcastService, sender: Sender | None = None) -> None:
        self.keys: VapidKeys = load_or_create(settings)
        self.store = SubscriptionStore(Path(settings.data_dir) / "push")
        self.sender: Sender = sender or WebPushSender(self.keys)
        self.dispatcher = PushDispatcher(self.store, nowcast, self.sender)
        nowcast.add_listener(self.dispatcher.on_update)

    def status(self) -> dict:
        return {
            "enabled": True,
            "subscriptions": self.store.count(),
            "limit": self.store.limit,
            "last_run": self.dispatcher.last_run,
        }

    def close(self) -> None:
        self.store.close()
