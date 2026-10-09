"""Regular latitude/longitude grids used by the system.

The *fine* grid is the analysis grid the downscaling engine produces
(0.02° ≈ 2.2 km).  The *coarse* grid mimics the global driving model
(0.2° ≈ 22 km) – the resolution problem this project addresses.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property

import numpy as np

# Domain covering Thailand plus a margin for neighbouring terrain / sea.
LAT0, LAT1 = 5.5, 20.5
LON0, LON1 = 97.3, 105.7

KM_PER_DEG = 111.32


@dataclass(frozen=True)
class Grid:
    lat0: float
    lat1: float
    lon0: float
    lon1: float
    dlat: float
    dlon: float

    @cached_property
    def ny(self) -> int:
        return int(round((self.lat1 - self.lat0) / self.dlat)) + 1

    @cached_property
    def nx(self) -> int:
        return int(round((self.lon1 - self.lon0) / self.dlon)) + 1

    @property
    def shape(self) -> tuple[int, int]:
        return self.ny, self.nx

    @cached_property
    def lats(self) -> np.ndarray:
        return self.lat0 + np.arange(self.ny) * self.dlat

    @cached_property
    def lons(self) -> np.ndarray:
        return self.lon0 + np.arange(self.nx) * self.dlon

    @property
    def resolution_km(self) -> float:
        return round(self.dlat * KM_PER_DEG, 1)

    def index(self, lat: float, lon: float) -> tuple[int, int]:
        """Nearest grid index for a coordinate (clipped to the domain)."""
        iy = int(np.clip(round((lat - self.lat0) / self.dlat), 0, self.ny - 1))
        ix = int(np.clip(round((lon - self.lon0) / self.dlon), 0, self.nx - 1))
        return iy, ix

    def contains(self, lat: float, lon: float) -> bool:
        return self.lat0 <= lat <= self.lat1 and self.lon0 <= lon <= self.lon1

    def fractional_index(self, lats: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return (lats - self.lat0) / self.dlat, (lons - self.lon0) / self.dlon

    def describe(self) -> dict:
        return {
            "lat0": self.lat0,
            "lat1": self.lat1,
            "lon0": self.lon0,
            "lon1": self.lon1,
            "dlat": self.dlat,
            "dlon": self.dlon,
            "ny": self.ny,
            "nx": self.nx,
            "resolution_km": self.resolution_km,
        }


FINE_GRID = Grid(LAT0, LAT1, LON0, LON1, 0.02, 0.02)
COARSE_GRID = Grid(LAT0, LAT1, LON0, LON1, 0.2, 0.2)


def grid_for(spacing_deg: float) -> Grid:
    return Grid(LAT0, LAT1, LON0, LON1, spacing_deg, spacing_deg)
