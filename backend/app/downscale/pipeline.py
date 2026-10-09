"""The downscaling pipeline: coarse driving model → 2 km products.

coarse model (≈22 km)
    │  bilinear interpolation to the 2 km grid
    ▼
temperature  ← lapse rate · valley cold pools · land/sea contrast · urban heat
humidity     ← conserve specific humidity, re-diagnose RH at fine T and p
wind         ← terrain exposure / diversion · surface roughness
rain         ← upslope orographic factor · sea/land-breeze convergence
               · stochastic convective ensemble (K members)
obs          ← station residual correction (optional)
    ▼
heat index, chance of rain, heavy rain, thunderstorms,
province statistics, daily totals, alerts
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np
from scipy import ndimage

from ..core.grid import KM_PER_DEG, Grid
from ..core.static import StaticLayers
from ..core.thermo import heat_index, relative_humidity, wind_speed_dir
from ..products.aggregate import DayAccumulator, ProvinceIndex, step_stats, thai_date
from ..products.alerts import is_partial
from ..sources.base import CoarseForecast
from ..store import RunStore
from . import observations as obsmod
from .physics import (
    TerrainAt,
    coastal_convection_factor,
    downscale_humidity,
    downscale_temperature,
    downscale_wind,
    orographic_factor,
    regime,
    thunder_probability,
)
from .precip import PrecipEnsemble

log = logging.getLogger(__name__)

RAIN_THRESHOLD = 0.5  # mm/h for "rain"
HEAVY_THRESHOLD = 10.0  # mm/h
CONVECTIVE_THRESHOLD = 2.0  # mm/h


class Interpolator:
    """Bilinear interpolation from a coarse grid to fine-grid locations."""

    def __init__(self, coarse: Grid, lats: np.ndarray, lons: np.ndarray) -> None:
        fy = (np.asarray(lats) - coarse.lat0) / coarse.dlat
        fx = (np.asarray(lons) - coarse.lon0) / coarse.dlon
        self.coords = np.array(np.broadcast_arrays(fy, fx))

    def __call__(self, field: np.ndarray) -> np.ndarray:
        return ndimage.map_coordinates(field, self.coords, order=1, mode="nearest").astype(np.float32)

    @classmethod
    def to_grid(cls, coarse: Grid, fine: Grid) -> Interpolator:
        lat2, lon2 = np.meshgrid(fine.lats, fine.lons, indexing="ij")
        return cls(coarse, lat2, lon2)


@dataclass
class TerrainContext:
    """Static fine-grid descriptors relative to one particular driving model."""

    terrain: TerrainAt
    slope_x: np.ndarray
    slope_y: np.ndarray
    curvature: np.ndarray
    coast_km: np.ndarray
    sea_delta: np.ndarray


def terrain_context(static: StaticLayers, coarse: CoarseForecast, interp: Interpolator) -> TerrainContext:
    model_land = static.block_mean(static.land.astype(np.float32), coarse.grid)
    land_delta = static.land_frac - interp(model_land)
    sx, sy = static.slope
    return TerrainContext(
        terrain=TerrainAt(
            dz=static.elev_land - interp(coarse.orography),
            tpi_km=static.tpi_km,
            land_delta=land_delta,
            uhi=static.uhi_kernel,
            land=static.land,
        ),
        slope_x=sx,
        slope_y=sy,
        curvature=static.curvature,
        coast_km=static.coast_km,
        sea_delta=-land_delta,
    )


class Downscaler:
    def __init__(self, static: StaticLayers, members: int = 8) -> None:
        self.static = static
        self.members = members

    # ------------------------------------------------------------------ run
    def run(
        self,
        coarse: CoarseForecast,
        store: RunStore,
        observations: list[obsmod.Observation] | None = None,
    ) -> str:
        t0 = time.perf_counter()
        static = self.static
        fine = static.grid
        interp = Interpolator.to_grid(coarse.grid, fine)
        ctx = terrain_context(static, coarse, interp)
        idx = ProvinceIndex(static.province, static.provinces)

        times = coarse.times
        days = sorted({thai_date(t) for t in times})
        run_id = times[0].strftime("%Y%m%dT%H%MZ") + f"-{coarse.source}"
        writer = store.writer(run_id, fine, coarse, len(days))

        ratio = coarse.grid.dlat / fine.dlat
        seed = int(times[0].timestamp()) // 3600
        ens = PrecipEnsemble(fine.shape, self.members, ratio, seed)
        cell_km = fine.dlat * KM_PER_DEG

        step_stats_all: list[dict] = []
        day_summaries: list[dict] = []
        acc: DayAccumulator | None = None
        correction = None
        obs_used = 0
        obs_stations: list[str] = []

        try:
            for i, t in enumerate(times):
                c = {k: v[i] for k, v in coarse.fields.items()}
                f = {k: interp(v) for k, v in c.items()}
                wind_i = np.hypot(f["u10"], f["v10"])
                rg = regime(f["sw"], f["cloud"], wind_i)

                # -- temperature & humidity
                temp, _ = downscale_temperature(f["t2m"], ctx.terrain, rg)
                if i == 0 and observations:
                    # one report per station (closest to t0) so a station is not over-weighted
                    nearest: dict[str, tuple[float, obsmod.Observation]] = {}
                    for o in observations:
                        dt = abs((o.time - t).total_seconds())
                        if dt <= 5400 and dt < nearest.get(o.station_id, (dt + 1, o))[0]:
                            nearest[o.station_id] = (dt, o)
                    res = obsmod.residuals([o for _, o in nearest.values()], temp, static.elev_land, fine)
                    if res:
                        correction = obsmod.correction_field(res, static.elev_land, fine)
                        obs_used = len(res)
                        obs_stations = sorted(o.station_id for o, _ in res)
                if correction is not None:
                    temp = temp + correction * obsmod.lead_weight((t - times[0]).total_seconds() / 3600)
                _, rh = downscale_humidity(temp, f["td2m"], f["psfc"], ctx.terrain.dz)
                heat = heat_index(temp, rh)

                # -- wind
                u, v = downscale_wind(f["u10"], f["v10"], ctx.slope_x, ctx.slope_y, ctx.curvature, ctx.sea_delta)
                speed, wdir = wind_speed_dir(u, v)

                # -- rain
                oro = orographic_factor(f["u850"], f["v850"], ctx.slope_x, ctx.slope_y, rh)
                steer_u, steer_v = float(c["u850"].mean()), float(c["v850"].mean())
                # rain from forced ascent falls ~15 min downstream
                drift = (steer_v * 900 / 1000 / cell_km, steer_u * 900 / 1000 / cell_km)
                oro = ndimage.shift(ndimage.gaussian_filter(oro, 2.0), drift, order=1, mode="nearest")
                coastf = coastal_convection_factor(ctx.coast_km, rg.day, 1.0 - rg.day)
                factor = oro * coastf
                # half-conserving: redistribute within the model cell, but let
                # strong terrain forcing add rain the coarse model missed
                local = ndimage.gaussian_filter(factor, max(1.0, 0.5 * ratio), mode="nearest")
                target = np.clip(f["precip"], 0, None) * factor / np.sqrt(np.maximum(local, 0.1))
                shift = (steer_v * 3600 / 1000 / cell_km, steer_u * 3600 / 1000 / cell_km)
                members = ens.step(target, f["cape"], shift)
                rain = members.mean(axis=0)
                pop = PrecipEnsemble.exceedance(members, RAIN_THRESHOLD)
                heavy = PrecipEnsemble.exceedance(members, HEAVY_THRESHOLD)
                pconv = PrecipEnsemble.exceedance(members, CONVECTIVE_THRESHOLD, neighbourhood=5.0) / 100.0
                storm = thunder_probability(f["cape"], pconv)
                cloud = np.clip(f["cloud"] + 8.0 * (oro - 1.0), 0, 100)

                for name, arr in (
                    ("temp", temp),
                    ("heat", heat),
                    ("rh", rh),
                    ("rain", rain),
                    ("pop", pop),
                    ("heavy", heavy),
                    ("storm", storm),
                    ("wind", speed),
                    ("wind_dir", wdir),
                    ("cloud", cloud),
                ):
                    writer.write("fine", name, i, arr)
                self._write_coarse(writer, i, c)

                step_stats_all.append(step_stats(idx, temp, heat, pop, rain, storm))

                date = thai_date(t)
                if acc is None or acc.date != date:
                    if acc is not None:
                        day_summaries.append(self._close_day(acc, idx, writer, days, coarse, interp))
                    acc = DayAccumulator(date, fine.shape, self.members)
                acc.add(temp, heat, storm, speed, members, t)
            assert acc is not None
            day_summaries.append(self._close_day(acc, idx, writer, days, coarse, interp))
        except BaseException:
            writer.abort()
            raise

        provinces = {
            "steps": {key: [s[key] for s in step_stats_all] for key in step_stats_all[0]},
            "days": [
                {k: d[k] for k in ("date", "hours", "partial", "since", "until", "provinces")} for d in day_summaries
            ],
        }
        meta = {
            "run_id": run_id,
            "source": coarse.source,
            "model": coarse.model,
            "demo": coarse.demo,
            "issued": coarse.issued.isoformat(),
            "created": datetime.now(UTC).isoformat(),
            "times": [t.isoformat() for t in times],
            "days": [{k: d[k] for k in ("date", "hours", "partial", "since", "until")} for d in day_summaries],
            "fine_grid": fine.describe(),
            "coarse_grid": coarse.grid.describe(),
            "ensemble_members": self.members,
            "observations_used": obs_used,
            "observation_stations": obs_stations,
            "notes": coarse.notes,
            "compute_seconds": round(time.perf_counter() - t0, 1),
        }
        writer.finish(meta, provinces)
        log.info("run %s finished in %.1fs", run_id, meta["compute_seconds"])
        return run_id

    # ------------------------------------------------------------- helpers
    def _close_day(self, acc, idx, writer, days, coarse, interp) -> dict:
        d = days.index(acc.date)
        writer.write("fine", "rain24", d, acc.rain_mean)
        # model-native daily total for the comparison view
        day_mask = [thai_date(t) == acc.date for t in coarse.times]
        writer.write("coarse", "rain24", d, coarse.fields["precip"][day_mask].sum(axis=0))
        return {
            "date": acc.date,
            "hours": acc.hours,
            "partial": is_partial(acc.hours),
            "since": acc.since or None,
            "until": acc.until or None,
            "provinces": acc.summarise(idx),
        }

    @staticmethod
    def _write_coarse(writer, i: int, c: dict) -> None:
        """Model-native fields for the side-by-side '22 km vs 2 km' view."""
        rh = relative_humidity(c["t2m"], c["td2m"])
        speed, wdir = wind_speed_dir(c["u10"], c["v10"])
        precip = np.clip(c["precip"], 0, None)
        writer.write("coarse", "temp", i, c["t2m"])
        writer.write("coarse", "heat", i, heat_index(c["t2m"], rh))
        writer.write("coarse", "rh", i, rh)
        writer.write("coarse", "rain", i, precip)
        writer.write("coarse", "pop", i, np.where(precip >= RAIN_THRESHOLD, 100.0, 0.0))
        writer.write("coarse", "heavy", i, np.where(precip >= HEAVY_THRESHOLD, 100.0, 0.0))
        writer.write(
            "coarse", "storm", i, thunder_probability(c["cape"], (precip >= CONVECTIVE_THRESHOLD).astype(np.float32))
        )
        writer.write("coarse", "wind", i, speed)
        writer.write("coarse", "wind_dir", i, wdir)
        writer.write("coarse", "cloud", i, c["cloud"])


# ---------------------------------------------------------------- explain
def explain_point(run_raw: dict, coarse_grid: Grid, static: StaticLayers, lat: float, lon: float) -> dict:
    """Per-process temperature corrections at one location for every step.

    Uses the stored raw model fields so it reproduces the pipeline exactly
    (before any observation correction)."""
    fine = static.grid
    iy, ix = fine.index(lat, lon)
    pt = Interpolator(coarse_grid, np.array([fine.lats[iy]]), np.array([fine.lons[ix]]))
    model_land = static.block_mean(static.land.astype(np.float32), coarse_grid)
    sl = (slice(iy, iy + 1), slice(ix, ix + 1))
    ter = TerrainAt(
        dz=static.elev_land[sl].ravel() - pt(run_raw["orography"]),
        tpi_km=static.tpi_km[sl].ravel(),
        land_delta=static.land_frac[sl].ravel() - pt(model_land),
        uhi=static.uhi_kernel[sl].ravel(),
        land=static.land[sl].ravel(),
    )
    nt = run_raw["t2m"].shape[0]
    comps: dict[str, list[float]] = {"model": [], "lapse": [], "valley": [], "coast": [], "urban": []}
    for i in range(nt):
        t_i = pt(run_raw["t2m"][i])
        wind = np.hypot(pt(run_raw["u10"][i]), pt(run_raw["v10"][i]))
        rg = regime(pt(run_raw["sw"][i]), pt(run_raw["cloud"][i]), wind)
        _, parts = downscale_temperature(t_i, ter, rg)
        comps["model"].append(round(float(t_i[0]), 2))
        for k, v in parts.items():
            comps[k].append(round(float(np.asarray(v).ravel()[0]), 2))
    return {
        "elevation_fine": round(float(static.elev_land[iy, ix])),
        "elevation_model": round(float(pt(run_raw["orography"])[0])),
        "temperature_components": comps,
    }
