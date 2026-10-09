"""Background refresh loop: fetch driving model → downscale → publish run."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime, timedelta

from .config import Settings
from .core.static import load_static
from .downscale.observations import Observation
from .downscale.pipeline import Downscaler
from .sources.base import Source
from .sources.openmeteo import OpenMeteoSource
from .sources.synthetic import SyntheticSource
from .store import RunStore

log = logging.getLogger(__name__)


def build_source(settings: Settings) -> Source:
    if settings.source == "open-meteo":
        return OpenMeteoSource(
            model=settings.openmeteo_model,
            spacing_deg=settings.openmeteo_spacing,
            api_key=settings.openmeteo_api_key,
        )
    return SyntheticSource()


class ObservationBuffer:
    """Thread-safe buffer of recent station observations (last 6 hours)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._obs: dict[tuple[str, datetime], Observation] = {}

    def add(self, items: list[Observation]) -> int:
        cutoff = datetime.now(UTC) - timedelta(hours=6)
        with self._lock:
            for o in items:
                self._obs[(o.station_id, o.time)] = o
            self._obs = {k: v for k, v in self._obs.items() if v.time >= cutoff}
            return len(self._obs)

    def snapshot(self) -> list[Observation]:
        with self._lock:
            return list(self._obs.values())


class Refresher:
    def __init__(self, settings: Settings, store: RunStore, observations: ObservationBuffer) -> None:
        self.settings = settings
        self.store = store
        self.observations = observations
        self.source = build_source(settings)
        self.status: dict = {"state": "idle", "last_error": None, "last_success": None}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self) -> str | None:
        if not self._lock.acquire(blocking=False):
            return None  # a run is already in progress
        try:
            self.status["state"] = "running"
            start = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
            try:
                coarse = self.source.fetch(start, self.settings.horizon_hours)
            except Exception as exc:  # network / upstream failure
                if not self.settings.fallback_to_demo or isinstance(self.source, SyntheticSource):
                    raise
                log.exception("source %s failed – falling back to demo data", self.source.name)
                coarse = SyntheticSource().fetch(start, self.settings.horizon_hours)
                coarse.notes.append(
                    f"Upstream source '{self.source.name}' failed ({exc.__class__.__name__}); demo data shown."
                )
            run_id = Downscaler(load_static(), self.settings.ensemble_members).run(
                coarse, self.store, self.observations.snapshot()
            )
            self.status.update(state="idle", last_error=None, last_success=datetime.now(UTC).isoformat())
            return run_id
        except Exception as exc:
            log.exception("forecast run failed")
            self.status.update(state="error", last_error=f"{exc.__class__.__name__}: {exc}")
            return None
        finally:
            self._lock.release()

    def start(self) -> None:
        def loop() -> None:
            if self.settings.run_on_startup:
                self.run_once()
            while not self._stop.wait(self.settings.refresh_minutes * 60):
                self.run_once()

        self._thread = threading.Thread(target=loop, name="refresher", daemon=True)
        self._thread.start()

    def trigger(self) -> None:
        threading.Thread(target=self.run_once, name="refresh-now", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
