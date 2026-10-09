# Architecture

```
┌────────────────────┐   hourly fields on a ~0.25° lattice
│ Global model        │   (elevation=nan, cell_selection=nearest → raw cell values)
│ GFS/ECMWF/ICON via  │──────────────┐
│ Open-Meteo  | demo  │              ▼
└────────────────────┘     ┌──────────────────────┐
                            │ CoarseForecast        │  sources/base.py
                            │ t2m td2m precip cape  │
                            │ u10 v10 u850 v850     │
                            │ cloud sw psfc + orog  │
                            └──────────┬───────────┘
 static 2 km layers ─────────────────┐ │
 (DEM mean/std, land, Thai mask,     ▼ ▼
  provinces, TPI, slopes, coast,  ┌──────────────────────┐   station obs (POST)
  UHI kernel)  core/static.py      │ Downscaler            │◄── downscale/observations.py
                                    │ downscale/pipeline.py │
                                    └──────────┬───────────┘
                     per hour: physics.py (T, RH, wind, rain factors)
                               precip.py   (K-member convective ensemble)
                                               ▼
                            ┌──────────────────────────────┐
                            │ RunStore (store.py)           │  var/runs/<run_id>/
                            │ fine_<layer>.npy  uint8 memmap│  atomic rename, keep 3
                            │ coarse_<layer>.npy            │
                            │ provinces.json  meta.json     │
                            └──────────┬───────────────────┘
                                       ▼
                            FastAPI  api/routes.py  (gzip, ETag)
                                       ▼
   Next.js server (frontend/)  — SSR pages, /api/v1 rewrite proxy
                                       ▼
          browser: React + MapLibre (map is client-only, lazy-loaded)
```

## Key decisions

| Decision | Why |
|---|---|
| **Own downscaling instead of Open-Meteo's** | We request raw grid-cell values so every correction is ours, documented and explainable per point (`temperature_components`). |
| **8-bit layers** (`downscale/layers.py`) | 316k cells × 48 h × 11 layers fits in ~150 MB on disk; ~80 KB/frame gzipped to the browser. Linear or √ encodings keep useful precision (0.2 °C, fine resolution for light rain). |
| **Memory-mapped runs** | API workers read only what a request needs; a new run is written to a temp dir and renamed atomically. |
| **Client-side colouring** | The browser receives values, not pictures: instant hover read-outs, legends and colours straight from the design tokens, theme switches without refetching. |
| **Mercator-correct rasterising** (`frontend/src/lib/render.ts`) | A lat/lon image stretched linearly in Web Mercator would be misplaced by up to ~15 km. |
| **Self-hosted basemap** | Ocean/land/borders from Natural Earth + hillshade from our DEM: no third-party tile or glyph server, works offline and on slow links. |
| **Tokens as the single source of truth** | `design-system/tokens/weather.json` holds both colour scales *and* alert thresholds; the build copies them into the backend so alerts and legends never disagree. |
| **Next.js App Router** | Server components fetch from the API (cached with `revalidate`) so province/alert pages are indexable and shareable; the map is a client-only island (`next/dynamic`, `ssr:false`) because MapLibre needs `window`. `/api/v1/*` is rewritten to the backend, so the browser never needs CORS. Language/theme live in cookies so the server renders the right one. |
| **Demo source** | The whole stack (and CI) runs without network access; demo output is always flagged in API (`demo: true`) and UI. |

## Performance (1 CPU core, 48 h, 8 members)

| Stage | Time |
|---|---|
| Fetch (Open-Meteo, 22 requests × 100 points) | 10–40 s (network) |
| Downscale + ensemble + products | ~25–35 s |
| Point API | ~20 ms |
| Layer API | < 5 ms (memmap slice + gzip) |
