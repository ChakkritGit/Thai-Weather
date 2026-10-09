# Downscaling method / วิธีการลดย่อส่วน

This document describes exactly what the code in `backend/app/downscale/` does,
with the constants it uses, so results can be reviewed, verified and improved.

## 0. Grids

| | Spacing | Size | Notes |
|---|---|---|---|
| Driving model | 0.25° (Open-Meteo) / 0.2° (demo) | 61×35 / 76×43 | raw grid-cell values (`elevation=nan`, `cell_selection=nearest`) |
| Analysis grid | 0.02° ≈ 2.2 km | 751×421 | 5.5–20.5°N, 97.3–105.7°E |

Static layers (`scripts/build_static.py`): AWS Terrain Tiles at zoom 8 (~600 m),
4×4 sub-sampled per cell → mean elevation and sub-grid standard deviation;
Natural Earth land / Thailand / province masks. Derived in `core/static.py`:
2 km-smoothed slopes, topographic position index (elevation minus 8 km Gaussian
mean), curvature, 1.5 km land fraction, signed coastal distance and an urban
heat-island kernel (`core/cities.py`).

## 1. Interpolation

Every model field is bilinearly interpolated to the analysis grid. Model
orography and model-cell land fraction are interpolated the same way so each
fine cell knows how it differs from "what the model thinks is here":
`dz = z_fine − z_model`, `Δland = landfrac_fine − landfrac_model`.

## 2. Temperature (`physics.temperature_components`)

Regime from the interpolated model state: `day = clip(SW/800)`,
`clear = 1 − cloud`, `calm = clip(1 − wind/6 m s⁻¹)`.

| Term | Formula | Rationale |
|---|---|---|
| Lapse rate | `Γ·dz`, Γ = −6.5 K/km by day, −5.0 K/km at night (blended by `day`) | tropical boundary layers between dry and moist adiabatic |
| Valley cold pool | `6 K/km · min(TPI,0) · night · clear · calm`, capped at −4 K, land only | radiative pooling in the Chiang Mai / Lampang / Nan basins |
| Land–sea contrast | `Δland · (3.5·day·clear + 1.0·day − 1.2·night·clear)` | a coastal 22 km cell blends sea and land |
| Urban heat island | `UHI · (0.3+0.7·night)(0.4+0.6·calm)(0.5+0.5·clear)` | Bangkok max 3 K, radius 22 km; regional cities 1–1.8 K |

Each term is returned separately – the point API exposes them so users can see
*why* the 2 km value differs.

## 3. Humidity

Specific humidity is conserved: the model vapour pressure is scaled by the
hypsometric pressure ratio to the fine elevation, capped at saturation at the
fine temperature, then dew point and RH are re-diagnosed. Heat index uses the
NWS Rothfusz regression with its low-RH / high-RH adjustments (the index used
by the Thai Department of Health).

## 4. Wind (`physics.downscale_wind`)

MicroMet (Liston & Elder 2006): slope along the wind `ω_s ∈ [−0.5, 0.5]` and
curvature `ω_c ∈ [−0.5, 0.5]`; speed weight `1 + 0.5·ω_s + 0.5·ω_c` (clipped
0.3–1.8), direction diversion `−0.5·ω_s·sin(2(aspect − dir))`. A roughness
factor `1 + 0.3·Δsea` strengthens wind offshore and weakens it on the coast.

## 5. Rainfall

### 5.1 Expected rate (deterministic)

1. **Orographic factor** – simplified linear upslope model:
   `w = V₈₅₀ · ∇h`; `F = (1 + 1.5·max(w,0)·m) / (1 + 0.8·max(−w,0))`,
   `m = clip((RH−60)/30)`, clipped to 0.25–4, smoothed (σ = 2 cells) and shifted
   15 minutes downstream along the domain-mean 850 hPa wind.
2. **Coastal convection** – `1 + 0.6·day·G(d−25 km, 15 km) + 0.5·night·G(d+30 km, 20 km)`
   (afternoon sea-breeze storms inland, nocturnal storms offshore).
3. **Half-conservation** – `target = P_model · F / √(local mean F)`: the factor
   mostly redistributes rain inside the model cell but strong forcing may add
   rain the coarse model under-represents.

### 5.2 Convective ensemble (`precip.py`)

For each of K members (default 8) an AR(1) Gaussian random field (σ = 4 cells ≈
9 km, ρ = 0.8 per hour, advected by the steering wind) is thresholded and
exponentiated:

```
wet fraction f = clip((1 − e^(−target/1.2)) · (1 − 0.45·c), 0.02, 0.98),  c = clip(CAPE/2500)
z = Φ⁻¹(1 − f),  s = 0.5 + 0.55·c
texture = exp(s(n − z)) · 1[n > z]
member  = target · texture / E[texture],  E[texture] = exp(s²/2 − s·z) · Φ(s − z)
```

Dividing by the analytic expectation makes every member an **unbiased**
estimate of the target at every cell (verified in `tests/test_precip.py`), so
the ensemble mean converges to the model's rain while members carry realistic
5–20 km cells and peaks.

### 5.3 Probabilities

Neighbourhood probabilities (Gaussian σ = 3 cells) of ≥ 0.5 mm/h ("rain") and
≥ 10 mm/h ("heavy"). Thunderstorm probability =
`logistic((CAPE − 1000)/350) · P(≥ 2 mm/h, σ = 5 cells)`.

## 6. Station correction (`observations.py`)

Residual = observation − 2 km first guess (moved to station height with
−6.5 K/km). Correction field `Σwᵢrᵢ / (0.3 + Σwᵢ)` with
`wᵢ = exp(−d²/40 km²) · exp(−Δz²/300 m²)`; applied with weight `exp(−lead/12 h)`.

## 7. Province products (`products/aggregate.py`)

Per Thai calendar day: typical max/min = median over the province of each
cell's daily max/min (extremes reported separately as `tmax_high`, `tmin_low`);
heat index = 95th percentile; rainfall = 95th percentile of the ensemble-mean
daily total; **rain coverage = mean over members of the share of cells with
≥ 1 mm/day** – mapped to TMD distribution terms (บางแห่ง / เป็นแห่งๆ /
ค่อนข้างกระจาย / กระจาย / เกือบทั่วไป). Alerts compare these against the
thresholds in `design-system/tokens/weather.json`.

## 8. Limitations and validation plan

- Statistical–dynamical downscaling cannot create convection the driving model
  lacks, nor fix its timing/position errors at synoptic scale.
- Constants above are physically motivated first guesses. **They must be
  calibrated against observations** (TMD synoptic & AWS stations, HII network,
  GPM IMERG for rain) before operational use. Suggested metrics: temperature
  MAE/bias by elevation band and hour; rain FSS at 10–50 km neighbourhoods;
  reliability diagrams for probability products; heat-index category hit rates.
- The rain-coverage term thresholds follow TMD vocabulary as understood by the
  authors; confirm against the current TMD glossary.
- For storms, run the WRF 3 km configuration in `infra/wrf` and feed it
  through the same pipeline.

## References

- Liston, G. E. & Elder, K. (2006). A meteorological distribution system for high-resolution terrestrial modeling (MicroMet). *J. Hydrometeorology*, 7, 217–234.
- Smith, R. B. & Barstad, I. (2004). A linear theory of orographic precipitation. *J. Atmos. Sci.*, 61, 1377–1391.
- Rothfusz, L. P. (1990). The heat index equation. NWS Technical Attachment SR 90-23.
- Roberts, N. M. & Lean, H. W. (2008). Scale-selective verification of rainfall accumulations (FSS). *Mon. Wea. Rev.*, 136, 78–97.
- Schwartz, C. S. & Sobash, R. A. (2017). Generating probabilistic forecasts from convection-allowing ensembles using neighborhood approaches. *Mon. Wea. Rev.*, 145, 3397–3418.
