# Native app services

`apps-runtime health|media|analytics|dbgw|backup|rooms` runs one native service per container.
The image has no JavaScript runtime. The five Next/Bun/Elysia web apps stay.
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
python3 tests/backup_contract.py
python3 ../../../../backend/scripts/audit_rust_lock.py --added-on 2026-10-18 --lock Cargo.lock
```

HTTP fixture writes and alerts use temporary directories and fake local servers.
Never test real alerts, chat, notifications or production uploads.

## Deployment

From `deploy/apps`, `./build.sh rust` builds `apps-rust:local`: static glibc,
exact Rust builder digest, UID/GID 1000, no shell or Bun. Compose supplies init,
limits, read-only root filesystems and `/apps-runtime <service> --healthcheck`.

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
