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
| GET | `/point?lat=&lon=` | 48 h series at 2 km **and** from the 22 km model, daily totals, and per-process temperature corrections |
| GET | `/provinces` | 77 provinces with daily summaries and alerts |
| GET | `/provinces/{iso}` | e.g. `TH-10`: hourly province means + daily summaries |
| GET | `/alerts?min_severity=1..3` | Province alerts per day (default: every tier; tiers 1 yellow, 2 orange, 3 red – see [ALERTS.md](ALERTS.md)). Entries carry `partial` / `until` for days with incomplete coverage |
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

Observations within ±90 min of a run's first step are used; residuals are spread with a 40 km / 300 m Gaussian kernel and decay with a 12 h e-folding time.
