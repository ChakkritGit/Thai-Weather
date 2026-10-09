"""Deterministic *demo* driving model.

Produces a physically plausible coarse (≈22 km) forecast for Thailand so the
whole system can run offline, in CI and in demos.  It is driven by monthly
climatology (temperature, humidity, monsoon flow) plus seeded stochastic
weather (moving disturbances, afternoon land convection).  It is **not** a
forecast – every response produced from it is flagged ``demo: true``.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np
from scipy import ndimage

from ..core.grid import COARSE_GRID, Grid
from ..core.solar import clear_sky_ghi, solar_position
from ..core.static import load_static
from ..core.thermo import SCALE_HEIGHT_M
from .base import CoarseForecast

MONTHS = np.arange(12)
# Monthly mean temperature (°C) near sea level for the south (7°N), centre (13.7°N), north (18.8°N)
T_SOUTH = np.array([26.8, 27.3, 27.9, 28.5, 28.4, 28.2, 27.9, 27.9, 27.6, 27.2, 26.9, 26.6])
T_CENTRE = np.array([27.0, 28.3, 29.5, 30.5, 30.0, 29.5, 29.0, 28.8, 28.4, 28.2, 27.8, 26.5])
T_NORTH = np.array([22.5, 24.5, 27.5, 29.8, 29.2, 28.4, 27.9, 27.6, 27.6, 26.8, 24.8, 22.6])
# Diurnal temperature range over land (K)
DTR = np.array([13.0, 13.0, 12.0, 10.5, 9.0, 7.5, 7.0, 7.0, 7.0, 8.0, 10.0, 12.5])
# Mean dew-point depression (K)
DPD = np.array([7.5, 7.0, 6.0, 5.0, 3.5, 2.8, 2.5, 2.5, 2.5, 3.0, 5.0, 7.0])
# Monsoon rain-season weight (0 dry … 1 peak)
RAIN = np.array([0.08, 0.1, 0.22, 0.4, 0.75, 0.8, 0.85, 0.95, 1.0, 0.8, 0.35, 0.12])
# Gulf-coast (NE monsoon) rain weight for the southern east coast
RAIN_GULF = np.array([0.45, 0.2, 0.15, 0.2, 0.4, 0.4, 0.4, 0.45, 0.5, 0.7, 1.0, 0.9])
# 10 m and 850 hPa prevailing flow (u, v) m/s
U10 = np.array([-3.0, -2.5, 0.0, 0.5, 3.0, 4.0, 4.5, 4.5, 3.0, -1.0, -3.0, -3.5])
V10 = np.array([-2.0, -1.0, 2.0, 2.5, 2.0, 2.0, 1.5, 1.5, 1.0, -1.0, -2.0, -2.0])
U850 = np.array([-5.0, -3.0, 1.0, 2.0, 6.0, 9.0, 10.0, 9.5, 6.0, -1.0, -5.0, -6.0])
V850 = np.array([-2.0, -1.0, 1.0, 1.0, 1.5, 1.5, 1.0, 1.0, 0.5, -1.0, -2.0, -2.0])


def _monthly(table: np.ndarray, when: datetime) -> float:
    """Linearly interpolate a monthly table to a date (mid-month anchored)."""
    pos = (when.timetuple().tm_yday - 15.0) / 30.44
    return float(np.interp(pos, MONTHS, table, period=12))


def _hour_diff(h: np.ndarray, centre: float) -> np.ndarray:
    """Signed difference in hours on the 24 h clock, in [-12, 12)."""
    return (h - centre + 12.0) % 24.0 - 12.0


class SyntheticSource:
    name = "demo"

    def __init__(self, grid: Grid = COARSE_GRID) -> None:
        self.grid = grid

    def fetch(self, start: datetime, hours: int) -> CoarseForecast:
        g = self.grid
        static = load_static()
        orog = np.maximum(static.block_mean(static.elev_land, g), 0.0)
        landf = np.clip(static.block_mean(static.land.astype(np.float32), g), 0.0, 1.0)

        seed = int(start.strftime("%Y%m%d")) * 10 + start.hour // 6
        rng = np.random.default_rng(seed)
        lat2 = np.repeat(g.lats[:, None], g.nx, axis=1)
        lon2 = np.repeat(g.lons[None, :], g.ny, axis=0)

        times = [start + timedelta(hours=h) for h in range(hours)]
        nt = len(times)
        shape = (nt, *g.shape)
        f = {
            k: np.zeros(shape, dtype=np.float32)
            for k in ("t2m", "td2m", "precip", "cape", "u10", "v10", "u850", "v850", "cloud", "sw", "psfc")
        }

        def smooth_noise(sigma: float) -> np.ndarray:
            n = ndimage.gaussian_filter(rng.standard_normal(g.shape), sigma, mode="wrap")
            return (n / (n.std() + 1e-9)).astype(np.float32)

        # Moving rain-bearing disturbances (monsoon trough / tropical waves)
        n_dist = int(rng.integers(1, 4))
        disturbances = []
        for _ in range(n_dist):
            disturbances.append(
                {
                    "lat": rng.uniform(8.0, 18.0),
                    "lon": rng.uniform(98.5, 105.0),
                    "u": rng.uniform(-6.0, 2.0),  # m/s (mostly westward drift)
                    "v": rng.uniform(-1.5, 2.5),
                    "radius": rng.uniform(1.0, 2.2),  # degrees
                    "peak": rng.uniform(2.0, 6.0),  # mm/h
                }
            )
        day_noise = [smooth_noise(3.0) for _ in range(hours // 24 + 2)]

        for i, t in enumerate(times):
            mid = t + timedelta(hours=7)  # Thai local date for climatology
            tc = np.interp(
                lat2, [7.0, 13.7, 18.8], [_monthly(T_SOUTH, mid), _monthly(T_CENTRE, mid), _monthly(T_NORTH, mid)]
            )
            dtr = _monthly(DTR, mid)
            rain_w = _monthly(RAIN, mid)
            gulf_w = _monthly(RAIN_GULF, mid)

            local_h = (t.hour + t.minute / 60.0 + lon2 / 15.0) % 24.0
            diurnal = np.cos(2 * np.pi * (local_h - 14.5) / 24.0)
            amp = dtr / 2.0 * (0.12 + 0.88 * landf)
            t2m = tc + amp * diurnal - 6.0 * orog / 1000.0

            noise = day_noise[i // 24] * (1 - (i % 24) / 24) + day_noise[i // 24 + 1] * ((i % 24) / 24)
            dpd = _monthly(DPD, mid) * (0.4 + 0.6 * landf) * (1 + 0.15 * noise)
            td_mean = tc - 6.0 * orog / 1000.0 - dpd + 0.6 * diurnal
            td2m = np.minimum(td_mean, t2m - 0.3)

            # --- precipitation (coarse, smooth: this is what a 22 km model resolves)
            afternoon = np.exp(-(_hour_diff(local_h, 16.5) ** 2) / (2 * 2.5**2))
            night_sea = np.exp(-(_hour_diff(local_h, 4.0) ** 2) / (2 * 3.0**2))
            conv = (
                rain_w * (1.6 * afternoon * landf + 0.5 * night_sea * (1 - landf)) * np.clip(0.8 + 0.7 * noise, 0, None)
            )
            gulf = gulf_w * 0.5 * np.exp(-((lat2 - 8.0) ** 2) / 4.0) * np.exp(-((lon2 - 100.4) ** 2) / 1.0)
            andaman = rain_w * 0.6 * np.exp(-((lon2 - 97.9) ** 2) / 0.8) * (lat2 > 8.0)
            synoptic = np.zeros(g.shape)
            for d in disturbances:
                hrs = (t - start).total_seconds() / 3600.0
                clat = d["lat"] + d["v"] * 3.6 * hrs / 111.0
                clon = d["lon"] + d["u"] * 3.6 * hrs / 111.0
                r2 = ((lat2 - clat) ** 2 + (lon2 - clon) ** 2) / d["radius"] ** 2
                synoptic += d["peak"] * rain_w * np.exp(-r2) * (0.7 + 0.3 * diurnal)
            precip = np.clip(conv + gulf + andaman + synoptic - 0.15, 0.0, None)

            cape = (300 + 2200 * rain_w * np.clip(0.4 + diurnal, 0, 1.4) * landf + 900 * (1 - landf)) * (
                1 + 0.25 * noise
            )
            cape = np.clip(cape - 300 * precip, 50, None)

            cosz, _ = solar_position(t, g.lats, g.lons)
            cloud = np.clip(25 + 35 * rain_w + 40 * np.tanh(precip / 1.5) + 10 * noise, 5, 100)
            sw = clear_sky_ghi(cosz) * (1 - 0.7 * cloud / 100.0)

            # Prevailing monsoon flow plus cyclonic circulation around disturbances
            u10 = _monthly(U10, mid) * (0.7 + 0.6 * (1 - landf)) + 0.8 * noise
            v10 = _monthly(V10, mid) * (0.7 + 0.6 * (1 - landf)) - 0.6 * noise
            for d in disturbances:
                hrs = (t - start).total_seconds() / 3600.0
                clat = d["lat"] + d["v"] * 3.6 * hrs / 111.0
                clon = d["lon"] + d["u"] * 3.6 * hrs / 111.0
                dy, dx = lat2 - clat, lon2 - clon
                w = d["peak"] / 3.0 * np.exp(-(dx**2 + dy**2) / (2 * d["radius"] ** 2))
                u10 += -dy * w * 2.0
                v10 += dx * w * 2.0
            u850 = _monthly(U850, mid) + 0.5 * (u10 - _monthly(U10, mid))
            v850 = _monthly(V850, mid) + 0.5 * (v10 - _monthly(V10, mid))

            f["t2m"][i] = t2m
            f["td2m"][i] = td2m
            f["precip"][i] = precip
            f["cape"][i] = cape
            f["cloud"][i] = cloud
            f["sw"][i] = sw
            f["u10"][i] = u10
            f["v10"][i] = v10
            f["u850"][i] = u850
            f["v850"][i] = v850
            f["psfc"][i] = 1009.0 * np.exp(-orog / SCALE_HEIGHT_M) + 1.2 * np.cos(4 * np.pi * (local_h - 10) / 24)

        fc = CoarseForecast(
            source=self.name,
            model="TH-DEMO climatology + stochastic weather",
            grid=g,
            times=times,
            orography=orog.astype(np.float32),
            fields=f,
            issued=start,
            demo=True,
            notes=["Synthetic demo data – not a real forecast."],
        )
        fc.validate()
        return fc
