"""Common data model for coarse driving-model forecasts."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

import numpy as np

from ..core.grid import Grid

# Variables a source must provide, all shaped (nt, ny, nx) on ``grid``:
#   t2m   2 m temperature (°C)          td2m  2 m dew point (°C)
#   precip  precipitation rate (mm/h)   cape  CAPE (J/kg)
#   u10, v10  10 m wind (m/s)           u850, v850  steering-level wind (m/s)
#   cloud  total cloud cover (%)        sw  shortwave radiation (W/m²)
#   psfc  surface pressure (hPa)
REQUIRED_VARS = ("t2m", "td2m", "precip", "cape", "u10", "v10", "u850", "v850", "cloud", "sw", "psfc")


@dataclass
class CoarseForecast:
    source: str
    model: str
    grid: Grid
    times: list[datetime]  # UTC, hourly
    orography: np.ndarray  # model grid-cell elevation (m)
    fields: dict[str, np.ndarray]
    issued: datetime
    demo: bool = False
    notes: list[str] = field(default_factory=list)

    def validate(self) -> None:
        nt = len(self.times)
        for v in REQUIRED_VARS:
            if v not in self.fields:
                raise ValueError(f"source {self.source} is missing variable {v}")
            if self.fields[v].shape != (nt, *self.grid.shape):
                raise ValueError(f"{v} has shape {self.fields[v].shape}, expected {(nt, *self.grid.shape)}")
        if self.orography.shape != self.grid.shape:
            raise ValueError("orography shape mismatch")


class Source(Protocol):
    name: str

    def fetch(self, start: datetime, hours: int) -> CoarseForecast: ...
