# REST API

Base path `/api/v1`. Interactive OpenAPI docs at `/docs`.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness + current run id + refresher status |
| GET | `/meta` | Current run metadata, layer catalogue (with encodings), regions, colour scales & thresholds |
| GET | `/layers/{layer}?step=&res=fine\|coarse` | One time step of a gridded layer, `uint8` row-major (south→north), headers `X-Grid-NY`, `X-Grid-NX`, `X-Run-Id`, `ETag` |
| GET | `/layers/rain24?day=&res=` | Daily rainfall total for Thai calendar day `day` |
| GET | `/static/{hillshade\|thai\|elevation}` | Static 2 km layers (uint8) |
| GET | `/geo/{provinces\|countries}` | Simplified GeoJSON outlines |
| GET | `/point?lat=&lon=` | 48 h series at 2 km **and** from the global model (0.25° ≈ 27.8 km), daily totals, and per-process temperature corrections |
| GET | `/provinces` | 77 provinces with daily summaries and alerts |
| GET | `/provinces/{iso}` | e.g. `TH-10`: hourly province means + daily summaries |
| GET | `/alerts?min_severity=1..3` | Province alerts per day (default: every tier; tiers 1 yellow, 2 orange, 3 red – see [ALERTS.md](ALERTS.md)). Entries carry `partial` / `until` for days with incomplete coverage |
| GET | `/nowcast?lat=&lon=` | Radar nowcast for a point (see below) plus active tropical cyclones; 422 outside the domain |
| GET | `/nowcast/layer?lead=0` | Radar reflectivity `uint8` (`linear` -10..75 dBZ, 0 = no echo), headers `X-Frame-Time`, `X-Lead`, `X-Enc-Min`, `X-Enc-Max`, `X-Grid-NY/NX`, `ETag`; `lead` in 0,10..60 min (advected); 404 when unavailable or stale |
| GET | `/nowcast/status` | Radar / cyclone polling status (also under `/health`) |
| POST | `/observations` | *(admin)* Ingest station temperatures for the next run's bias correction |
| POST | `/runs` | *(admin)* Trigger a forecast run now |

Admin endpoints require `Authorization: Bearer $THWX_ADMIN_TOKEN` when the token is set.

## Decoding layers

`/meta` → `layers[].encoding`:

```text
linear: value = min + code / 255 · (max − min)
sqrt:   value = (code / 255)² · max
```

```ts
const r = await fetch('/api/v1/layers/temp?step=0');
const codes = new Uint8Array(await r.arrayBuffer());
const nx = +r.headers.get('X-Grid-NX')!;
const celsius = 0 + (codes[iy * nx + ix] / 255) * 51;
```

Grid cell `(iy, ix)` is centred on `lat0 + iy·dlat`, `lon0 + ix·dlon` (see `meta.run.fine_grid`).

## Observation ingest

```bash
curl -X POST localhost:8000/api/v1/observations \
  -H "Authorization: Bearer $THWX_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '[{"station_id":"48455","lat":13.73,"lon":100.56,"time":"2026-10-09T06:00:00Z","t2m":33.4,"elevation":4}]'
```

Observations within ±90 min of a run's first step are used, and **only one report per station** (the one closest to the run start), so sending several reports of the same station does not over-weight it; residuals are spread with a 40 km / 300 m Gaussian kernel and decay with a 12 h e-folding time. The run's `meta` reports `observations_used` and `observation_stations`. The `verify` service pushes METARs automatically (see `docs/VERIFICATION.md`).

## Nowcast (radar + cyclones)

`GET /nowcast?lat=&lon=` (details in `docs/NOWCAST.md`):

```json
{
  "available": true, "reason": null,
  "frame_time": "2026-10-09T06:20:00+00:00", "age_min": 4,
  "now": {"class": "none", "max_dbz": null},
  "eta_rain":  {"minutes": 25, "minutes_range": [20, 30], "class": "heavy", "max_dbz": 43.0},
  "eta_storm": {"minutes": 30, "minutes_range": [25, 40], "class": "thunderstorm", "max_dbz": 51.0},
  "nearest": {"distance_km": 18.2, "bearing_deg": 225, "class": "heavy", "max_dbz": 43.0, "approaching": true, "closing_kmh": 24.7},
  "motion": {"speed_kmh": 32.0, "heading_deg": 45},
  "cyclones": [{"id": "1001335-7", "name": "Simon", "source": "NOAA", "category": "TY", "max_wind_kmh": 222.2, "peak_category": "TY",
                "report_url": "https://www.gdacs.org/report.aspx?...", "position": {"lat": 15.6, "lon": 110.0},
                "distance_now_km": 820.1,
                "closest": {"time": "2026-10-10T19:00:00+00:00", "hours": 36.0, "distance_km": 410.3},
                "in_wind_zone_kmh": null}],
  "attribution": [{"name": "RainViewer", "url": "https://www.rainviewer.com"}, {"name": "GDACS", "url": "https://www.gdacs.org"}]
}
```

- `class` is one of `none | light | moderate | heavy | thunderstorm | severe`. `eta_*` are `null` when nothing is expected
  within 60 minutes; `minutes: 0` means it is happening now. `heading_deg` is the direction the echoes move **toward**.
- When `available` is `false`, `reason` is `disabled | no_data | stale | no_coverage`; `cyclones` is still filled.
- Cyclones are all currently active storms within 1,500 km of Thailand, nearest first; `category` is `TD | TS | TY`.
