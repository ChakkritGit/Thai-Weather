# Native app services

`apps-runtime <role>` runs one native service per container: health, media,
analytics, dbgw, backup, rooms, sync, chat, reminders, portfolio-api and weather-web-api.
The image has no JavaScript runtime. The five Next web apps keep Bun for SSR,
Auth.js/Supabase sessions and server actions; their former Elysia APIs use Rust.
The parent directory still builds the independent metrics collector.
Original HTTP paths, environment names, volume paths, secrets and SQLite schemas
are retained. Frozen Bun implementations in `../../services/tests/oracle/` are
fixture oracles only, excluded from production images.

## Checks (Rust 1.90.0)

```
cargo +1.90.0 fmt --check
cargo +1.90.0 clippy --locked --all-targets -- -D warnings
cargo +1.90.0 test --locked
cargo +1.90.0 build --locked
python3 tests/http_contract.py
python3 tests/gateway_contract.py
python3 tests/web_api_contract.py
python3 tests/backup_contract.py
python3 ../../../../backend/scripts/audit_rust_lock.py --added-on 2026-10-20 --lock Cargo.lock
```

HTTP fixture writes and alerts use temporary directories and fake local servers.
Never test real alerts, chat, notifications or production uploads.

## Deployment

From `deploy/apps`, `./build.sh rust` builds `apps-rust:local`: static glibc,
exact Rust builder digest, UID/GID 1000, no shell or Bun. Compose supplies init,
PID limits, read-only root filesystems and `/apps-runtime <service> --healthcheck`.
CPU and memory are uncapped by the owner's direction.

## Next + Rust APIs

- `portfolio-api` (8800): published search and database health. Only `DATABASE_URL`
  is passed in `portfolio-api.env`; one shared native Postgres connection sets
  read-only transactions and a five-second statement timeout. Studio mutations,
  revalidation and SSR content queries remain in Next. Prisma-specific pool/schema
  URL parameters are removed for the native driver; the deployment uses public schema.
- `dbgw` (8791): `/site/health` reproduces Spent/Cost's anonymous read-only database
  and Supabase Auth probes. No session is forwarded and no profile is created.
- `sync` (8788): `/internal/token` signs five-minute HS256 tokens, gated by the
  existing private `PARTY_TOKEN_SECRET` in `x-sync-secret`. Next verifies the
  Google session and supplies its account; browser account input is never forwarded.
- `weather-web-api` (8801): `/llms.txt`, `/llms-full.txt`, `/feed.xml` format the
  existing API's GET responses. `THWX_API_URL` and `SITE_URL` retain their web
  meanings. Independent caches singleflight each upstream path for 600 seconds;
  failures retry after five seconds. It cannot schedule a forecast or send alerts.

Thin Next route handlers forward fixed paths using `APP_API_URL` (Portfolio,
Spent/Cost), `SYNC_API_URL` (Drive Music) or `THWX_WEB_API_URL` (Weather), with
production internal defaults. Browser credentials/headers and redirects are not
forwarded. `/api/healthz` stays a process-only Next handler in every web app.
Whiteboard already uses native Rooms and needs no additional backend process.

Additional isolated checks:

```
# On a Docker host; creates a separate internal network and disposable Postgres.
APPS_RUST_TEST_IMAGE=apps-rust:local python3 tests/portfolio_contract.py
cd ../../../../frontend
APPS_RUST_TEST_BIN=/absolute/path/to/apps-runtime npx vitest run src/lib/weather-native.test.ts
```

The frozen Weather renderers under `frontend/tests/oracle/weather` are test-only.
Golden comparisons cover exact bytes, Thai dates, forecast thresholds/partial
days, XML escaping, RSS filtering, GET/HEAD, caching, concurrency and upstream failure.
Deploy native destinations before rolling out the corresponding Next adapters.
Keep `next-bun-elysia` images available until each web rollout is verified; Dock
recognizes both that label and `next-bun-rust` during cutover.

Run candidates without public ports or Compose labels. Health candidates require
`HEALTH_ALERTS_DISABLED=true`; compare authenticated GET reports only (reminders'
existing POST heartbeat is read-only). Media candidates mount production media
read-only. Analytics candidates use a consistent SQLite backup copy and
`ANALYTICS_READ_ONLY=true`; optional `ANALYTICS_NOW_MS` freezes read-only queries.
These controls cannot be enabled by HTTP clients.

Health can use `../rollout.sh health` with its preserved `apps-health` network
alias. Media and analytics retain fixed names and volumes: record media hashes
and a consistent SQLite backup, then stop and recreate only these services.
Verify native process, health, data and public routes. Do not restart Weather
API/verify/web. Remove only exact unused images and unreferenced volumes after
checking all running and stopped containers.

Database gateway candidates must set `DBGW_READ_ONLY=true`: only GET/HEAD are
allowed and authenticated profile creation is skipped. JWT/first-user profile,
RLS claim and write forwarding tests run against a disposable fake PostgREST and
JWKS server with synthetic ES256 and HS256 keys. Never test writes with owner
sessions. Production preserves the `apps-dbgw` name and restarts only this proxy.
The five Next runtimes and Postgres/PostgREST are not restarted.

Backup uses the same native binary in a pinned Alpine 3.22.5 image with the
existing pinned pg_dump 17.11, GNU tar 1.35, OpenSSL 3.5.9 and zip 3.0 toolset.
Run `./build.sh rust && ./build.sh backup`. Every Alpine package is pinned;
base digest and package build dates were checked against the 14-day rule.
The restore format remains AES-256-CBC/PBKDF2-600000 inside the existing zip.
The native integration suite builds/decrypts a temporary fixture bundle with a
fake pg_dump; it checks nested volume archives, metadata, retention, links and
range downloads. Production candidates require `BACKUP_JOBS_DISABLED=true`
and read-only bundle mounts. Never start a production bundle as a test.
Before cutover, require no active backup job and compare the existing bundle
list/hashes. Retain all original mounts/capabilities and restart only backup.

Rooms uses Yrs 0.24.0 with Yjs v1 sync/awareness, per-socket cursor ownership,
30-second awareness expiry, prefix aliases and ephemeral rooms. Interoperability
uses official JavaScript Yjs clients over real WebSockets, with no BroadcastChannel:

```
cd ../../services
APPS_RUST_ROOMS_BIN=/absolute/path/to/apps-runtime bun test tests/rooms_contract.test.ts
```

The suite covers bidirectional strokes, Unicode/rich text, binary map values,
late joins, offline seeding, cursor withdrawal, isolated rooms and malformed
frames/names. Production candidates must use an isolated network and synthetic
room names; never join an owner's board. Keep the `apps-rooms` name and PATH_PREFIX,
then restart only rooms. Browsers reconnect/resync their IndexedDB documents.
