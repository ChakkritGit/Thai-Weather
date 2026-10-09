# WRF 3 km configuration (optional full-physics path)

The default system downscales global-model output statistically–dynamically
in seconds. When compute is available, a convection-permitting regional
model gives better storms. These namelists set up **WRF-ARW** with

| Domain | Grid | Coverage | Convection |
|---|---|---|---|
| d01 | 9 km, 280 × 310 | mainland SE Asia, ~89–115°E, 0–25°N | New Tiedtke (parameterised) |
| d02 | 3 km, 340 × 601 | Thailand, 96.8–106°E, 4.8–21°N | explicit (no cumulus scheme) |

Physics chosen for the tropics: Thompson microphysics, YSU PBL, Noah-MP land
surface (rice paddies), single-layer urban canopy (Bangkok), RRTMG radiation
and SST updates for the Gulf of Thailand / Andaman Sea.

Rough cost: a 48 h run of both domains needs ~1–2 h on 128 cores.

## Integrating with the API

WRF output (`wrfout_d02_*`) can be fed through the same pipeline: write a
`Source` (see `backend/app/sources/base.py`) that interpolates `T2`, `Q2`,
`RAINNC+RAINC` (de-accumulated), `U10/V10`, 850 hPa winds, CAPE, cloud and
`SWDOWN` onto a regular 0.03° grid and returns a `CoarseForecast`. The
downscaler then adds 2 km terrain detail, the convective rain ensemble,
province statistics and alerts unchanged.
