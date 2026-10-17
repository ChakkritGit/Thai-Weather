# HANDOFF

Updated 2026-10-17 (Bangkok) by Codex, for the next agent. Read this file and
`AGENTS.md` before touching anything. Older notes: `docs/` (DEPLOYMENT, ARCHITECTURE, VERIFICATION, …) and
`deploy/README.md`, `deploy/apps/README.md` — where they disagree with this file, this file is newer.

## 1. Working with the owner

- The owner writes Thai, often short. **Reply in Thai.** Code, commits, comments and docs stay English.
- Work is pre-approved ("ทำได้เลย / อนุมัติ"): fix, test, commit, push and deploy without asking.
  Ask first only for things that are hard to undo or outward-facing: deleting DNS records, certificates,
  cloud projects, changing the VPS plan (ReadyIDC), security settings on Cloudflare, anything that sends
  mail/pushes to real people.
- After a change is verified, remove what it replaced (old services, files, images, caches) — the owner
  asks for this every time ("ลบต้นทางเก่า", "เคลียร์อะไรที่ไม่ได้ใช้").
- New services: **Bun + Elysia**. Next.js apps stay Next.js. The owner explicitly authorized a
  **Rust weather HTTP API** on 2026-10-17; the numerical forecast/verification engine stays Python.
  **Defer gRPC**, using HTTP/2 when that separate work is resumed.
- Dependency and image versions: **exact pins, at least 14 days old** at the time you add them.
- The owner tests on an **iPhone** (Safari + home-screen PWA). Check phone layouts, safe areas and iOS
  behaviour before calling UI work done; say plainly what you could not test (pages behind a login).
- This repo is **public**. Never commit secrets, the owner's e-mail, `.wrangler/` (its cache holds the
  Cloudflare account name, which is the e-mail), or `.env` files.

## 2. What runs where

| URL | What | Code | Runs on |
|---|---|---|---|
| thai-weather.chakkritton.com | ฟ้าละเอียด — 2.2 km forecast for Thailand (map, provinces, alerts, verification, free API) | this repo: `frontend/` (Next 16), `backend/` (FastAPI + `verify/`) | VPS, stack `deploy/` |
| chakkritton.com, www | Portfolio + blog, studio, Scrolly assistant | github.com/ChakkritGit/WebProfile | VPS, stack `deploy/apps` |
| expenses.chakkritton.com | Spent/Cost (bills, plans, push reminders) | github.com/ChakkritGit/Spent-Cost | VPS (`apps`); **login = Supabase Auth** (only thing left on Supabase) |
| whiteboard.chakkritton.com | Whiteboard (Yjs rooms) | github.com/ChakkritGit/Whiteboard | VPS (`apps`) |
| drive-music.chakkritton.com | Drive Music (Google Drive player, Party Play sync) | github.com/ChakkritGit/Drive-Music-Web | VPS (`apps`) |
| docker.chakkritton.com | **Dock** — owner's server dashboard (containers, metrics, web stats, backups, chat + web push) | `deploy/dock/` (static www + nginx) and `deploy/apps/services` | VPS |
| status.chakkritton.com | Status page | `deploy/apps/services/src/status/` + `deploy/status-worker/wrangler.toml` | **Cloudflare Worker** `status` (cron */5, KV) — off the VPS on purpose |
| health.chakkritton.com | What the status Worker cannot see from outside (container health + internal services); needs `x-probe-secret` | `deploy/apps/services/src/health.ts` | VPS |
| nginx. / portainer.chakkritton.com | Nginx Proxy Manager / Portainer admin | images | VPS |

Also on Cloudflare: Worker `mr-worldwide` (Scrolly AI, Workers AI), DNS (all proxied, SSL Full strict,
Origin CA cert in NPM), **Email Routing** on chakkritton.com (only used by the status Worker to e-mail the
owner when the VPS is unreachable). **Bot Fight Mode and JS detections are OFF** (owner's decision,
2026-10-16): their injected `/cdn-cgi/challenge-platform` script used a deprecated API and cost ~0.5 s of
main thread on every page. Protection left: origin locked to Cloudflare IPs, ufw, fail2ban, per-IP rate
limits in the apps and the API. Note: `cf bot-management update` is a PUT — send every field or the
others reset to defaults.

VPS: ReadyIDC "VPS Game LG2XS+", Ubuntu 24.04, 4 vCPU / 6 GB / 60 GB (upgraded 2026-10-16). SSH alias `vps`
(key-only, root). Postgres 17 (`apps-db`, max_connections=40) behind PostgREST + the `dbgw` gateway serves
Spent-Cost and Portfolio data. It needs no tuning at this size (checked 2026-10-17): both databases are ~8 MB,
the buffer cache hit rate is 99.9 %, shared_buffers 64 MB already holds everything and the container uses
~35 MB of its 384 MB limit. Revisit only if a database grows past a few hundred MB or the hit rate drops.

Thai Weather data sources besides the forecast runs: Air4Thai (PM2.5 now, every 20 min), FMI SILAM
(PM2.5 forecast field, 0.2°, 72 h, every 3 h — `backend/app/extras/pmforecast.py`; adjusted to the latest
Air4Thai readings on every request: inverse distance, fading ~75 km from stations and with lead time, e-folding
36 h — on 2026-10-17 it took Bangkok from ~61 to 21 µg/m³ against stations at 19), MET Norway (days 3–10).
None of them use the Open-Meteo quota. Gusts and visibility are **estimates** derived from the run
(`backend/app/extras/estimates.py`), labelled as such in the UI, API and /developers.

`deploy/apps/services` (one Bun image, several containers): rooms (whiteboard), sync (Party Play),
health, analytics (page views + Web Vitals for Dock), dbgw, media (portfolio uploads), chat (Dock chat,
monthly report, web push), backup (Dock backups). `reminders` is built from the Spent-Cost repo.

**Next runtime migration (2026-10-17, Codex):** Portfolio, Spent/Cost, Whiteboard and Drive Music now
run their standalone Next servers on **Bun 1.4.2**, with **Elysia 1.4.30** handling app-owned HTTP APIs.
Thai Weather's web runs the same stack. Its API is still FastAPI in production; a Rust HTTP API is
authorized next, retaining the Python numerical engine and verification worker.
Builds still use pinned Node 24.21.0. Auth.js/NextAuth, Supabase Auth, Next server actions and the
existing WebSocket services retain their current behavior. See the rollout record in §9.

## 3. Deploying

- **App repos** (WebProfile, Spent-Cost, Whiteboard, Drive-Music-Web): push to `main` → `apps-autodeploy.timer`
  (every 2 min) pulls, builds and rolls out without downtime (`deploy/rollout.sh`). A Drive-Music push also
  rebuilds the `services` image. Check: `ssh vps 'journalctl -u apps-autodeploy --since "-15 min" | grep -E "deployed|!!"'`.
- **This repo is NOT auto-deployed.** Branch in use: `claude/vigilant-ride-i3yr1m` (the VPS checkout tracks it).
  - weather web: `ssh vps 'cd /opt/thai-weather && flock /run/apps-autodeploy.lock git pull -q && cd deploy && exec 9>/run/apps-autodeploy.lock && flock 9 && docker compose -p thai-weather -f docker-compose.yml -f docker-compose.build.yml build web && COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml ./rollout.sh web'`
  - weather api + verify: same pull, then `build api` and `up -d --no-deps api verify`.
  - Bun services: pull, then `cd deploy/apps && ./build.sh services && docker compose up -d --no-deps <svc>`;
    the `backup` image is FROM the services image: `./build.sh services && ./build.sh backup` together.
  - Dock: `deploy/dock/www` is a directory mount (live after `git pull`); its `nginx.conf` is a bind-mounted
    **file** → `docker restart dock` after changing it (validate with a throwaway nginx first).
  - Status Worker: `cd deploy/status-worker && npx -y wrangler@4.144.0 deploy` (wrangler is logged in on the
    owner's Mac). New cron triggers take ~15 min to start firing.
- One SSH connection per batch of commands: ufw allows **6 SSH connections per 30 s**; beyond that you get
  "Connection refused" for ~30–60 s. Don't poll SSH in tight loops.
- Cloudflare cache: `cf cache invalidate --zone chakkritton.com --body '{"purge_everything":true}' --force`.

## 4. Secrets and access (no values here)

- VPS env files: `/opt/apps/env/*.env` (mode 600) and `/opt/thai-weather/deploy/.env`. Never print them;
  pipe values (e.g. `ssh vps 'grep ^X= …' | wrangler secret put X`).
- Admin passwords: macOS Keychain on the owner's Mac — `security find-internet-password -s <host> -w`
  for nginx.chakkritton.com, portainer.chakkritton.com, docker.chakkritton.com (user `admin` for the last
  two), and the VPS root password (host = the VPS IP, console only). Supabase CLI token: Keychain "Supabase CLI".
- Status Worker secrets: PROBE_SECRET (= `health.env`), HEALTH_TOKEN, ALERT_TO.
- Google Picker API key for Drive Music is commented out in `drive-music.env` (see §7).

## 5. Rules that cost time to rediscover

- **Never trigger extra forecast runs** (no manual `POST /runs`, avoid needless api restarts): one run uses
  ~2,135 of Open-Meteo's 10,000 free calls/day (2,135 locations × 10 variables = 1 call each); 4 scheduled
  runs ≈ 8,540. Keep `HOURLY` in `app/sources/openmeteo.py` at ≤ 10 variables (a test pins it): with 11 every
  location counted 1.1 and the 18Z run of 2026-10-16 failed with 429 (the limit behaves like a rolling day).
  A failed run retries every 30 min. The api skips its start-up run if the latest is < 6 h old.
- **Tests must not touch the owner's real data**: don't post to Dock chat (`/api/chat`, `/chat/alert`), don't
  send pushes or alert e-mails, delete test rows you create. A test once filled the owner's chat.
- **Backups**: Dock → เพิ่มเติม → สำรองข้อมูล makes `chakkritton-server-backup-<date>.zip` (encrypted with the
  owner's passphrase; `restore.sh` inside). Make sure one recent bundle exists before risky server work.
  Nightly `pg_dump` too (`apps-db-backup.timer`, 14 days, `/opt/apps/backups`).
- **Plan upgrades / re-provisioning** at ReadyIDC run cloud-init as a new instance: SSH host keys change and the
  root password is reset to the panel's. Verify host keys from inside before trusting them; set the root
  password back to the Keychain one.
- Next.js app builds on the VPS need the host network + DB mapping (`build.sh`); without it Portfolio's ISR
  pages prerender empty. Portfolio's Prisma pool is capped (2 while building, 5 at run time) because
  `max_connections=40` is shared.
- Next runtime images must create `.next/cache/images` as UID/GID **1000:1000** before Docker seeds
  cache volumes. Existing root-owned named volumes need a one-time ownership repair; rebuilding the
  image cannot change an existing mount. Next memoizes disk-cache initialization failures, so an
  affected process also needs a rolling restart after the repair. Never use world-writable caches.
- Next container health checks use **`/api/healthz`**, not a rendered page or a database/auth probe.
  `init: true` forwards shutdown signals to Bun. Spent/Cost bypasses its auth proxy only for this exact
  liveness path; other application routes remain gated. Public dependency probes (`/api/health`) stay.
- Cloudflare Speed Brain may answer speculative document prefetches with **503** and
  `cf-speculation-refused: prefetch refused: not eligible`, with `sec-purpose: prefetch` on the request.
  These do not reach the origin and do not mean the app is down. Distinguish this exact response in
  browser checks; do not hide other 5xx responses or change Cloudflare settings to make a test pass.
- Pages scroll inside `.app-main` (Thai Weather) / `<main id="app-scroll">` (Drive Music), not the window.
- iOS 27.2 shows letter tiles for every site in "Add to Home Screen" (github.com too) — an iOS bug. Don't
  rework the icons again.

## 6. How to check your work

| Repo | Checks |
|---|---|
| this repo `backend/` | `.venv/bin/ruff check app tests && .venv/bin/ruff format --check app tests && .venv/bin/pytest -q` |
| this repo `frontend/` | `npx tsc --noEmit && npx vitest run && npx next build` |
| `deploy/apps/services` | `bun test` (`bunx tsc --noEmit -p .` — errors under `src/vendor/` are pre-existing) |
| Spent-Cost | `npx tsc --noEmit && npx vitest run && npm run build`; reminders: `cd reminders && bun test server.test.ts` |
| Drive-Music-Web | `npx tsc --noEmit && npx vitest run && npm run build` |
| WebProfile | `npm run build` (`tsc` reports a missing type for `@/assets/ai/land.png` until a build has run — pre-existing) |

Browser checks run against production with Playwright (Chromium/WebKit, iPhone 13 emulation). Lighthouse:
`npx -y lighthouse@13.5.0 <url> --output=json` with Playwright's Chromium as `CHROME_PATH`.

## 7. What is left

### Waiting for data (nothing to do until then)
- Temperature MLP switches itself on after 90 days + 20,000 pairs (≈ mid-January 2027); rain MLP after
  2,000 station rain hours + 30 days (the dry season slows this). Progress: thai-weather…/verification.
- ~2026-10-23: recheck rain-occurrence frequency bias (was 4.7–5×) after the probability-matched-mean change
  (report section 6) and the chance-of-rain calibration (section 8).
- ~mid-November: recheck the learned temperature bias (hold-out MAE in the report; baseline 1.31 °C).

### Needs the owner's decision
- **WRF 3 km**: not feasible on this VPS (full domain ~9–18 h per run even on the 14-core plan). Options: rent
  compute per run, a smaller nested domain, or ingest an existing high-resolution model.
- **Drive Music** stays on `drive.readonly` (Google shows a warning at login unless the app passes
  restricted-scope verification, which the owner declined). The Picker/`drive.file` code is kept; it failed
  in iPhone Safari (third-party cookies).

### Other follow-up work
- **Active: Rust weather API migration.** Replace the HTTP server/routing with Rust, preserve public
  contracts, numerical Python code, persisted data and the existing forecast schedule. Do not start
  duplicate background workers or trigger a forecast for testing. Change Dock's API mark to Rust only
  when the running image carries the Rust stack label. gRPC is explicitly deferred (future HTTP/2).
- **Active: Portfolio scanner CPU.** A read-only 30 s sample after closing QA browsers measured
  17.6% mean CPU with 22 origin requests, 18 of them 404s. Requests included configuration/secret-file
  scans and unrelated paths. Reject known scanner paths cheaply in the origin proxy, preserving
  legitimate files, API/auth/studio/blog routes and normal 404 behavior; measure after deployment.
- Whiteboard has no skeleton (the board opens fast; fine as is).
- Portfolio redirects `/` → `/en` for English browsers (~0.8 s on Lighthouse, which browses in en-US).
- `restore.sh` has been exercised with `--check` and partial restores, never end-to-end on a fresh server.

### Watch after deploys of 2026-10-17
- **Spent/Cost speed**: signed-in pages had TTFB p75 ≈ 2.1 s (Dock → สถิติเว็บ → expenses). The proxy and
  server actions now verify the session with `supabase.auth.getClaims()` (local ES256 check) instead of
  `getUser()` (a Supabase round trip per request). Confirm the owner can still sign in and use the app, and
  that TTFB drops over the next days. If a deeper look is needed: `/` also runs `ensureMonth` and four
  queries; `/settings` still calls `getUser()` on purpose (linked identities).

### Ask the owner to confirm on the iPhone
- New Drive Music skeletons with the real Google session (browser checks used mocked auth/data).
- Collapsed bottom sheet no longer covers the map controls (safe-area fix).
- Bottom-nav tab scrolls to top in Spent/Cost and Drive Music (behind a login, not tested by us).
- The status alert e-mail (sent once as a test on 2026-10-16) renders well in Gmail and is not in spam.
- The PM2.5 view (button PM2.5 on the map): forecast shading + station dots, no other layer at the same time.

## 8. Where the sites stand (Lighthouse 13.5, mobile, 2026-10-16)

| Site | Perf | A11y | Best practices | SEO | Agentic |
|---|---|---|---|---|---|
| thai-weather (map) | 85–95 | 100 | 100 | 100 | 100 |
| chakkritton.com | ~66–77 (hero art is chosen in the browser by design) | 100 | 100 | 100 | 100 |
| expenses /login | ~85–91 | 100 | 100 | 100 | 100 |
| drive-music | ~70–87 | 100 | 100 | 100 | 100 |
| status | ~97 | 100 | 100 | 100 | 100 |

Performance moves ±10 between runs. The map page renders on the server now; only `WeatherMap`
(MapLibre) is `dynamic(..., { ssr: false })` inside `views/MapPage.tsx` — keep it that way, and keep
browser-only reads (localStorage, navigator) in effects so the two renders match.

## 9. Recent changes (2026-10-14 → 17)

### Next + Bun + Elysia rollout (2026-10-17, Codex — deployed and verified)
- Owner expanded the Portfolio trial to all five Next web apps and requested a circular triangular
  Next/Bun/Elysia icon in Dock. Subsequently the owner authorized Rust for the weather HTTP API,
  retaining Python science, and explicitly deferred gRPC until later (HTTP/2).
- Deployment infrastructure/Dock/weather web: **`649f685`** on this branch. App sources on `main`:
  Portfolio **`df6cac8`**, Spent/Cost **`80c6c85`**, Drive Music **`aec9de3`**, Whiteboard **`481eb59`**.
  Portfolio's original Bun/Elysia API change was `2b6ecaa`; runtime/cache commits here were `66f982f`
  and **`91d1142`**. All source changes have been pushed.
- Current running replacements: `apps-portfolio-19`, `apps-expenses-21`, `apps-whiteboard-9`,
  `apps-drive-music-16`, **`thai-weather-web-45`**, all passed Docker health and a direct Bun GET of
  `/api/healthz`. All five production builds and rollouts completed under one SSH batch holding
  `/run/apps-autodeploy.lock`; unmodified reminders/rooms/sync/services were not rebuilt or restarted.
- Elysia routes: Portfolio search/dependency health/liveness; Spent/Cost dependency health/liveness;
  Drive Music authenticated five-minute Party Play token/liveness; Whiteboard liveness (its existing
  Yjs backend already uses Elysia); weather web machine text/RSS/liveness. The browser's weather
  `/api/v1` requests still use the existing Next rewrite to FastAPI. No extra network hop was added
  between Next and its in-process Elysia routes.
- **Portfolio cache/CPU:** the existing `apps_portfolio-cache` was root-owned. Repaired it and added
  owned image-cache directories to both runtime targets; repaired the other three app cache volumes
  before migrating. Confirmed an optimized image changes MISS → HIT, drops from ~487 ms to 5–17 ms,
  and writes files as UID 1000. The broken process had repeated EACCES/unhandled-rejection logs and
  CPU snapshots of 4–47%; post-repair idle snapshots were ~0.4–1%. An isolated Bun browser/profile
  run returned to ~0.5–0.8% after navigation bursts (up to ~34%). The old health check rendered `/`
  every 30 s; `/api/healthz` removes that repeated SSR/database work. Do not describe Bun as using
  zero idle CPU or claim all observed spikes were caused only by the cache error.
- **Measured tradeoff:** the earlier controlled origin trial measured roughly 7% less request CPU
  time for Bun + Elysia, but ~114 MiB more sampled working memory than Node. Median latency changes
  varied by route. The historical report is WebProfile `docs/runtime-trial-2026-10-17.md`; its original
  instruction to limit rollout to Portfolio predates the owner's later request to migrate all apps.
- Dock's composite mark uses the same **20×20 px** footprint, three overlapping circles in a triangle,
  one accessible label and the official Elysia SVG. It appears only when the known Next container's
  image has `com.chakkrit.stack=next-bun-elysia`; older Node images keep the old mark. FastAPI's icon
  is unchanged pending the Rust migration. Production Chromium and WebKit/iPhone checks passed in light/dark themes, including exact
  dimensions, loaded SVGs, accessible labels and no horizontal overflow.
- Local validation passed: weather frontend TypeScript, **79 Vitest tests**, production build;
  Portfolio **25 tests on Node and Bun**, TypeScript and changed-file ESLint; Spent/Cost TypeScript,
  **91 Vitest tests**, changed-file ESLint and build; Drive Music TypeScript, **354 tests** across the
  existing suite and updated API tests, changed-file ESLint and build; Whiteboard TypeScript, ESLint,
  design checks, build and a Bun Elysia liveness check. New API tests also passed with Vitest on Bun.
  Tests mock external auth/data and send no reminders, chat posts or real pushes/e-mails.
- All five public hosts advertise `alt-svc: h3=":443"`. This is user ↔ Cloudflare HTTP/3, not HTTP/3
  to the VPS. Cloudflare's native gRPC proxy requires TLS/HTTP/2; browser gRPC needs a web-compatible
  client/proxy. Existing HTTP/JSON and WebSocket protocols have not been replaced. No DNS, certificate,
  VPS plan or Cloudflare security setting was changed. The owner has deferred gRPC implementation.
- Before rollout, backup bundle `chakkritton-server-backup-20261016-2202.zip` (127,918,989 bytes) existed.
  Weather API start time `2026-10-16T19:10:35.011691526Z` was unchanged after rollout. All five Next
  containers were healthy, with zero restarts/OOMs and no recent EACCES or unhandled rejections.
  Exact temporary pre-migration image tags were checked and were already absent at cleanup.
- Production browser checks passed in Chromium desktop and WebKit/iPhone emulation: Portfolio
  TH/EN/JA search → article and studio sign-in; Expenses public health/auth gates; Drive public routes
  and anonymous token denial; Whiteboard landing; Weather map, TH/EN city search, API rewrites,
  machine text/RSS and generated OG image. No horizontal overflow, runtime errors or genuine 5xx.
  Analytics/chat writes and Cloudflare telemetry were stubbed. Expected Speed Brain prefetch refusals
  were identified by their specific headers, not ignored as generic 503s.
- An isolated, network-disabled production Drive container verified a synthetic NextAuth session →
  Elysia token, SHA-256 room ID, HS256 signature and 300 s expiry; anonymous access returned 401.
  A fresh disposable cache volume verified UID/GID 1000 image-cache writes and was removed. Portfolio
  optimized-image requests were HIT after rollout. No real Google data, notifications or forecast runs.
- Portfolio CPU has a separate remaining scanner-traffic cause (see §7); the Next runtime rollout
  itself is complete. The newer Bun idle-CPU fix is too young for the 14-day dependency rule today.

Everything moved off Vercel / Workers / Supabase DB to the VPS (2026-10-15). Since then: status page back on
Cloudflare with the VPS health endpoint and e-mail fallback; VPS upgraded to 6 GB (swap use 670 MB → 0) and
swappiness 10; test-notification buttons removed from all apps; Thai Weather got PM2.5 station dots,
10-day/details panel, free API + docs, verification page with MLP progress, self-hosted IBM Plex (FCP 3.6 →
1.2 s), accessibility 100; Portfolio hero images re-encoded and cached a month; Drive Music contrast/landmark
fixes; Dock page-shaped skeletons, backup renaming; skeleton fixes in Thai Weather and Portfolio;
bottom-nav scroll-to-top in all apps; Lighthouse accessibility + agentic browsing 100 on every site;
map page server-rendered (LCP 5.7 → ~2–3.7 s); Bot Fight Mode off (best practices 100); Portfolio DB pool capped;
Spent/Cost auth via getClaims; gust/visibility estimates; PM2.5 forecast map (SILAM) as its own view —
picking a weather layer leaves it, the legend and hover switch to PM2.5.
`git log` in each repo has the details and the reasons.

### Dock shared overview time axis (2026-10-17, Codex)
- Deployed `f6504b8`: all metric charts use the original bucket range and the same Bangkok
  wall-clock ticks for a given width. Missing initial history stays blank, including in compact
  container charts, so selecting 1 h / 24 h / 7 d preserves that range across the whole overview.
- Rebinned traffic columns occupy their actual time intervals on that scale. Their drawing,
  pointer selection and crosshair still share one centre; a partial final bucket has the correct
  width and tooltip duration. Daily visitor/report charts retain their real date labels at column
  centres (the 15th still identifies the 328-view column).
- Reproduced the old mismatch before testing all chart types, missing history/gaps, partial bins,
  resize, theme changes and 1/2/7/30/90-day reports locally. Read-only production checks passed for
  all 11 full-size charts and 44 compact charts in all three ranges, in Chromium desktop and WebKit
  iPhone emulation (also with a New York device zone). Verified mouse/touch selection, daily dates,
  no horizontal overflow or runtime errors, and the served script's hash. Chat was stubbed and
  browser writes blocked. Static rollout only; Dock/API start times unchanged, no extra forecast.

### Dock chart dates (2026-10-17, Codex)
- Deployed `318a862`: column-axis labels now sample actual bucket timestamps and use the same
  centres as the columns, crosshair and tooltip. The old interpolated axis labels could put a
  Thursday 15th column above a Wednesday 14th label. Labels include all seven days when space
  permits and select fewer real buckets on a narrow screen; one/two-day charts show dates too.
- Chart axis, tooltip and table timestamps explicitly use `Asia/Bangkok`, matching the analytics
  day's definition even when the device is set to another time zone. Line/area/stack axis geometry
  remains continuous in time.
- Reproduced the old mismatch and checked weekly/single/two-day charts, missing dates, rebinned
  history and resize in Chromium/WebKit with Bangkok, UTC and New York device zones. Read-only
  production checks passed for every displayed label on daily visitors, proxy requests and HTTP
  status charts; the 15th label and tooltip both identify the 328-view column. Static rollout only,
  no service restart, extra forecast or real notification.

### Dock column-chart alignment (2026-10-17, Codex)
- Deployed `f9831e3`: `deploy/dock/www/charts.js` now uses one per-point x coordinate for drawing
  columns, pointer hit-testing and the crosshair/tooltip anchor. Columns occupy equal-width slots;
  the old time-axis positions put the guide off-centre, especially near the first/last column and
  in reports with missing days. Line/area/stack charts keep their time-axis positions.
- Verified syntax and reproduced the old offset before checking single/two/many columns, stacked
  bars, irregular days, missing initial history, rebinned traffic, keyboard, touch, resize and theme
  changes in Chromium and WebKit iPhone emulation. Read-only production checks passed on the traffic,
  HTTP-status and daily visitor charts after signing in with the Keychain credential held in memory.
  The served script matched the tested file; chat access and browser mutations were blocked.
- Rolled out through the existing static directory mount with one locked `git pull`; Dock and the
  weather API were not restarted. No forecast run or real notification was triggered.

### Status coverage (2026-10-17, Codex)
- The status Worker now lists **Thai Weather** and **Thai Weather API** in their own group (13 checks
  total). Every five minutes it reads the public `/` and `/api/v1/health` endpoints separately, with
  the existing transient retry and two-failure incident threshold. API liveness is independent of a
  forecast job failing; these GET requests never trigger a forecast or use the Open-Meteo quota.
- Deployed commit `7729f55` to the existing Cloudflare Worker `status` (version
  `e0bd62a4-20e0-46d6-b050-dada48308b26`). The same KV namespace retains all existing uptime history;
  the new checks start without historical data. No VPS service or weather API was restarted.
- Validation: **69 Bun tests passed**, one pre-existing skip; status TypeScript and Wrangler dry-run
  passed. Notifications in tests were mocked; no test alert was sent to Dock, push or e-mail.
- The normal cron's first results at **08:10 Bangkok** marked both new checks up (web 862 ms, API
  878 ms). Production Chromium/WebKit iPhone emulation and desktop checks passed: two separate rows,
  no horizontal overflow, and only today's new uptime bars populated.

### Also on 2026-10-17 (Claude, after Codex hit its usage limit)
- Codex's last commit `a56b29b` (search results above the phone keyboard, no input outline, the locate
  button as an icon in the right-hand group) was pushed but not deployed; deployed and checked on an
  iPhone 13 emulation (search → pick → point forecast opens).
- PM2.5 forecast adjusted to the stations; forecast runs ask for 10 Open-Meteo variables (surface
  pressure now from the cell's height). See §2 and §5.

### Delivered and verified on production (2026-10-17)
- **Deployed code**: Thai Weather `1c958e9` on `claude/vigilant-ride-i3yr1m`; Drive Music `37988cf`
  on `main`. Thai Weather API/verify were updated once, the weather web and Drive Music rolled out
  without downtime, and the normal Drive Music deploy rebuilt the Bun services and backup image.
  All affected containers were running and their configured health checks passed after rollout;
  `apps-autodeploy.timer` remained active.
- **City search in the weather app**: `PlaceSearch.tsx` on the map, Thai/English with keyboard and touch
  selection, debounced/abortable requests, flies to the result and opens its point forecast. The local
  GeoNames index contains 88,259 places (77 provinces, 928 districts); `GET /api/v1/places?q=` returns up
  to 10 exact/prefix/contains matches under the existing API rate limit, independently of forecast runs.
  GeoNames credit is in the UI/API; `/developers` documents the endpoint. Regenerate with
  `backend/scripts/build_places.py` using a dump outside the repo; see `backend/app/data/places.md`.
- **Drive Music skeletons**: `LoadingSkeletons.tsx` covers the session gate, route transitions, Drive
  folder/track fetches, playlists and the local library. IndexedDB readiness prevents false empty or
  missing-playlist states; previous folder rows are hidden while fetching. Reduced motion is supported.
  Verified production builds and unit tests, plus Chromium/WebKit iPhone emulation and desktop layouts;
  Drive tests use mocked auth and file responses, never the owner's real Google data.
- **Validation**: backend Ruff lint/format and **258 pytest tests**; weather frontend TypeScript,
  **77 Vitest tests** and production build; Drive Music TypeScript, **349 Vitest tests**, ESLint on
  changed files and production build. Total: **684 passing tests**.
- **Production browser checks**: Chromium and WebKit with iPhone 13 emulation, plus desktop layouts.
  Weather checks covered Thai/English queries, keyboard and touch selection, visible map pins above
  the forecast sheet, empty/error states, clearing, Escape, stale-request cancellation and the 16 px
  input. Drive checks covered five route skeletons, light/dark layouts, reduced motion, policy links,
  folder loading, hidden previous-folder rows and the final empty state. Drive auth and file responses
  were mocked; a physical iPhone with the real Google session and home-screen PWA still needs the
  owner's check (see §7). Test analytics were blocked and tests sent no real notifications.
- **Forecast quota and cleanup**: no extra forecast was requested. The run remained
  `20261016T1200Z-open-meteo` before/after rollout and production checks. Unused replaced weather images
  were removed; the app deploy ran its dangling-image cleanup and builder-cache prune
  (`--keep-storage 3gb`). The downloaded GeoNames dump and temporary Drive Music validation checkout
  were removed.
- **Local Drive Music checkout**: sibling `../drive-music-player` is the `Drive-Music-Web` repository;
  it was fast-forwarded to `37988cf` and is clean. Existing untracked files in Thai Weather
  (`frontend/AGENTS.md`, `frontend/CLAUDE.md`, `frontend/supabase/`, `supabase/`) were left untouched.
