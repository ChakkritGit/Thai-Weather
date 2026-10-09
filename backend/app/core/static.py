"""High-resolution static layers and the terrain descriptors derived from them."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache, cached_property
from pathlib import Path

import numpy as np
from scipy import ndimage

from .cities import CITIES
from .grid import FINE_GRID, KM_PER_DEG, Grid

DATA_DIR = Path(__file__).resolve().parents[1] / "data"


@dataclass
class StaticLayers:
    grid: Grid
    elev: np.ndarray  # m, cell mean
    elev_std: np.ndarray  # m, sub-grid standard deviation
    land: np.ndarray  # bool
    thai: np.ndarray  # bool
    province: np.ndarray  # uint8 index into provinces (0 = none)
    provinces: list[dict]

    @property
    def dx_m(self) -> np.ndarray:
        """Zonal grid spacing per row (m)."""
        return self.grid.dlon * KM_PER_DEG * 1000.0 * np.cos(np.radians(self.grid.lats))

    @property
    def dy_m(self) -> float:
        return self.grid.dlat * KM_PER_DEG * 1000.0

    def _smooth_km(self, field: np.ndarray, km: float) -> np.ndarray:
        sigma = km / (self.grid.dlat * KM_PER_DEG)
        return ndimage.gaussian_filter(field, sigma, mode="nearest")

    @cached_property
    def elev_land(self) -> np.ndarray:
        """Elevation with sea floor clamped to sea level (what the air 'sees')."""
        return np.where(self.land, np.maximum(self.elev, 0.0), 0.0).astype(np.float32)

    @cached_property
    def slope(self) -> tuple[np.ndarray, np.ndarray]:
        """Terrain gradient (dz/dx east, dz/dy north) of 3 km–smoothed terrain."""
        z = self._smooth_km(self.elev_land, 2.0)
        dzdy, dzdx = np.gradient(z)
        return (dzdx / self.dx_m[:, None]).astype(np.float32), (dzdy / self.dy_m).astype(np.float32)

    @cached_property
    def tpi_km(self) -> np.ndarray:
        """Topographic position index (km): <0 valleys/basins, >0 ridges."""
        return ((self.elev_land - self._smooth_km(self.elev_land, 8.0)) / 1000.0).astype(np.float32)

    @cached_property
    def curvature(self) -> np.ndarray:
        """Scaled terrain curvature in [-0.5, 0.5] (Liston & Elder 2006)."""
        z = self._smooth_km(self.elev_land, 2.0)
        convex = -ndimage.laplace(z)  # > 0 on ridges and peaks
        return (convex / (8.0 * convex[self.land].std() + 1e-6)).clip(-0.5, 0.5).astype(np.float32)

    @cached_property
    def land_frac(self) -> np.ndarray:
        """Fraction of land within ~3 km – what a 2 km cell actually contains."""
        return self._smooth_km(self.land.astype(np.float32), 1.5).astype(np.float32)

    @cached_property
    def coast_km(self) -> np.ndarray:
        """Signed distance to the coastline in km (+ inland, − offshore)."""
        cell_km = self.grid.dlat * KM_PER_DEG
        inland = ndimage.distance_transform_edt(self.land) * cell_km
        offshore = ndimage.distance_transform_edt(~self.land) * cell_km
        return np.where(self.land, inland, -offshore).astype(np.float32)

    @cached_property
    def uhi_kernel(self) -> np.ndarray:
        """Night-time urban heat island potential (°C) on the fine grid."""
        lat2 = self.grid.lats[:, None]
        lon2 = self.grid.lons[None, :]
        out = np.zeros(self.grid.shape, dtype=np.float32)
        for c in CITIES:
            dy = (lat2 - c["lat"]) * KM_PER_DEG
            dx = (lon2 - c["lon"]) * KM_PER_DEG * np.cos(np.radians(c["lat"]))
            out += c["uhi"] * np.exp(-(dx**2 + dy**2) / c["radius_km"] ** 2)
        return np.where(self.land, out, 0.0).astype(np.float32)

    def block_mean(self, field: np.ndarray, coarse: Grid) -> np.ndarray:
        """Area-mean of a fine field over each coarse cell (on the coarse grid)."""
        from scipy.interpolate import RegularGridInterpolator

        km = coarse.dlat * KM_PER_DEG
        smooth = ndimage.uniform_filter(field, size=max(1, int(round(km / (self.grid.dlat * KM_PER_DEG)))))
        interp = RegularGridInterpolator((self.grid.lats, self.grid.lons), smooth, bounds_error=False, fill_value=None)
        lat2, lon2 = np.meshgrid(coarse.lats, coarse.lons, indexing="ij")
        return interp((lat2, lon2)).astype(np.float32)

    def province_by_id(self, pid: str) -> dict | None:
        return next((p for p in self.provinces if p["id"] == pid), None)


@cache
def load_static() -> StaticLayers:
    d = np.load(DATA_DIR / "static_th.npz")
    provinces = json.loads((DATA_DIR / "provinces.json").read_text())
    layers = StaticLayers(
        grid=FINE_GRID,
        elev=d["elev"].astype(np.float32),
        elev_std=d["elev_std"].astype(np.float32),
        land=d["land"].astype(bool),
        thai=d["thai"].astype(bool),
        province=d["province"],
        provinces=provinces,
    )
    if layers.elev.shape != FINE_GRID.shape:
        raise RuntimeError("static_th.npz does not match FINE_GRID – rebuild with scripts/build_static.py")
    return layers
