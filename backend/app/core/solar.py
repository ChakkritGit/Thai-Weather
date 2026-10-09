"""Solar geometry (NOAA low-accuracy formulae, good to ~0.5°)."""

from __future__ import annotations

from datetime import datetime

import numpy as np


def solar_position(when: datetime, lats: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (cos_zenith, azimuth_deg) on the lat × lon mesh for a UTC time."""
    doy = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60.0
    g = 2.0 * np.pi / 365.0 * (doy - 1 + (hour - 12) / 24.0)
    eqtime = 229.18 * (
        0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g) - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g)
    )
    decl = (
        0.006918
        - 0.399912 * np.cos(g)
        + 0.070257 * np.sin(g)
        - 0.006758 * np.cos(2 * g)
        + 0.000907 * np.sin(2 * g)
        - 0.002697 * np.cos(3 * g)
        + 0.00148 * np.sin(3 * g)
    )
    lat_r = np.radians(np.asarray(lats))[:, None]
    tst = hour * 60.0 + eqtime + 4.0 * np.asarray(lons)[None, :]
    ha = np.radians(tst / 4.0 - 180.0)
    cosz = np.sin(lat_r) * np.sin(decl) + np.cos(lat_r) * np.cos(decl) * np.cos(ha)
    cosz = np.clip(cosz, -1.0, 1.0)
    sinz = np.sqrt(1.0 - cosz**2) + 1e-9
    cos_az = (np.sin(decl) - np.sin(lat_r) * cosz) / (np.cos(lat_r) * sinz)
    az = np.degrees(np.arccos(np.clip(cos_az, -1.0, 1.0)))
    az = np.where(ha > 0, 360.0 - az, az)
    return cosz.astype(np.float32), az.astype(np.float32)


def clear_sky_ghi(cosz: np.ndarray) -> np.ndarray:
    """Clear-sky global horizontal irradiance (W/m², Haurwitz model)."""
    c = np.clip(cosz, 0.0, None)
    return np.where(c > 0.01, 1098.0 * c * np.exp(-0.057 / np.maximum(c, 0.01)), 0.0).astype(np.float32)
