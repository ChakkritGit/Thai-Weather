"""VAPID key handling.

Keys come from the environment (``THWX_VAPID_PRIVATE_KEY`` / ``THWX_VAPID_PUBLIC_KEY``) or, when
unset, are generated once and persisted to ``<data_dir>/push/vapid.json`` (mode 0600) so a restart
keeps existing browser subscriptions valid (a subscription is bound to the public key).

Format: the private key is the raw 32-byte P-256 scalar and the public key the 65-byte
uncompressed point, both base64url without padding (what ``pywebpush`` and ``web-push`` use).
"""

from __future__ import annotations

import base64
import contextlib
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from ..config import Settings

log = logging.getLogger(__name__)

DEFAULT_SUBJECT = "mailto:admin@example.com"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


@dataclass(frozen=True)
class VapidKeys:
    public: str  # base64url uncompressed point: what the browser passes as applicationServerKey
    private: str  # base64url raw scalar: never logged, never served
    subject: str

    def __repr__(self) -> str:  # keep the private key out of logs and tracebacks
        return f"VapidKeys(public={self.public!r}, subject={self.subject!r})"


def _private_to_str(key: ec.EllipticCurvePrivateKey) -> str:
    return b64url(key.private_numbers().private_value.to_bytes(32, "big"))


def _public_of(key: ec.EllipticCurvePrivateKey) -> str:
    raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64url(raw)


def generate() -> tuple[str, str]:
    """A fresh (private, public) pair."""
    key = ec.generate_private_key(ec.SECP256R1())
    return _private_to_str(key), _public_of(key)


def public_from_private(private: str) -> str:
    raw = b64url_decode(private.strip())
    if len(raw) != 32:
        raise ValueError("VAPID private key must be a raw 32-byte value, base64url encoded")
    return _public_of(ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1()))


def load_or_create(settings: Settings) -> VapidKeys:
    subject = settings.vapid_subject.strip() or DEFAULT_SUBJECT
    if subject == DEFAULT_SUBJECT:
        log.warning("THWX_VAPID_SUBJECT is the placeholder %s - set a real contact (see docs/PUSH.md)", subject)
    if settings.vapid_private_key:
        private = settings.vapid_private_key.strip()
        public = public_from_private(private)  # derived, so a mismatching env public key cannot break pushes
        if settings.vapid_public_key and settings.vapid_public_key.strip() != public:
            log.warning("THWX_VAPID_PUBLIC_KEY does not match THWX_VAPID_PRIVATE_KEY; using the derived public key")
        return VapidKeys(public, private, subject)

    path = Path(settings.data_dir) / "push" / "vapid.json"
    if path.exists():
        data = json.loads(path.read_text())
        return VapidKeys(public_from_private(data["private"]), data["private"], subject)
    path.parent.mkdir(parents=True, exist_ok=True)
    private, public = generate()
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({"private": private, "public": public}, fh)
    with contextlib.suppress(OSError):  # best effort on filesystems without POSIX modes
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    log.info("generated a new VAPID key pair at %s", path)
    return VapidKeys(public, private, subject)
