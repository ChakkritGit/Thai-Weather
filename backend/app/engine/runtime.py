"""One owner of the numerical workers, with no HTTP-server dependency."""

from __future__ import annotations

import fcntl
from types import SimpleNamespace

from ..config import Settings
from ..core.static import load_static
from ..extras.air import AirService
from ..extras.met import MetClient
from ..extras.pmforecast import PmForecast
from ..nowcast.service import NowcastService
from ..push.service import PushService
from ..scheduler import ObservationBuffer, Refresher
from ..store import RunStore


class Services(SimpleNamespace):
    """Serve-only mode is enforced here, not merely by delaying the first forecast."""

    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self.settings = settings
        self._lease = None
        self._started = False
        load_static()
        self.store = RunStore(settings.data_dir)
        self.observations = ObservationBuffer()
        self.refresher = Refresher(settings, self.store, self.observations)
        self.nowcast = NowcastService(settings)
        self.push = None
        self.met = None
        self.air = None
        self.pm = None
        self.store.latest()

    def start(self) -> None:
        if self._started or not self.settings.background_tasks:
            return
        # Multiple HTTP processes may read runs, but only one may poll or publish them.
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        lease = (self.settings.data_dir / "engine.lock").open("a")
        try:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lease.close()
            raise RuntimeError("another numerical worker owns this data directory") from None
        self._lease = lease
        if self.settings.push_enabled:
            self.push = PushService(self.settings, self.nowcast, latest_run=self.store.latest)
        if self.settings.extras_enabled:
            self.met = MetClient()
            self.air = AirService()
            self.pm = PmForecast()
            self.air.start()
            self.pm.start()
        self.refresher.start()
        self.nowcast.start()
        if self.push is not None:
            self.push.start()
        self._started = True

    def close(self) -> None:
        self.refresher.stop(wait=True)
        self.nowcast.stop()
        if self.air is not None:
            self.air.stop()
        if self.pm is not None:
            self.pm.stop()
        if self.push is not None:
            self.push.close()
        if self.met is not None:
            self.met.client.close()
        # Never hand the writer lease to a replacement while a forecast is publishing.
        if self._lease is not None:
            self._lease.close()
            self._lease = None
