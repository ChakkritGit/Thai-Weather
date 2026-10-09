"""The only place that talks to push services (through pywebpush).

Errors are reduced to a status code / exception name: pywebpush messages can echo the endpoint,
and subscription keys and endpoints are never logged.
"""

from __future__ import annotations

import json
from typing import Protocol

from pywebpush import WebPushException, webpush

from .store import Subscription
from .vapid import VapidKeys

TIMEOUT_S = 10.0


class PushGone(Exception):
    """The push service says the subscription no longer exists (HTTP 404/410)."""


class PushFailed(Exception):
    """Delivery failed for another reason (message carries no secrets)."""


class Sender(Protocol):
    def __call__(self, sub: Subscription, payload: dict, ttl: int = 3600, urgent: bool = False) -> None: ...


class WebPushSender:
    def __init__(self, keys: VapidKeys) -> None:
        self._keys = keys

    def __call__(self, sub: Subscription, payload: dict, ttl: int = 3600, urgent: bool = False) -> None:
        try:
            webpush(
                subscription_info=sub.info(),
                data=json.dumps(payload, ensure_ascii=False),
                vapid_private_key=self._keys.private,
                vapid_claims={"sub": self._keys.subject},  # pywebpush adds aud/exp to (a copy of) this dict
                ttl=ttl,
                timeout=TIMEOUT_S,
                headers={"Urgency": "high"} if urgent else None,
            )
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                raise PushGone from None
            raise PushFailed(f"push service answered {status}") from None
        except Exception as exc:
            raise PushFailed(exc.__class__.__name__) from None
