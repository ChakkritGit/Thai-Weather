# Native app services

`apps-runtime health|media|analytics` runs one native service per container.
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
