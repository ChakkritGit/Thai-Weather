"""Small transport-independent results; no ASGI or HTTP server dependencies."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class ProductError(Exception):
    def __init__(self, status_code: int, detail: str = "Not Found") -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass
class Context:
    state: Any
    headers: dict[str, str] = field(default_factory=dict)


class Product:
    def __init__(
        self,
        content: bytes | str = b"",
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        media_type: str | None = None,
    ) -> None:
        self.body = content.encode("utf-8") if isinstance(content, str) else content
        self.status_code = status_code
        self.headers = dict(headers or {})
        self.media_type = media_type
