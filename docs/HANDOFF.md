# Handoff / ส่งต่องาน

_Last updated: 2026-10-09_

## สถานะปัจจุบัน (Current state)

| Area | Status | Notes |
|---|---|---|
| Downscaling engine | ✅ working | 48 h × 316k cells × 8 members in ~30 s on one core |
| Sources | ✅ demo · ✅ Open-Meteo (unit-tested with mocked HTTP) | Open-Meteo could not be reached from the build sandbox — **run one live test before production** |
| API | ✅ 12 endpoints, gzip + ETag | OpenAPI at `/docs` |
| Web app | ✅ map, compare, point, provinces, alerts, method, design system | TH/EN, light/dark, mobile |
| Design tokens | ✅ DTCG source → CSS/TS/JSON | shared thresholds with backend |
| Tests | ✅ backend 25 (pytest) · frontend 8 (vitest) | `ruff`, `tsc` clean |
| Deploy | ⚠️ Dockerfile, compose, CI workflow, Vercel config written | Docker image **not yet built** (no Docker daemon in the build sandbox) – build once and fix if needed; see `docs/DEPLOYMENT.md` |
| Calibration / verification | ❌ not done | constants are physically motivated first guesses |

## Run it

```bash
docker compose up --build                     # http://localhost:8000
# or: backend `uvicorn app.main:app --reload`, frontend `npm run dev`
```

## Map of the code

| Want to change… | Look at |
|---|---|
| a physical correction | `backend/app/downscale/physics.py` (element-wise, also used by the point explanation) |
| convective rain structure | `backend/app/downscale/precip.py` |
| the per-hour orchestration / stored layers | `backend/app/downscale/pipeline.py`, `layers.py` |
| alert thresholds, map colours | `design-system/tokens/weather.json` → run `node design-system/scripts/build-tokens.mjs` |
| a new data source (WRF, ECMWF open data, TMD NWP) | implement `Source.fetch()` returning `CoarseForecast` (`backend/app/sources/base.py`) |
| static terrain / boundaries | `backend/scripts/build_static.py` (needs `pip install -e ".[build]"`) |
| UI | `frontend/src/pages/*`, `components/WeatherMap.tsx`, styles in `src/design/base.css` |

## Known issues / caveats

1. **Open-Meteo quota** – a 0.25° lattice is ~2,100 locations per fetch; the free tier (10k calls/day) supports refreshing every 6 h, not 3 h. Use an API key or a coarser `THWX_REFRESH_MINUTES=360`.
2. **Scheduler in-process** – one backend replica must run continuously. With several replicas, either share `THWX_DATA_DIR` and run the refresher in only one (add a flag), or split it into a worker.
3. **Province names** come from our ISO-code table (`core/provinces_meta.py`) because Natural Earth's Thai names contain errors.
4. **Rain-coverage terms** (`rainCoverage` in `weather.json`) should be confirmed against TMD's current glossary.
5. **Frontend bundle** is ~1 MB (MapLibre ≈ 800 KB). Could be code-split per page.
6. Province drawer charts show province means; a per-province 22 km comparison is not yet shown.

## Roadmap (suggested order)

1. **Verification harness** – ingest TMD/HII station history + GPM IMERG; nightly scores (MAE by elevation band, FSS, reliability); store in the run folder and show on the Method page.
2. **Calibrate constants** in `physics.py` / `precip.py` per season and region using (1).
3. **Live observations** – scheduled TMD open-data / HII ingest into `POST /observations`.
4. **More sources** – ECMWF open data (0.25°), ICON, GFS ensemble for real uncertainty; blend them.
5. **WRF 3 km** – `infra/wrf/` + a `WRFSource`.
6. **Products** – PM2.5 dispersion (burning season), flood index with 72 h accumulation and catchments, agriculture (ET₀, spraying windows), push alerts (LINE / web push), PWA offline cache.
7. **i18n** – move remaining inline strings to `src/i18n` and add more languages (Lao, Khmer, Burmese – same tropical problem).

## Decisions taken without the owner (please confirm)

- Licence **MIT** for code (data keeps its own terms – see README).
- Product name **ฟ้าละเอียด / Thai Weather HD**.
- Alert levels: Department of Health heat index, TMD rain/temperature terms, Beaufort wind; a system-defined "extreme rain ≥ 150 mm" level.
