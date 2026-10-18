"""Background refresh loop: fetch driving model → downscale → publish run."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime, timedelta

from .config import Settings
from .core.static import load_static
from .downscale import calibration, rainmlp, tempbias, tempmlp
from .downscale.observations import Observation
from .downscale.pipeline import Downscaler
from .sources.base import Source
from .sources.openmeteo import OpenMeteoSource
from .sources.synthetic import SyntheticSource
from .store import RunStore

log = logging.getLogger(__name__)
RETRY_MINUTES = 30  # after a failed run


def build_source(settings: Settings) -> Source:
    if settings.source == "open-meteo":
        return OpenMeteoSource(
            model=settings.openmeteo_model,
            spacing_deg=settings.openmeteo_spacing,
            api_key=settings.openmeteo_api_key,
            calls_per_minute=None if settings.openmeteo_api_key else settings.openmeteo_calls_per_minute,
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
            # the chance-of-rain calibration `verify calibrate` refits daily (identity until there is enough data)
            pop_cal = calibration.load(self.settings.data_dir)
            # the stations' learned temperature bias `verify tempbias` refits daily (none until enough pairs)
            temp_bias = tempbias.load(self.settings.data_dir)
            # the neural network, only once `verify` found it better than the hourly bias
            temp_mlp = tempmlp.load(self.settings.data_dir)
            rain_mlp = rainmlp.load(self.settings.data_dir)
            stations = rainmlp.load_stations(self.settings.data_dir)
            run_id = Downscaler(
                load_static(), self.settings.ensemble_members, pop_cal, temp_bias, temp_mlp, rain_mlp, stations
            ).run(coarse, self.store, self.observations.snapshot())
            self.status.update(state="idle", last_error=None, last_success=datetime.now(UTC).isoformat())
            return run_id
        except Exception as exc:
            log.exception("forecast run failed")
            self.status.update(state="error", last_error=f"{exc.__class__.__name__}: {exc}")
            return None
        finally:
            self._lock.release()

    def first_wait_s(self, now: datetime | None = None) -> float:
        """Seconds until the first run: none when the latest run is due, otherwise when it falls due.

        Every deploy restarts the API; fetching the whole grid again each time spent Open-Meteo's
        hourly quota (429) for a forecast that was minutes old.
        """
        if not self.settings.run_on_startup:
            return self.settings.refresh_minutes * 60
        run = self.store.latest()
        created = (run.meta.get("created") if run else None) or None
        if not created or run.meta.get("demo"):
            return 0.0
        age = ((now or datetime.now(UTC)) - datetime.fromisoformat(created)).total_seconds()
        return max(0.0, self.settings.refresh_minutes * 60 - age)

    def start(self) -> None:
        def loop() -> None:
            wait = self.first_wait_s()
            while not self._stop.wait(wait):
                ok = self.run_once() is not None
                # a failed fetch (quota, network) is retried soon instead of a whole interval later
                wait = self.settings.refresh_minutes * 60 if ok else RETRY_MINUTES * 60

        self._thread = threading.Thread(target=loop, name="refresher", daemon=True)
        self._thread.start()

    def trigger(self) -> None:
        threading.Thread(target=self.run_once, name="refresh-now", daemon=True).start()

    def stop(self, *, wait: bool = False) -> None:
        self._stop.set()
        if wait:
            if self._thread is not None:
                self._thread.join()
            # A manually requested run uses a separate thread but the same writer lock.
            with self._lock:
                pass
