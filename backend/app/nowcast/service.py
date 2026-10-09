"""Background service: keeps the latest radar state and the active cyclones up to date.

One thread polls RainViewer every few minutes (cheap: a single JSON request unless a new
10-minute frame appeared) and GDACS every 30 minutes.  Everything the API needs is published
as one immutable snapshot, swapped atomically, so request handlers never see a half-updated
state.  Failures are logged and the last good snapshot is kept; the API reports staleness.
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from statistics import median

import httpx
import numpy as np

from ..config import Settings
from ..core.grid import Grid
from ..core.static import load_static
from ..downscale.layers import Encoding
from .cyclones import Cyclone, fetch_active
from .motion import estimate_motion
from .nowcast import advect
from .radar import RadarSource

log = logging.getLogger(__name__)

LEADS = (0, 10, 20, 30, 40, 50, 60)  # minutes ahead, available as map layers
RADAR_ENCODING = Encoding("linear", -10.0, 75.0)  # dBZ -> uint8; code 0 = no echo
STALE_AFTER_MIN = 30
CYCLONE_REFRESH_S = 30 * 60
KEEP_FRAMES = 3


@dataclass(frozen=True)
class Snapshot:
    """Everything the API serves, computed from one radar frame."""

    frame_time: datetime | None = None
    latest: np.ndarray | None = None  # dBZ on the grid, NaN = no echo / outside coverage
    u: np.ndarray | None = None  # km/h east
    v: np.ndarray | None = None  # km/h north
    coverage: np.ndarray | None = None
    layers: dict[int, np.ndarray] = field(default_factory=dict)  # lead (min) -> uint8 codes
    cyclones: tuple[Cyclone, ...] = ()
    cyclones_updated: datetime | None = None


class NowcastService:
    def __init__(self, settings: Settings, grid: Grid | None = None) -> None:
        self.settings = settings
        self.grid = grid or load_static().grid
        self.radar_enabled = settings.nowcast_source != "off"
        self.cyclones_enabled = settings.cyclones_enabled
        self._snapshot = Snapshot()
        self._frames: deque[tuple[datetime, np.ndarray]] = deque(maxlen=KEEP_FRAMES)
        self._lock = threading.Lock()
        self._poll_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._http: httpx.Client | None = None
        self._radar: RadarSource | None = None
        self._status: dict = {
            "radar_enabled": self.radar_enabled,
            "cyclones_enabled": self.cyclones_enabled,
            "source": settings.nowcast_source,
            "state": "idle",
            "last_frame": None,
            "last_poll": None,
            "last_error": None,
            "cyclones_updated": None,
            "cyclones": 0,
            "cyclones_error": None,
        }

    # ------------------------------------------------------------ state access
    @property
    def enabled(self) -> bool:
        return self.radar_enabled or self.cyclones_enabled

    def snapshot(self) -> Snapshot:
        return self._snapshot

    @property
    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    def _update_status(self, **kw) -> None:
        with self._lock:
            self._status.update(kw)

    # ----------------------------------------------------------------- compute
    def ingest(self, frames: list[tuple[datetime, np.ndarray]], coverage: np.ndarray | None = None) -> Snapshot:
        """Compute motion and lead-time layers from decoded frames (oldest first) and publish them."""
        if not frames:
            raise ValueError("need at least one frame")
        cov = coverage if coverage is not None else np.ones(self.grid.shape, dtype=bool)
        masked = [np.where(cov, f, np.nan).astype(np.float32) for _, f in frames]
        times = [t for t, _ in frames]
        gaps = [(b - a).total_seconds() / 60.0 for a, b in zip(times, times[1:], strict=False)]
        dt_min = max(median(gaps), 1.0) if gaps else 10.0
        u, v = estimate_motion(masked, dt_min, self.grid)
        latest = masked[-1]
        layers = {lead: RADAR_ENCODING.encode(advect(latest, u, v, self.grid, lead)) for lead in LEADS}
        with self._lock:
            self._snapshot = replace(
                self._snapshot, frame_time=times[-1], latest=latest, u=u, v=v, coverage=cov, layers=layers
            )
            self._status.update(last_frame=times[-1].isoformat())
            return self._snapshot

    def set_cyclones(self, cyclones: list[Cyclone], when: datetime | None = None) -> None:
        when = when or datetime.now(UTC)
        with self._lock:
            self._snapshot = replace(self._snapshot, cyclones=tuple(cyclones), cyclones_updated=when)
            self._status.update(cyclones_updated=when.isoformat(), cyclones=len(cyclones), cyclones_error=None)

    # ------------------------------------------------------------------ polling
    def _client(self) -> httpx.Client:
        if self._http is None:
            self._http = httpx.Client(
                timeout=30.0, headers={"User-Agent": "thai-weather-hd/1.0"}, follow_redirects=True
            )
        return self._http

    def poll_radar(self) -> bool:
        """Ingest any new RainViewer frames; True when the snapshot changed."""
        if self._radar is None:
            self._radar = RadarSource(self._client())
        radar = self._radar
        listing = radar.frames()[-KEEP_FRAMES:]
        if not listing:
            return False
        known = self._frames[-1][0] if self._frames else None
        fresh = [f for f in listing if known is None or f[0] > known]
        if not fresh:
            return False
        if known is not None and known < listing[0][0]:
            self._frames.clear()  # we missed frames: the buffer would not be consecutive
        for t, path in fresh:
            self._frames.append((t, radar.fetch_frame(radar.host, path, self.grid)))
        self.ingest(list(self._frames), radar.coverage(self.grid))
        return True

    def poll_cyclones(self) -> None:
        self.set_cyclones(fetch_active(self._client()))

    def run_once(self, cyclones_due: bool = True) -> None:
        if not self._poll_lock.acquire(blocking=False):
            return
        try:
            self._update_status(state="running", last_poll=datetime.now(UTC).isoformat())
            error = None
            if self.radar_enabled:
                try:
                    self.poll_radar()
                except Exception as exc:
                    log.exception("radar poll failed")
                    error = f"{exc.__class__.__name__}: {exc}"
            if self.cyclones_enabled and cyclones_due:
                try:
                    self.poll_cyclones()
                except Exception as exc:
                    log.exception("cyclone poll failed")
                    self._update_status(cyclones_error=f"{exc.__class__.__name__}: {exc}")
            self._update_status(state="error" if error else "idle", last_error=error)
        finally:
            self._poll_lock.release()

    def start(self) -> None:
        if not self.enabled or self._thread is not None:
            return

        def loop() -> None:
            elapsed = 0.0
            period = max(self.settings.nowcast_poll_minutes, 1) * 60.0
            self.run_once(cyclones_due=True)
            while not self._stop.wait(period):
                elapsed += period
                due = elapsed >= CYCLONE_REFRESH_S
                if due:
                    elapsed = 0.0
                self.run_once(cyclones_due=due)

        self._thread = threading.Thread(target=loop, name="nowcast", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._http is not None:
            self._http.close()
