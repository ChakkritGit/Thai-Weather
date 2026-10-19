# HANDOFF

Updated 2026-10-19 (Bangkok) by Codex, for the next agent. Read this file and
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
  On 2026-10-18 the owner also authorized migrating the ten standalone Bun services to Rust,
  starting with `dock-metrics`; the five Next/Bun/Elysia web runtimes stay.
  **Defer gRPC**, using HTTP/2 when that separate work is resumed.
- Dependency and image versions: **exact pins, at least 14 days old** at the time you add them.
- The owner tests on an **iPhone** (Safari + home-screen PWA). Check phone layouts, safe areas and iOS
  behaviour before calling UI work done; say plainly what you could not test (pages behind a login).
- This repo is **public**. Never commit secrets, the owner's e-mail, `.wrangler/` (its cache holds the
  Cloudflare account name, which is the e-mail), or `.env` files.

## 2. What runs where

| URL | What | Code | Runs on |
|---|---|---|---|
| thai-weather.chakkritton.com | ฟ้าละเอียด — 2.2 km forecast for Thailand (map, provinces, alerts, verification, free API) | this repo: `frontend/` (Next 16 + Bun + Elysia), `backend/` (Rust HTTP + Python science/`verify/`) | VPS, stack `deploy/` |
| chakkritton.com, www | Portfolio + blog, studio, Scrolly assistant | github.com/ChakkritGit/WebProfile | VPS, stack `deploy/apps` |
| expenses.chakkritton.com | Spent/Cost (bills, plans, push reminders) | github.com/ChakkritGit/Spent-Cost | VPS (`apps`); **login = Supabase Auth** (only thing left on Supabase) |
| whiteboard.chakkritton.com | Whiteboard (Yjs rooms) | github.com/ChakkritGit/Whiteboard | VPS (`apps`) |
| drive-music.chakkritton.com | Drive Music (Google Drive player, Party Play sync) | github.com/ChakkritGit/Drive-Music-Web | VPS (`apps`) |
| docker.chakkritton.com | **Dock** — owner's server dashboard (containers, metrics, web stats, backups, chat + web push) | `deploy/dock/`, `deploy/apps/services`, `deploy/apps/rust-services` | VPS |
| status.chakkritton.com | Status page | `deploy/apps/services/src/status/` + `deploy/status-worker/wrangler.toml` | **Cloudflare Worker** `status` (cron */5, KV) — off the VPS on purpose |
| health.chakkritton.com | What the status Worker cannot see from outside (container health + internal services); needs `x-probe-secret` | `deploy/apps/rust-services/runtime` | VPS |
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

`deploy/apps/rust-services` now runs all ten former standalone Bun services as native Rust:
metrics, health, media, analytics, dbgw, backup, rooms, sync, chat and reminders.
Backup uses a separate pinned tools image. `deploy/apps/services` now holds only the
Cloudflare status Worker and test oracles/JavaScript compatibility fixtures.

**Next runtime migration (2026-10-17, Codex):** Portfolio, Spent/Cost, Whiteboard and Drive Music now
run their standalone Next servers on **Bun 1.4.2**, with **Elysia 1.4.30** handling app-owned HTTP APIs.
Thai Weather's web runs the same stack. Its API has run **Rust/Axum** since 2026-10-18, retaining one
private Python numerical worker and the existing separate Python verification container.
Builds still use pinned Node 24.21.0. Auth.js/NextAuth, Supabase Auth, Next server actions and the
existing WebSocket services retain their current behavior. See the rollout record in §9.

## 3. Deploying

- **App repos** (WebProfile, Spent-Cost, Whiteboard, Drive-Music-Web): push to `main` → `apps-autodeploy.timer`
  (every 2 min) pulls, builds and rolls out without downtime (`deploy/rollout.sh`). Native standalone
  services are owned by this repository and are deployed separately. Check: `ssh vps 'journalctl -u apps-autodeploy --since "-15 min" | grep -E "deployed|!!"'`.
- **This repo is NOT auto-deployed.** Branch in use: `claude/vigilant-ride-i3yr1m` (the VPS checkout tracks it).
  - weather web: `ssh vps 'cd /opt/thai-weather && flock /run/apps-autodeploy.lock git pull -q && cd deploy && exec 9>/run/apps-autodeploy.lock && flock 9 && docker compose -p thai-weather -f docker-compose.yml -f docker-compose.build.yml build web && COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml ./rollout.sh web'`
  - weather api: same pull, then `build api`; assert the old refresher is idle and the latest real
    run is < 6 h old before `up -d --no-deps api`. See `backend/rust-api/README.md`. Only restart
    `verify` when its numerical/verification code changed; a runtime-only API change does not need it.
  - Native app services: pull, then `cd deploy/apps && ./build.sh rust && docker compose up -d --no-deps <svc>`;
    native `backup` is separate: `./build.sh rust && ./build.sh backup`; restart only backup.
  - Rust collector: `deploy/apps/rust-services/README.md`; build `dock-metrics` with the build
    override, compare a read-only candidate first, then stop only metrics for its final history save
    before recreating it. Retain `thai-weather_dock-metrics`; no API/verify/web restart is needed.
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
| this repo `backend/` | Pinned Rust build/fmt/Clippy/tests: `backend/rust-api/README.md`; `.venv/bin/ruff check app tests scripts verify && .venv/bin/ruff format --check app tests scripts verify && THWX_RUST_TEST_BIN="$PWD/rust-api/target/debug/thwx-api" .venv/bin/pytest -q` |
| this repo `frontend/` | `npx tsc --noEmit && npx vitest run && npx next build` |
| `deploy/apps/services` | `bun test` (`bunx tsc --noEmit -p .` — errors under `src/vendor/` are pre-existing) |
| `deploy/apps/rust-services` | Rust 1.90.0 `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, `cargo build --locked`, then `python3 tests/http_contract.py` (see its README) |
| Spent-Cost | `npx tsc --noEmit && npx vitest run && npm run build`; reminders: `cd reminders && bun test server.test.ts` |
| Drive-Music-Web | `npx tsc --noEmit && npx vitest run && npm run build` |
| WebProfile | `npm run build` (`tsc` reports a missing type for `@/assets/ai/land.png` until a build has run — pre-existing) |

Browser checks run against production with Playwright (Chromium/WebKit, iPhone 13 emulation). Lighthouse:
`npx -y lighthouse@13.5.0 <url> --output=json` with Playwright's Chromium as `CHROME_PATH`.
Build the Rust binary before backend tests: omitting `THWX_RUST_TEST_BIN` skips the real HTTP
integration cases and is not a complete backend check. Test sockets need local socket permissions.

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
- **Standalone Bun → Rust migration authorized on 2026-10-18.** The scope is all ten
  standalone Bun services after the current work, excluding the five Next/Bun/Elysia web runtimes.
  Inventory, proposed order, protocol/data requirements and Next/Rust options are documented in
  `docs/RUST-SERVICES-REVIEW-2026-10-18.md`. The owner approved implementation and paused CPU
  investigation at 18:30 Bangkok. `dock-metrics` is deployed. Native Rust **health, media and analytics are deployed** and verified. **dbgw and backup are also deployed**. **All ten standalone ports are deployed and verified**, including rooms, sync, chat and reminders.
  No standalone Bun container remains. Rust can provide
  a separate backend for Next, as in Weather; Next server features still need Bun/Node. gRPC stays
  deferred.
- **gRPC is deferred** at the owner's request; use HTTP/2 when that separate work resumes. The Rust
  HTTP API and all five Next/Bun/Elysia web runtimes are deployed (see §9).
- Whiteboard has no skeleton (the board opens fast; fine as is).
- Portfolio redirects `/` → `/en` for English browsers (~0.8 s on Lighthouse, which browses in en-US).
- `restore.sh` has been exercised with `--check` and partial restores, never end-to-end on a fresh server.

### Watch after deploys of 2026-10-17 → 18
- **Rust API (2026-10-18):** the first ordinary forecast after cutover completed successfully at
  **13:55 Bangkok**, publishing real run `20261018T0600Z-open-meteo`, created
  `2026-10-18T06:55:58.323593+00:00`. At 18:23 Bangkok the refresher was idle, without errors;
  the API container had not restarted. Forty-two normal verification cycles had accepted
  observations through Rust by 18:27, with no rejection or loop failure; the new run was archived. Keep verify's in-use image and the pre-Rust rollback tag.
- **Portfolio CPU:** scanner rejection and owned-image routing are addressed separately (see §9).
  The owner explicitly paused further CPU investigation to prioritize Rust migration. Raising RAM
  did not help; do not resume tuning without new direction. Bun 1.4.3 becomes eligible under the
  14-day version rule on 2026-10-24; do not upgrade early or claim a runtime bug is proven.
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

## 9. Recent changes (2026-10-14 → 19)

### Remove container memory limits (2026-10-19, Antigravity)
- Removed `mem_limit` constraints across all services in `deploy/docker-compose.yml` and
  `deploy/apps/docker-compose.yml` per owner direction, allowing containers to use available host
  memory freely on the 6 GB VPS (where ~3.9 GB was idle/available).
- PIDs limits (`pids_limit`), drop capabilities, security options and health checks are retained.

### Native Dock chat and bill reminders (2026-10-19, Codex)
- **Both are deployed and healthy**, completing all ten authorized standalone ports.
  No new dependencies were added; the 238-dependency lock was already audited.
- Chat preserves SQLite messages/digests/reports/subscriptions/settings and the existing
  VAPID key, paging/read state, secret-authenticated alerts, Thai reports/cards, optional
  Workers AI/OpenAI-compatible replies, nightly digests and once-per-month reports.
- Four native HTTP/TLS suites compare reports to frozen JS and decrypt actual native Web Push
  with WebCrypto, verify ES256 VAPID, and remove expired subscriptions. The earlier chat-only
  static image passed all suites without networking and six GET comparisons against a
  read-only database copy (0 messages, 10 digests, 0 reports, 3 subscriptions, 1 setting).
- Reminders retains Bangkok's ten-minute schedule, status-vs-cron secret priority, month row
  generation, daily claim-before-send receipts, finish acknowledgement fencing, bounded fan-out,
  gone-subscription cleanup and heartbeat only after all deliveries resolve. Only explicit
  pre-SQL JWT clock rejection can retry; unknown push results cannot redeliver automatically.
- Seven native reminder suites use fake REST and HTTPS push only: status/rollout guards, disabled
  candidate cron, JS-equivalent messages/rows, completed-day skips, sent/gone receipts, failed
  claim/finish, uncertain transport, explicit clock skew and ambiguous writes.
- Fourteen Rust unit tests, fmt/strict Clippy and all five existing Python HTTP/JWT/backup fixture
  cases pass. The final static image passed **23 JS contract tests / 139 assertions** across
  rooms, sync, chat and reminders in `--network none`, with synthetic HTTP/TLS services only.
  Its read-only chat GETs matched all six legacy responses; reminders health and authenticated
  status matched the ordinary 08:00 Bangkok heartbeat. No real chat/push/cron was triggered.
- Deployed source `2ec8be2` at 14:44 Bangkok, image
  `sha256:f849f77ba9644eee8a3741dfc5f934f15fdc554e4a69f8d104947e1e325dfd7b`:
  chat `481fabaee92a`, started `2026-10-19T07:44:47.138490743Z`;
  reminders `c763bd1c5958`, started `2026-10-19T07:44:48.879134702Z`.
  No restart/OOM; private rooms/sync/reminders checks all pass. All other containers unchanged.
- Chat's logical database stayed exact, including sequence, all three push subscriptions and
  the original VAPID key. Counts: messages 0, digests 10, reports 0, push subscriptions 3,
  settings 1. Consistent 0600 backup: `/opt/apps/backups/config/chat-before-rust-20261019.db`.
  Reminder heartbeat stayed `2026-10-19T01:00:00.105+00:00`; native waits for its next normal
  ten-minute slot and skips a day already complete. There was no manual production cron.
- Removed the now-unused shared Bun image `639fd018b1ec…`, reminders image `b27b6e91909a…`,
  intermediate candidate `e237c8bcdc41…` and trial directories. No unused volume existed at
  this switch; named data volumes and still-referenced older native images stay.
- Removed legacy production Dockerfiles/build targets and app-autodeploy coupling. Native
  services now deploy solely from this repository; app pushes only roll out their Next web.
  Historical TypeScript protocol/report code remains fixture-only. Next/Bun/Elysia triangles
  stay; native services select Rust icons from their real deployed image labels. A direct Dock
  resolver check passed all ten native services and all five Next composite icon mappings.

- Final inventory caveat: `dock-metrics` already had restart counter 6 and last start
  `2026-10-18T20:53:55.179012944Z` (03:53 Bangkok), before this continuation's rollouts.
  It is healthy with no OOM flag or error/panic in its retained logs; the counter did not
  increase during sync/chat/reminders migration. The other nine native containers have
  zero restarts. No collector restart or CPU tuning was performed in this continuation.

- Final inventory confirms ten healthy native Rust containers and five healthy, unchanged
  Next/Bun/Elysia containers. No unreferenced image or volume remained eligible for cleanup;
  the weather API and Python verify IDs are unchanged. No browser was available for another
  visual check in this continuation; icon resolver checks passed and the existing composite
  SVG layout was unchanged. Implementation CI passed all jobs:
  https://github.com/ChakkritGit/Thai-Weather/actions/runs/39217920239 (`2ec8be2`).

### Native Drive Music sync (2026-10-19, Codex)
- Implemented Party Play protocol 2 in native Rust, retaining account-bound HS256 JWTs,
  per-room serialization, SQLite `kv`, playback after restart (paused), device identity,
  leases, output handoff, generation/revision fencing and legacy snapshot controls.
- Ten Rust unit tests and strict Clippy/fmt pass. Nine real WebSocket contract tests
  and six frozen Bun oracle tests pass with synthetic accounts and temporary SQLite.
  Includes queue persistence, device replacement, stale reports, pending commands and
  lease expiry; no owner's party was joined. The legacy shim/state machine is now
  fixture-only under `services/tests/oracle`, excluded from production image builds.
- Deployed source `fba835a` at 14:33 Bangkok: `apps-sync` is `7ce1c0bedf9f`,
  started `2026-10-19T07:33:03.242449985Z`, image
  `sha256:38e88cfa0de8fa58b31463fde5160f38e682dd0ed508157d7267f4933fdd146a`.
  The actual static image passed all nine JS WebSocket tests in `--network none`;
  its read-only candidate also passed. Healthy, no restart/OOM, all other containers unchanged.
- SQLite integrity and the existing one `kv` row remained exact. Consistent backup:
  `/opt/apps/backups/config/sync-before-rust-20261019.db` (0600).
  Retained `apps_sync-data` and shared Bun image (chat still uses it). Trial removed;
  no unused image/volume was eligible at this cutover. No owner's party joined,
  forecast triggered or real notification sent.

### Native whiteboard rooms (2026-10-19, Codex)
- Implemented native `rooms` with Yrs 0.24.0, Yjs v1 sync/awareness, per-socket cursor
  ownership, 30-second awareness expiry, URL prefix aliases and dropping empty rooms.
  Eight Rust unit tests, fmt/Clippy, four Bun oracle tests and three native JS interoperability
  suites pass. The native image itself passed the JS suites in `--network none`, with only
  synthetic documents: bidirectional strokes, late join, Unicode/rich text, binary map values,
  cursor removal, isolated rooms, bad frames/names and offline browser state seeding.
- All 238 locked registry dependencies passed age/yank checks (2026-10-19); CI pins Bun
  1.4.2 with its official release checksum for protocol clients. No owner board was joined.
  Cutover completed at 08:26 Bangkok: `apps-rooms` is `8d6a584c37c9`, started
  `2026-10-19T01:26:49.837809757Z`, image
  `sha256:66eb6f750f0021a3bb63dee21acfd7d7d2b0bdd748b102370cbded69b5f36b35`.
  Healthy with no restart/OOM; internal rooms/sync/reminders checks pass and all other container
  IDs/start times are unchanged. Removed its old empty anonymous volume `9d6089fb654b…`,
  the unused previous prepared runtime image `77e4c29ffb0e…`, trial files/tag. The original
  TS relay is now only a fixture oracle. Browser documents stay in IndexedDB; no owner room
  was joined or edited during verification.

### Native backup implementation (2026-10-19, Codex)
- `apps-runtime backup` implements the original routes, single-job gate, streamed/range downloads,
  ten-minute links, retention, volume exclusions, git metadata and AES-256-CBC/PBKDF2-600000 zip
  layout. Its image has no Bun or node_modules, uses pinned Alpine 3.22.5 plus the same pg_dump
  17.11/OpenSSL 3.5.9/GNU tar 1.35/zip 3.0 tools. Twenty-six APK versions are explicit pins; the
  base and all package build dates were checked against the 14-day rule.
- Seven Rust unit tests, Clippy/fmt, all native HTTP regression suites, two legacy Bun backup
  tests and a real create/decrypt/retention/download suite pass. The final Docker image also
  passed the suite in an internal network with no egress, fake pg_dump and temporary data.
  Its bundled real `restore.sh --check` passed on the VPS against that fixture, without
  changing any owner data. Restore's workspace now uses mktemp; TMPDIR can confine checks.
- The production candidate disables jobs, mounts only bundles read-only and compares existing
  bundle metadata/hashes. Cutover completed at 08:18 Bangkok: `apps-backup` is
  `d49160d0d6e5`, started `2026-10-19T01:18:24.431516611Z`, image
  `sha256:738d0a68c6e8d90186060dd7579fb6ff0d29d5fba2e3ca70da0a85ffa3619405`.
  Healthy with no restart/OOM; every other container retained its ID/start time. The existing
  128,727,949-byte bundle from 2026-10-17 retained its hash. Removed the unused old Bun backup
  image `4fe85af09c33…`, its empty anonymous `/data` volume `c69fa86f732d…`, candidate tags
  and trial files; no unreferenced volumes remain. The prepared `apps-rust:local` image is kept
  for the next ports. No real backup was triggered as a test.
  Build `./build.sh rust && ./build.sh backup`; app-autodeploy no longer rebuilds this service
  for unrelated Bun/Drive source changes. The old TS driver is retained only as a test oracle.

### Native database gateway (2026-10-19, Codex)
- Deployed source `0d504d2`: `apps-dbgw` is native Rust (`681eb9f16703`, started
  `2026-10-19T01:03:50.719101433Z`), image
  `sha256:b0cd64b01deac6a0927636c056b1613a2dc5ae67c0fadf7c2a661d5c87512930`.
  Healthy, no restart/OOM. Every other container retained its ID/start time.
- Synthetic ES256/JWKS and HS256 tests cover issuer/audience/expiry, wrong role/signature,
  RLS session claims, short-lived re-signing, first-user profile creation against a fake
  PostgREST, streamed writes, manual REST redirects and heartbeat function forwarding.
  Six Rust unit tests, native HTTP suites and four original Bun JWT tests pass; all 179
  locked dependencies passed age/yank auditing. The old TS implementation is test-only.
- A read-only VPS candidate matched three existing GET responses byte-for-byte, two invalid
  auth responses, and a signed local anon token. `DBGW_READ_ONLY=true` blocks writes and
  profile creation in candidates. Production status/reminders heartbeat passes through the
  native gateway, verifying the real service_role read path without sending notifications.
- Removed its empty, unreferenced anonymous `/data` volume (`b6a7a2b8f1a7…`), candidate
  container/tag and trial sources. The shared Bun image remains in use by the five ports
  still pending. No database/schema/transport or Next runtime was changed.

### Native health, media and analytics (2026-10-18, Codex)
- Implemented `deploy/apps/rust-services/runtime` with exact Rust 1.90.0/Axum 0.8.9,
  schema-compatible SQLite analytics, atomic media writes and streamed reads, and authenticated
  health/dependency/alert handling. The static scratch image has no Bun or shell, uses UID/GID
  1000, and carries the Rust stack label. Dock now recognizes health in its central-services group.
- Five Rust unit tests, Clippy, formatting, three actual-HTTP integration suites and the seven
  original Bun fixture tests pass. All 120 locked registry packages passed the age/yank audit.
  Alert fixtures use only a local fake sink; production alert/notification endpoints were not tested.
- A candidate image was built on the VPS and removed after comparison: health container/dependency
  outcomes matched the existing Bun service; eight media reads matched byte/header values, with
  all 17 media files hashed; six analytics queries matched Bun exactly against the same consistent
  SQLite copy (898 views, 2,953 vitals, one salt row). Candidate media was read-only and candidate
  alerts disabled. Cutover completed at 23:47 Bangkok: health rolled without a gap; media and
  analytics were stopped before recreation so there was only one writer. All three are healthy
  with zero restarts/OOM, native processes and Rust labels. Internal probes all pass. All 17 media
  hashes and all 898 views/2,953 vitals/one salt row survived exactly; SQLite integrity is OK.
  The final SQLite backup is `/opt/apps/backups/config/analytics-before-rust-20261018.db` (0600).
  The shared native image is `sha256:d30aa7f4cd2a2ad45ca65230d3651024057aca1203144c615fbccff8bf3e27b8`.
  Health is `apps-health-2` (ID `0bb1c8287055`, started 16:47:23Z); media `4d7a2998f6f1`
  (16:47:40Z); analytics `c2750d01ae93` (16:47:40Z). All other containers retained start times,
  including the Weather API, verify and the five Next runtimes.
- Cleanup removed the old health container's empty, unreferenced anonymous `/data` volume
  (`9307fbb5a66f…`) and temporary candidates/build sources. No unreferenced images or volumes remain;
  the shared Bun image is still used by the six remaining ports and must stay. Production public
  media returned 200 and unauthenticated public health returned 401. A browser recheck was unavailable
  because the previously installed Playwright browser cache is absent; Dock's stack mapping was
  checked directly, and the existing triangle/SVG layout was not changed.
- Build with `deploy/apps/build.sh rust`; CI includes the native checks. Health rolls through its
  existing `apps-health` network alias. Media/analytics retain their existing names and volumes;
  stop the old writers before recreating them, with a final SQLite backup first. Native ports are
  excluded from Bun app-autodeploy restarts. The frozen TS files are test-only oracles.


### Standalone Rust collector (2026-10-18, Codex — deployed and verified)
- The owner authorized standalone Bun → Rust implementation and paused further Portfolio CPU
  investigation. First port: `deploy/apps/rust-services`, Rust 1.90.0/Axum; pure Rust native
  host/cgroup/NPM log collection with the old gzip history and `/metrics` JSON contracts.
- The amd64 static binary runs in `scratch`, reusing the already pinned Rust build-image digest.
  All 55 locked crates are the weather API's audited versions. No new framework/runtime version.
- Eight Rust tests and three real HTTP/lifecycle tests pass, including complete-line offsets,
  partial writes/truncation/rotation, time zones, counter/gauge buckets, missing values, persisted
  resume, gzip/status/query compatibility, graceful save, read-only serve mode and writer lease.
  Rust formatting/strict Clippy and Python lint/format passed. CI now runs these checks.
  CI for `f5bb028` passed backend (including the Rust/HTTP tests), frontend and tokens:
  `https://github.com/ChakkritGit/Thai-Weather/actions/runs/39124328270`.
- Linux candidate read **one copied production history** in serve-only mode, with no network and
  read-only host/log/data views. All values, gaps and timestamps matched the Bun reader for 1h
  (360 points/25 container IDs), 24h (1440/41) and 7d (1008/322); all nginx series and static host
  snapshot fields matched. No public routing, production volume writes or real notifications.
- A separate shadow sampler collected new host/container data and saved its private copy on
  shutdown. Its 20 s observation used 36.85 MiB working memory + 4.99 MiB swap and 0.191% of one
  CPU; live Bun used 66.86 MiB + 52.84 MiB swap and 0.922%. These short mostly idle samples are
  not load benchmarks or a promise of exact savings. Candidates and copied data were removed.
- The old Bun source is frozen under `deploy/apps/services/tests/oracle/`, excluded from runtime
  images; `src/metrics.ts` is removed. App autodeploy no longer restarts this separate Rust service.
  Dock selects Rust only for a known Bun service whose actual image label is `com.chakkrit.stack=rust`.
- Deployed **`f5bb0287cea5fef25896382f00152a2537ece71b`**. Only `dock-metrics` was recreated:
  container **`7fa2a9c4955baa1deec170ad1b47b0ee6d01fc4fa93dfdd03088607bdd5c63a7`**, started
  **2026-10-18T11:43:29.580560582Z** (18:43 Bangkok), image
  **`sha256:f3e13aa499b32cd8e48ba2996fcc8bf91168729727aac351217e80036d4a6008`**.
  Docker health passed with zero restarts/OOMs. All other container IDs/start times stayed unchanged.
- Waited for Bun's final save, backed it up privately at
  `/opt/apps/backups/config/dock-metrics-before-rust-20261018T114328Z.json.gz` (1,078,461 bytes),
  and reused **`thai-weather_dock-metrics`**. After cutover **366,352 retained values** matched;
  new host/container samples appeared. No history/database migration or new public port/network.
- The first ordinary periodic save completed at **2026-10-18T11:48:31.949219Z** (18:48 Bangkok),
  without a restart or manual save. The 1,129,451-byte gzip contains the current Rust container's
  samples and resumed offsets for 11 log files. Health stayed good, with zero restarts/OOMs.
- Authenticated production Dock checks passed in Chromium desktop and WebKit/iPhone, light/dark:
  both API and metrics show Rust, verify shows Python, and all five Next/Bun/Elysia triangles stay
  20×20 px. Overview SVG charts rendered; all three metrics ranges returned correct lengths and
  populated data. Anonymous `/api/metrics` still returns 401. No overflow/runtime errors or real
  chat writes; served asset hashes match the checkout.
- Removed only explicitly inventoried, unreferenced images and temporary candidate/rollback tags.
  The old shared Bun image remains in use by other services; verify's Python image/rollback tag
  remains in use too. The unused standalone Python base reference was removed (shared layers were
  retained, so immediate disk gain was only ~2.3 MiB). The unused Portfolio image was removed
  earlier. Every named volume was referenced by a container, including stopped containers:
  **zero unused volumes, zero volume deletions**. Candidate build directories/copied data removed.
- Remaining authorized standalone ports, in review order: **health, analytics, media, dbgw, backup,
  Drive sync, Yjs rooms, chat, reminders**. Keep each protocol/data/notification boundary; see the
  review document. Next/Bun/Elysia renderers remain outside the rewrite; gRPC remains deferred.

### Rust API migration (2026-10-17 → 18, Codex — deployed and verified)
- The owner authorized Rust for the HTTP API, retaining Python numerical science. gRPC is deferred
  until separate HTTP/2 work. `backend/rust-api` now owns HTTP/routing/auth/quotas/CORS/gzip, native
  offline place lookup, persisted grid slices, GeoJSON/report files and OpenAPI. A supervised private
  Python worker provides numerical products and existing background tasks over a bounded Unix socket.
- FastAPI/Uvicorn are removed from the production image; the old thin HTTP adapter/quota oracle is
  test-only under `backend/tests/oracle`. Python base layers were verified **identical** to the running
  pre-migration API; Python 3.12.15 and all 33 scientific/runtime package versions are retained and
  pinned in `requirements-runtime.txt`. All 75 newly added Rust crates passed the 14-day release-age
  audit; ten too-new initial transitive resolutions were downgraded in the committed lockfile.
- Local Rust build, formatting, strict Clippy and six unit tests pass. The real Rust → Python HTTP
  integration passed 46 cases, including byte-identical layers, JSON products, 304s, search, validation,
  auth, quotas, chunked-body limits, redirects and schema. The current **333 Python tests** include
  real HTTP, Unix IPC, writer lease and fake push-worker coverage. The full 332-case suite and final
  46 affected cases passed locally; CI for **`d9e9732`** passed backend, frontend and generated tokens.
  Ruff lint/format passed; weather frontend TypeScript and its two web-owned API tests passed.
- The Linux candidate matched **47 live contracts**, including 22 native grid slices and ten place
  queries, with networking off, production data read-only and background tasks disabled. The first
  candidate exposed missing GeoJSON validators; **`d9e9732`** fixes ETag/Last-Modified and preserves
  legacy integral-decimal query parsing. The corrected Linux comparison passed before cutover.
- Deployed **`d9e9732`**; `thai-weather-api` started **2026-10-18T00:49:43.76355323Z** (07:49 Bangkok),
  image **`sha256:72ad50ea2ee5a23996d11e3404822a5ee72cb38f5d1fc4f2b320ff1ea2212b51`**. Waited for the
  old API's existing normal forecast to finish, then switched only the API. The published real run
  stayed **`20261018T0000Z-open-meteo`**, created `2026-10-18T00:49:38.063223+00:00`; startup's first
  wait was 21,580 s. No extra forecast was triggered. Web, verify and all four other Next container
  IDs/start times were unchanged. The VAPID key and subscription storage were retained.
- Docker health passed with zero restarts/OOMs and no recent import/permission/runtime errors.
  The process tree is Tini → Rust → one private Python numerical worker, with no Uvicorn/FastAPI.
  Read-only checks passed for forecast, radar, Air4Thai/SILAM, public key, authenticated push status,
  verification and schema. At 13:04 Bangkok, **20 normal verification cycles** had accepted station
  observations through Rust, with zero API rejections or loop failures; no manual ingestion was used.
- The first normal forecast after cutover also completed: **`20261018T0600Z-open-meteo`**, created
  **2026-10-18T06:55:58.323593+00:00** (13:55 Bangkok), with refresher success at 06:55:58.713200Z.
  At 18:23 Bangkok the same API container was healthy, idle, error-free and had zero restarts/OOMs.
  This was its ordinary six-hour schedule; no manual forecast request or API restart was used.
- Production Chromium desktop and WebKit/iPhone checks passed for city search → point forecast,
  public API rewrites, machine text/RSS and generated OG images, with no overflow/runtime errors or
  genuine 5xx. Dock checks passed in light/dark: the API now shows Rust, verify still shows Python,
  and all five loaded Next/Bun/Elysia marks retain their **20×20 px** triangular footprint in both
  list and overview. Served Dock asset hashes match the checkout. Chat/analytics writes were blocked.
- Disposable candidates were removed; the only remaining Rust-labelled image is the running one.
  The pre-Rust image `sha256:bbd3c368ee628b990271b21ced99f73575c48c4f381b4a20a0b44d281bb9a4af` is still
  used by **verify**, also named `thai-weather-api-before-rust:20261017` for recovery. Keep it until
  verify is deliberately updated; do not restart verify merely to remove an image. Encrypted backup
  `chakkritton-server-backup-20261017-1900.zip` (128,727,949 bytes) existed before cutover. See
  `backend/rust-api/README.md` for operational constraints. gRPC remains deferred.

### Portfolio image path and idle CPU (2026-10-18, Codex — deployed and verified)
- The long-lived `apps-portfolio-19` used **4.96%** CPU during a 30 s sample with zero origin
  requests. Native thread sampling identified most sampled CPU in Bun's `HeapHelper` GC threads.
  Raising RAM from 384 to 512 MiB without restart left CPU at **4.61%**; the cap was restored.
- A same-image replacement, `apps-portfolio-20` (06:10:24Z), initially settled below 1.1%, but
  returned to **5.92%** after full browser navigation. Five hours later a 60 s read-only sample
  still averaged **5.25%** with zero origin requests, no swap, major faults or memory-cap events.
  A restart alone did not solve the problem.
- Controlled Chromium/WebKit navigation with image fixtures idled at 0.12–0.14%; real local-image
  optimization also idled near 0.20%. Shiki initialization and Sharp alone were not demonstrated
  causes. Next 16.3.8 uses dedicated HTTP/HTTPS agents for remote image reads; no specific Bun
  fetch/AbortSignal bug has been proven. No Shiki/Sharp settings, RAM cap or dependency changed.
- WebProfile **`7eceb3b`** sends owned Next image sources through relative `/media/...` paths.
  A `beforeFiles` rewrite reads the existing private media service via `MEDIA_INTERNAL_URL`,
  avoiding a public HTTPS round trip through Cloudflare/NPM. Stored/canonical URLs, external
  images and existing media authentication remain unchanged; the locale proxy skips `/media/`.
- The private candidate stayed on its existing internal network with loopback-only access.
  TH/EN/JA search → article → studio login passed Chromium and WebKit/iPhone with real images,
  no fixtures, no genuine 5xx or runtime errors. Seven optimized image URLs passed, with cache
  HIT. Its following 60 s idle mean was **0.15%**, with no swap or memory-cap events.
- Local Node and Bun each passed **29 tests**; TypeScript, changed-file ESLint, seven locale-proxy
  match checks and the production build (143 pages) passed. No new package/image versions were
  added. Tests did not write analytics, post chat or send notifications.
- Pushed **`7eceb3bdcca3a0eb11f0e63c86935184ec778ffd`** to WebProfile `main`, then promoted that
  exact tested image under the deploy lock. Current **`apps-portfolio-21`** started
  **2026-10-18T11:24:50.957265304Z** (18:24 Bangkok), image
  **`sha256:18a146ec146d53178ab5723a927b96a417c797de9df5d5aadb0dbe98bc8a387e`**.
  Health, 384 MiB cap and zero restarts/OOMs passed; API, verify and the other four Next container
  IDs/start times stayed unchanged. The temporary candidate and SSH loopback listener were removed.
- Production Chromium and WebKit/iPhone repeated the same three-locale SSR/search/article/login
  checks successfully. All seven real optimized image URLs used the private media source and
  cache HIT; no image fixtures, runtime errors, overflow, real analytics writes or genuine 5xx.
  Expected Cloudflare speculative prefetch refusals were identified only by their exact headers.
- Production's first post-browser 60 s mean was **6.20%** with two origin requests; a subsequent
  sample after settling was **0.98%** with zero requests. The image-path change is functionally
  verified, but a persistent runtime CPU fix is not proven. Candidate measurements used a one-CPU
  cap that production lacks; the interrupted follow-up control was discarded. The owner paused
  this investigation on 2026-10-18 to start standalone Rust ports. No CPU-limit/GC setting changed.
- Removed the unused previous Portfolio image and the trial tag after verifying container refs;
  the live image remains `apps-portfolio:local`. All temporary candidates/listeners were removed.

### Portfolio scanner CPU (2026-10-17, Codex — deployed and verified)
- Deployed **`33fbd4d`**. A live 30 s sample after QA browsers closed had 22 origin requests (18 404s)
  and 17.6% mean CPU. Config/secret-file scans were repeatedly invoking expensive localized Next 404s.
  The Portfolio-only NPM guard now returns cheap 404s for confirmed scanner paths, without a Next call.
- Controlled 20-request origin samples before/after used **1877 → 85 ms backend CPU**, with median
  elapsed request **54.5 → 17.4 ms**, including local curl/TLS overhead and any concurrent traffic.
  This measures scanner rejection, not general page speed or guaranteed total idle CPU.
- `nginx -t` passed. The targeted NPM update preserved all existing host settings and saved a private
  rollback config at `/opt/apps/backups/config/npm-portfolio-20261017T164703Z.json`. The guard is also
  included by `deploy/apps/npm-hosts.py` so future host regeneration retains it.
- Chromium desktop and WebKit/iPhone checks passed after deployment for TH/EN/JA SSR/search/article
  navigation, images and studio sign-in; no overflow, runtime errors, genuine 5xx or real analytics
  writes. No app/container restart, forecast, Cloudflare/DNS/certificate change or real notification.

### Next + Bun + Elysia rollout (2026-10-17, Codex — deployed and verified)
- Owner expanded the Portfolio trial to all five Next web apps and requested a circular triangular
  Next/Bun/Elysia icon in Dock. Subsequently the owner authorized Rust for the weather HTTP API,
  retaining Python science, and explicitly deferred gRPC until later (HTTP/2).
- Deployment infrastructure/Dock/weather web: **`649f685`** on this branch. App sources on `main`:
  Portfolio **`df6cac8`**, Spent/Cost **`80c6c85`**, Drive Music **`aec9de3`**, Whiteboard **`481eb59`**.
  Portfolio's original Bun/Elysia API change was `2b6ecaa`; runtime/cache commits here were `66f982f`
  and **`91d1142`**. All source changes have been pushed.
- Initial Bun rollout containers: `apps-portfolio-19`, `apps-expenses-21`, `apps-whiteboard-9`,
  `apps-drive-music-16`, **`thai-weather-web-45`**, all passed Docker health and a direct Bun GET of
  `/api/healthz`. All five production builds and rollouts completed under one SSH batch holding
  `/run/apps-autodeploy.lock`; unmodified reminders/rooms/sync/services were not rebuilt or restarted.
- Elysia routes: Portfolio search/dependency health/liveness; Spent/Cost dependency health/liveness;
  Drive Music authenticated five-minute Party Play token/liveness; Whiteboard liveness (its existing
  Yjs backend already uses Elysia); weather web machine text/RSS/liveness. The browser's weather
  `/api/v1` requests retain the existing Next rewrite (now to Rust). No extra network hop was added
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
  image has `com.chakkrit.stack=next-bun-elysia`; older Node images keep the old mark. The API's Rust
  mark is tied to its actual `rust-python` label. Production Chromium and WebKit/iPhone checks
  passed in light/dark themes, including exact dimensions, loaded SVGs, accessible labels and no
  horizontal overflow.
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
- Portfolio's scanner-traffic guard and private image-source route are documented separately above.
  The Next runtime rollout itself is complete. Bun 1.4.3 was released on 2026-10-10 and is too young
  for the 14-day dependency rule until 2026-10-24.

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
