"""Free public API: per-client request limits (no key needed).

The client is the ``X-Real-IP`` the reverse proxy sets from Cloudflare's ``CF-Connecting-IP``; a request
without it came from inside the private network (the web server rendering a page, verify) and is not
limited.  Requests the site's own pages make (``Sec-Fetch-Site: same-origin``) only meet a flood guard,
so people sharing one carrier-NAT address can still use the map; everything else gets the free quota:
a per-minute token bucket plus a daily count that resets at 00:00 Bangkok time.

Test oracle for the original single-process quota; production uses rust-api/src/quota.rs.
"""

from __future__ import annotations

import json
import math
import time
from collections import OrderedDict
from dataclasses import dataclass

from starlette.types import ASGIApp, Message, Receive, Scope, Send

BKK_OFFSET_S = 7 * 3600
MAX_CLIENTS = 50_000
EXEMPT_PATHS = ("/api/v1/health",)


@dataclass
class Bucket:
    tokens: float
    at: float
    day: int
    used_today: int = 0


@dataclass(frozen=True)
class Tier:
    name: str
    per_min: int
    per_day: int


def bkk_day(now: float) -> int:
    return int((now + BKK_OFFSET_S) // 86400)


def seconds_to_bkk_midnight(now: float) -> int:
    return int(86400 - (now + BKK_OFFSET_S) % 86400) + 1


class Limiter:
    def __init__(self, clock=time.time) -> None:
        self.clock = clock
        self.buckets: OrderedDict[tuple[str, str], Bucket] = OrderedDict()

    def take(self, client: str, tier: Tier) -> tuple[bool, dict[str, str], int]:
        """Spend one request. Returns (allowed, headers, retry_after_s)."""
        now = self.clock()
        key = (tier.name, client)
        b = self.buckets.get(key)
        if b is None:
            b = Bucket(tokens=float(tier.per_min), at=now, day=bkk_day(now))
            self.buckets[key] = b
            if len(self.buckets) > MAX_CLIENTS:
                self.buckets.popitem(last=False)
        else:
            self.buckets.move_to_end(key)
        rate = tier.per_min / 60.0
        b.tokens = min(float(tier.per_min), b.tokens + (now - b.at) * rate)
        b.at = now
        if b.day != bkk_day(now):
            b.day, b.used_today = bkk_day(now), 0

        retry = 0
        if b.used_today >= tier.per_day:
            retry = seconds_to_bkk_midnight(now)
        elif b.tokens < 1.0:
            retry = max(1, math.ceil((1.0 - b.tokens) / rate))
        else:
            b.tokens -= 1.0
            b.used_today += 1
        headers = {
            "X-RateLimit-Limit": str(tier.per_min),
            "X-RateLimit-Remaining": str(int(b.tokens)),
            "X-RateLimit-Reset": str(math.ceil((tier.per_min - b.tokens) / rate)),
            "X-RateLimit-Limit-Day": str(tier.per_day),
            "X-RateLimit-Remaining-Day": str(max(0, tier.per_day - b.used_today)),
        }
        return retry == 0, headers, retry


class RateLimitMiddleware:
    def __init__(self, app: ASGIApp, public: Tier, site: Tier, limiter: Limiter | None = None) -> None:
        self.app = app
        self.public = public
        self.site = site
        self.limiter = limiter or Limiter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/v1/") or path in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        client = headers.get("x-real-ip", "").strip()
        if not client or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)  # internal call, or a CORS preflight
            return
        own_site = headers.get("sec-fetch-site") == "same-origin"
        tier = self.site if own_site else self.public
        allowed, limit_headers, retry = self.limiter.take(client, tier)
        if own_site:
            limit_headers = {}  # the site's pages don't need them
        if not allowed:
            which = f"{tier.per_day}/day" if retry > 60 else f"{tier.per_min}/min"
            body = json.dumps(
                {
                    "error": "rate_limited",
                    "detail": f"Free API limit reached ({which} per IP). Retry after {retry} s.",
                    "retry_after": retry,
                    "docs": "https://thai-weather.chakkritton.com/developers",
                }
            ).encode()
            out = [
                (b"content-type", b"application/json"),
                (b"retry-after", str(retry).encode()),
                (b"access-control-allow-origin", b"*"),
                *[(k.lower().encode(), v.encode()) for k, v in limit_headers.items()],
            ]
            await send({"type": "http.response.start", "status": 429, "headers": out})
            await send({"type": "http.response.body", "body": body})
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start" and limit_headers:
                message["headers"] = [
                    *message.get("headers", []),
                    *[(k.lower().encode(), v.encode()) for k, v in limit_headers.items()],
                ]
            await send(message)

        await self.app(scope, receive, send_with_headers)
