"""Moist thermodynamics and human-comfort indices (vectorised, SI / °C)."""

from __future__ import annotations

import numpy as np

SCALE_HEIGHT_M = 8400.0  # tropical near-surface scale height


def sat_vapour_pressure(t_c: np.ndarray) -> np.ndarray:
    """Saturation vapour pressure over water in hPa (Bolton 1980)."""
    return 6.112 * np.exp(17.67 * t_c / (t_c + 243.5))


def dewpoint_from_vapour_pressure(e_hpa: np.ndarray) -> np.ndarray:
    ln = np.log(np.maximum(e_hpa, 1e-3) / 6.112)
    return 243.5 * ln / (17.67 - ln)


def relative_humidity(t_c: np.ndarray, td_c: np.ndarray) -> np.ndarray:
    return np.clip(100.0 * sat_vapour_pressure(td_c) / sat_vapour_pressure(t_c), 1.0, 100.0)


def pressure_at_height(p_ref_hpa: np.ndarray, dz_m: np.ndarray) -> np.ndarray:
    """Hypsometric pressure adjustment for a height difference ``dz_m``."""
    return p_ref_hpa * np.exp(-dz_m / SCALE_HEIGHT_M)


def heat_index(t_c: np.ndarray, rh: np.ndarray) -> np.ndarray:
    """Apparent temperature (°C) using the NWS Rothfusz regression.

    This is the same index the Thai Department of Health and TMD use for
    their heat-index warnings (thresholds 27 / 32 / 41 / 54 °C).
    """
    t_f = np.asarray(t_c, dtype=np.float64) * 9.0 / 5.0 + 32.0
    rh = np.asarray(rh, dtype=np.float64)
    simple = 0.5 * (t_f + 61.0 + (t_f - 68.0) * 1.2 + rh * 0.094)
    full = (
        -42.379
        + 2.04901523 * t_f
        + 10.14333127 * rh
        - 0.22475541 * t_f * rh
        - 6.83783e-3 * t_f**2
        - 5.481717e-2 * rh**2
        + 1.22874e-3 * t_f**2 * rh
        + 8.5282e-4 * t_f * rh**2
        - 1.99e-6 * t_f**2 * rh**2
    )
    dry = (rh < 13) & (t_f >= 80) & (t_f <= 112)
    full = np.where(dry, full - ((13 - rh) / 4) * np.sqrt(np.clip((17 - np.abs(t_f - 95.0)) / 17, 0, None)), full)
    humid = (rh > 85) & (t_f >= 80) & (t_f <= 87)
    full = np.where(humid, full + ((rh - 85) / 10) * ((87 - t_f) / 5), full)
    hi_f = np.where((simple + t_f) / 2 >= 80.0, full, simple)
    return ((hi_f - 32.0) * 5.0 / 9.0).astype(np.float32)


def wind_speed_dir(u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Speed (m/s) and meteorological direction (degrees the wind blows *from*)."""
    speed = np.hypot(u, v)
    direction = (np.degrees(np.arctan2(-u, -v)) + 360.0) % 360.0
    return speed, direction


def wind_components(speed: np.ndarray, direction_deg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rad = np.radians(direction_deg)
    return -speed * np.sin(rad), -speed * np.cos(rad)
