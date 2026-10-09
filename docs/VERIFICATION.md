# Forecast verification / การตรวจสอบความแม่นยำ

Measures whether the 2.2 km downscaled forecast beats (a) the raw GFS grid cell
it was built from and (b) Open-Meteo's own point forecast of the same model,
using real station observations. Code: `backend/verify/`.

ระบบนี้วัดว่าพยากรณ์ 2.2 กม. (`fine`) แม่นกว่า GFS ดิบ (`gfs_raw`) และกว่าพยากรณ์จุดของ
Open-Meteo (`openmeteo`, โมเดลเดียวกัน ปรับตามความสูงสถานี) หรือไม่ เมื่อเทียบกับข้อมูลสถานีจริง

## What is measured / วัดอะไร

| Source | What it is |
|---|---|
| `fine` | `/api/v1/point` → `fine` series at the station coordinates |
| `gfs_raw` | `/api/v1/point` → `coarse` series (the driving-model grid cell) |
| `openmeteo` | Open-Meteo `forecast` API, same model (`THWX_OPENMETEO_MODEL`), default cell selection and station elevation |

- **Temperature 2 m** (°C): bias, MAE, RMSE of forecast − observed, plus skill
  `1 − MAE(source) / MAE(gfs_raw)` (positive = better than raw GFS). Stratified by lead
  time (0–11, 12–23, 24–35, 36–47 h), local hour (ICT, 3-h bins), station elevation band
  (< 100, 100–400, > 400 m) and per station.
- **Rain occurrence** in 3-hour ICT-aligned windows: hits, misses, false alarms,
  correct negatives, POD, FAR, CSI, frequency bias and Brier score
  (`fine` uses `pop`/100; the others 0/1). A forecast "yes" means hourly rain ≥ 0.2 mm/h
  anywhere in the window.
- Only **matched samples** feed the headline numbers: a (run, station, time) is used
  only when every available source has a value, so no source is scored on easier cases.
  The number of excluded samples per source is printed too.

## Data sources / แหล่งข้อมูล

- **Observations:** Iowa Environmental Mesonet (IEM) METAR archive, network `TH__ASOS`
  (about 35 reporting Thai airports, free, no key). NOAA ISD stopped updating Thai
  stations in 2025-08, so it is not used.
- **CSV import** for data you obtain yourself (TMD, HII …):
  `station_id,time,lat,lon,elevation,t2m[,rain_1h]` where `time` is ISO-8601 **with** a
  timezone, e.g. `2026-10-09T07:00+07:00`. A time without timezone is rejected.
- **Forecasts must be archived continuously**: the app keeps only the last 3 runs, so
  scoring cannot be done retroactively. Demo runs (`THWX_SOURCE=demo`) are never archived.
- Open-Meteo cost: one request per archived run for all stations (about 4 per day,
  ~35 locations each), small next to the main app's usage of the free 10,000 calls/day.

## Running / วิธีรัน

The `verify` compose service runs `python -m verify loop` (hourly: collect → observe → score).
The database is `$THWX_DATA_DIR/verification/verify.sqlite` and the latest report is
`$THWX_DATA_DIR/verification/report.md` (volume `thwx-data`).

```bash
docker compose up -d --build verify
docker compose exec verify python -m verify score --days 7      # print the report now
docker compose exec verify python -m verify collect             # archive the latest run
docker compose exec verify python -m verify observe --since 2026-10-01
docker compose exec verify python -m verify observe --csv /path/obs.csv
```

Environment: `THWX_VERIFY_API` (default `http://localhost:8000`), `THWX_DATA_DIR`,
`THWX_OPENMETEO_MODEL`, `THWX_OPENMETEO_API_KEY`. Use `collect --no-baseline` to skip the
Open-Meteo request.

## Reading the report / อ่านรายงาน

1. Check **N** first. Below 500 matched temperature samples the report warns; collect
   several weeks before drawing conclusions (each run adds up to ~35 stations × 48 h).
2. Compare `MAE` and `Skill` columns. Skill > 0 means better than raw GFS; `fine` should
   win most at long lead times and over high or coastal stations, where downscaling matters.
3. Bias by local hour shows whether the diurnal cycle is right (night minimum, afternoon peak).
4. The per-station table lists the station elevation, the 2 km cell elevation and the model
   elevation: large differences explain large errors.
5. For rain, prefer CSI and Brier over raw hits; frequency bias > 1 means over-forecasting.

## Limitations / ข้อจำกัด

- METAR temperatures are whole °C (≈ 0.3 °C RMS rounding noise in every error).
- Thai METARs carry no rain amounts, so rain is verified as **occurrence only**;
  `VC` (vicinity) weather is ignored. Amounts need gauges or satellite (GPM IMERG), not yet implemented.
- Stations are mostly airports on flat ground or in cities: mountain skill is not covered.
- Station coordinates are used as given; a station can sit in a neighbouring 2 km cell.
- The score is a snapshot of the current method; it does not feed back into the
  calibration constants in `backend/app/downscale/`.
