"""Physically based corrections from coarse model cells to the fine grid.

Every function is element-wise in its dynamic inputs so the same code is used
for the whole grid (pipeline) and for a single point (explanations in the
point API).  Static terrain descriptors come from :class:`StaticLayers`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..core.thermo import (
    dewpoint_from_vapour_pressure,
    pressure_at_height,
    relative_humidity,
    sat_vapour_pressure,
)

# Lapse rates (K/km).  Tropical boundary layers sit between dry (-9.8) and
# moist adiabatic (~-4.5); observations in northern Thailand give ≈ -6.
LAPSE_DAY = -6.5
LAPSE_NIGHT = -5.0


@dataclass
class TerrainAt:
    """Static fine-grid descriptors, either full arrays or values at a point."""

    dz: np.ndarray  # fine elevation − model elevation (m)
    tpi_km: np.ndarray
    land_delta: np.ndarray  # fine land fraction − model-cell land fraction
    uhi: np.ndarray  # night-time UHI potential (°C)
    land: np.ndarray  # bool


@dataclass
class Regime:
    """Dynamic boundary-layer regime derived from the interpolated model state."""

    day: np.ndarray  # 0..1  (normalised incoming shortwave)
    clear: np.ndarray  # 0..1  (1 − cloud fraction)
    calm: np.ndarray  # 0..1  (1 at 0 m/s → 0 at ≥ 6 m/s)


def regime(sw: np.ndarray, cloud: np.ndarray, wind: np.ndarray) -> Regime:
    return Regime(
        day=np.clip(sw / 800.0, 0.0, 1.0),
        clear=np.clip(1.0 - cloud / 100.0, 0.0, 1.0),
        calm=np.clip(1.0 - wind / 6.0, 0.0, 1.0),
    )


def temperature_components(t_interp: np.ndarray, ter: TerrainAt, rg: Regime) -> dict[str, np.ndarray]:
    """Additive temperature corrections (°C), returned per physical process."""
    night = 1.0 - rg.day
    lapse = (LAPSE_DAY * rg.day + LAPSE_NIGHT * night) * ter.dz / 1000.0
    # Cold-air pooling in basins and valleys on calm, clear nights (e.g. the
    # Chiang Mai / Lampang basins in the cool season).
    valley = 6.0 * np.minimum(ter.tpi_km, 0.0) * night * rg.clear * rg.calm
    valley = np.where(ter.land, np.maximum(valley, -4.0), 0.0)
    # Land–sea contrast: a 22 km cell blends sea and land; restore the
    # warmer-by-day / cooler-by-night land signal at the coast.
    contrast = 3.5 * rg.day * rg.clear + 1.0 * rg.day - 1.2 * night * rg.clear
    coast = ter.land_delta * contrast
    # Urban heat island: strongest on calm, clear nights.
    uhi = ter.uhi * (0.3 + 0.7 * night) * (0.4 + 0.6 * rg.calm) * (0.5 + 0.5 * rg.clear)
    return {"lapse": lapse, "valley": valley, "coast": coast, "urban": uhi}


def downscale_temperature(t_interp: np.ndarray, ter: TerrainAt, rg: Regime) -> tuple[np.ndarray, dict]:
    comps = temperature_components(t_interp, ter, rg)
    total = t_interp + sum(comps.values())
    return total.astype(np.float32), comps


def downscale_humidity(
    t_fine: np.ndarray, td_interp: np.ndarray, p_interp: np.ndarray, dz: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Conserve the model's specific humidity while moving to the fine
    elevation, then diagnose dew point and RH at the fine temperature."""
    e_model = sat_vapour_pressure(td_interp)
    p_fine = pressure_at_height(p_interp, dz)
    e_fine = np.minimum(e_model * p_fine / p_interp, sat_vapour_pressure(t_fine))
    td_fine = dewpoint_from_vapour_pressure(e_fine)
    return td_fine.astype(np.float32), relative_humidity(t_fine, td_fine).astype(np.float32)


def downscale_wind(
    u: np.ndarray,
    v: np.ndarray,
    slope_x: np.ndarray,
    slope_y: np.ndarray,
    curvature: np.ndarray,
    sea_delta: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Terrain-modified wind after Liston & Elder (2006, MicroMet) with an
    added surface-roughness term for land/sea transitions."""
    speed = np.hypot(u, v) + 1e-6
    # slope in the direction of the wind, scaled to [-0.5, 0.5]
    omega_s = np.clip((slope_x * u + slope_y * v) / speed * 2.5, -0.5, 0.5)
    weight = 1.0 + 0.5 * omega_s + 0.5 * curvature
    rough = 1.0 + 0.3 * sea_delta  # sea is smoother → stronger winds
    new_speed = speed * np.clip(weight, 0.3, 1.8) * rough
    # flow diversion around terrain
    aspect = np.arctan2(-slope_x, -slope_y)
    wdir = np.arctan2(-u, -v)
    diversion = -0.5 * omega_s * np.sin(2.0 * (aspect - wdir))
    nd = wdir + diversion
    return (-new_speed * np.sin(nd)).astype(np.float32), (-new_speed * np.cos(nd)).astype(np.float32)


def orographic_factor(
    u850: np.ndarray, v850: np.ndarray, slope_x: np.ndarray, slope_y: np.ndarray, rh: np.ndarray
) -> np.ndarray:
    """Multiplicative rain factor from forced ascent (simplified linear
    upslope model, Smith 1979 / Smith & Barstad 2004 without the Fourier
    advection terms).  Windward slopes are enhanced, lee sides drier."""
    w = u850 * slope_x + v850 * slope_y  # terrain-forced vertical motion (m/s)
    moist = np.clip((rh - 60.0) / 30.0, 0.0, 1.0)
    up = 1.0 + 1.5 * np.maximum(w, 0.0) * moist
    down = 1.0 / (1.0 + 0.8 * np.maximum(-w, 0.0))
    return np.clip(up * down, 0.25, 4.0).astype(np.float32)


def coastal_convection_factor(coast_km: np.ndarray, day: np.ndarray, night: np.ndarray) -> np.ndarray:
    """Sea-breeze convergence inland by day and land-breeze convergence
    offshore by night – the classic tropical coastal rain diurnal cycle."""
    inland = np.exp(-((coast_km - 25.0) ** 2) / (2 * 15.0**2))
    offshore = np.exp(-((coast_km + 30.0) ** 2) / (2 * 20.0**2))
    return (1.0 + 0.6 * day * inland + 0.5 * night * offshore).astype(np.float32)


def thunder_probability(cape: np.ndarray, p_conv: np.ndarray) -> np.ndarray:
    """Thunderstorm probability (%) from instability and the chance of
    convective-intensity rain (≥ 2 mm/h) in the neighbourhood."""
    instab = 1.0 / (1.0 + np.exp(-(cape - 1000.0) / 350.0))
    return np.clip(100.0 * instab * p_conv, 0.0, 100.0).astype(np.float32)
