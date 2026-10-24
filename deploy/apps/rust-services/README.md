# Standalone Rust services

The owner authorized replacing standalone Bun services on 2026-10-18. The first
binary is `dock-metrics`: Axum HTTP, native host/cgroup/log readers, gzip history
and the existing Dock JSON contract. Next keeps Bun for SSR/auth/server actions;
its former Elysia APIs now use native Rust. gRPC remains deferred. See `HANDOFF.md` for rollout status and
`docs/RUST-SERVICES-REVIEW-2026-10-18.md` for the remaining service inventory.

## Build and test

Use Rust **1.90.0**. Every direct dependency is exact; all 63 locked registry
versions are a subset of the weather API lock audited on 2026-10-17, plus `sha2` 0.10.9
and its dependencies at the native runtime's versions (audited again 2026-10-24). Re-audit
release ages and yanks before adding/updating any dependency. No new image base:
the compiler uses the weather API's pinned Rust/bookworm digest. The runtime is
a static x86-64 Linux binary in `scratch`, with no JS runtime or shell.

```sh
cd deploy/apps/rust-services
cargo +1.90.0 fmt --check
cargo +1.90.0 clippy --locked --all-targets -- -D warnings
cargo +1.90.0 test --locked
cargo +1.90.0 build --locked
python3 tests/http_contract.py
python3 tests/memory_regression.py
python3 ../../../backend/scripts/audit_rust_lock.py --added-on YYYY-MM-DD --lock Cargo.lock
```

The HTTP tests launch localhost processes against temporary synthetic files.
They cover gzip/status/query compatibility, serve-only immutability, health,
SIGTERM save, history resume and the single-writer lease. No production analytics,
chat, push, mail or forecast job is invoked. The Bun golden fixture was generated
from the frozen test-only oracle in `../services/tests/oracle/metrics.ts`:

```sh
bun tests/generate-oracle.ts
```

Do not regenerate it to make a Rust test pass. Deliberately review changes to
counter sums, gauge averaging, missing buckets, 10/60/600-second steps, timestamps,
log offsets and path/client privacy against the legacy contract first.

## Operations

`dock-metrics` retains the old service name, port 9100, internal `dock` network,
root UID, read-only `/host/proc`, `/host/cgroup`, hostname, os-release and NPM logs.
It has no Docker socket or capabilities. Portainer login remains enforced by
Dock's nginx; the collector has no public port. The existing named volume
`thai-weather_dock-metrics` holds `history.json.gz`; never delete it as cleanup.

Host/config environment variables remain `HOST_PROC`, `HOST_CGROUP`, `HOST_FILE`,
`NPM_LOGS`, `DATA_DIR`, `PORT`. Defaults match the previous collector. `/metrics`
accepts `range=1h|24h|7d` and always serves gzip JSON with `Cache-Control: no-store`.
`/healthz` and `--healthcheck` are cheap process liveness checks.

Normal startup loads the same gzip JSON (`hist` and `logpos`), resumes complete
log-line offsets, samples every five seconds, and atomically saves every five
minutes and at graceful shutdown. The persisted counter/gauge buckets need no
migration. Top paths and hashed-client sets remain memory-only, as before, and
restart from new log lines after a saved-history load. Log contents/client IPs
are never persisted in the history file. A nonblocking `collector.lock` lease
prevents two Rust writers from owning one data directory.

History load decodes gzip directly into buckets; saves borrow the retained history
and stream JSON through a fixed 64 KiB buffer into gzip and an atomic file rename.
Metrics responses serialize typed columns directly into gzip, with one active
serializer and asynchronous waiting requests, so concurrent requests cannot retain
multiple JSON trees/raw JSON buffers. Log backfill applies each tier's retention
before allocating buckets. The JSON/gzip contract and persisted format are unchanged.

`tests/memory_regression.py` uses synthetic history with all 2,808 retained buckets,
206 columns (24 containers and ten nginx hosts), 16 concurrent requests, normal
sampling and shutdown save. It samples the child process RSS with `ps` on macOS
or Linux and defaults to a 128 MiB regression budget; this is a test threshold,
not a runtime limit. Use `--binary PATH`, `--requests N`, or `--max-rss-mib N`
to compare candidates. It requires localhost socket permission, accesses no real
logs/host metrics, and does not notify anyone or request a forecast.

For a candidate set **`METRICS_SERVE_ONLY=true`**, mount copied history **read-only**
and use no public routing/network. This mode performs no periodic sampling,
history save or writer-lock creation. `METRICS_FIXED_NOW` is a finite epoch clock
allowed only in serve-only mode, for deterministic contract comparisons. A real
shadow sampler instead needs its own writable temporary directory; never give
it the production history volume.

Build on the amd64 VPS without restarting other services:

```sh
cd /opt/thai-weather/deploy
docker compose -f docker-compose.yml -f docker-compose.build.yml build dock-metrics
```

Before first cutover, compare all three ranges against the old Bun reader using
one copied history and a fixed clock, then verify a shadow sampler with separate
data. Hold `/run/apps-autodeploy.lock`, stop only the old metrics container and
wait for its final save, back up the saved gzip, then start Rust on the existing
volume. The old Bun collector does not honor the Rust writer lease: do not run
both against the real volume. Check health, old bucket preservation, resumed log
offsets, new live samples and Dock's charts/icon. Keep a concrete rollback image
until these pass; restore only this service if necessary. App autodeploy must no
longer restart native services when an app repo changes.

### Security watch

`src/security.rs` feeds Dock's ความปลอดภัย page (`GET /security`, `POST /security/ack`, both
behind Portainer login in Dock's nginx) and apps-chat's alert relay (`GET /security/outbox?after=N`,
dock-internal only). It reads, through read-only mounts under `SECURITY_HOST` (default `/host`):
`log/auth.log` (SSH logins, failed attempts, account changes; the container joins group `adm`),
NPM's access logs (Dock/Portainer/NPM logins and NPM config changes, bot probes, the 415 guard),
34 watched files and directories under `etc/`, `root/` and `cron/` (SHA-256, plus user names and key
fingerprints for passwd/group/authorized_keys; root's SSH keys, `~/.ssh/rc` and shell startup files,
`/etc/ssh/sshrc`, `/etc/update-motd.d`), `/proc/1/net/tcp*` (public listeners),
`containers/*/config.v2.json` + `hostconfig.json` (new containers, privileged/socket/host-namespace
flags), `apt/updates-available` + `boot/` (pending updates, reboot needed) and `scan/images.json`
(the nightly Trivy summary from `deploy/hardening/dock-image-scan.py`: one event per scan for new
fixable CRITICAL/HIGH findings, keyed by image name; a scan older than two days colours the category).

State is `DATA_DIR/security.json` (atomic rename; offsets, known /24 or /64 networks and SSH keys,
file hashes, the watch entries already learned, the last scan's fixable findings, last 200 events).
The first run, without that file, learns everything already present silently; only later changes
become events. A watch entry added in a later version is learned silently the same way. Delete the file to re-learn (apps-chat re-anchors when
the event ids restart). Serve-only mode disables the watch and answers `{"enabled":false}`.

Clean up exact unused images/volumes after checking **all** container references
(including stopped containers) and current Compose declarations. Never delete a
history/database/uploads/cache volume just because a disposable test is stopped.


## Native app runtime

`runtime/` is a separate Cargo package with eleven roles: `health`, `media`,
`analytics`, `dbgw`, `backup`, `rooms`, `sync`, `chat`, `reminders`,
`portfolio-api` and `weather-web-api`.
Together with `dock-metrics`, this replaces all ten standalone VPS Bun services.
The five Next runtimes use Bun with native Rust APIs (see `runtime/README.md`).
The Cloudflare status Worker retains its off-VPS stack.

Build with `deploy/apps/build.sh rust` on the VPS. Only restart the changed role;
`backup` additionally needs `build.sh backup` for its pinned tool image. Native
services deploy from this repository, independently of app-repo autodeploy.

Run `cargo +1.90.0 fmt --check`, strict Clippy, `test --locked`, `build --locked`,
and the three Python contracts in `runtime/tests/`. The JavaScript contracts in
`../services/tests/` cross-test native Yjs/Party Play, Dock reports/Web Push and
reminder receipts. Set `APPS_RUST_{ROOMS,SYNC,CHAT,REMINDERS}_BIN` to the built binary.
These tests use synthetic accounts, temporary SQLite and fake HTTP/TLS services.
Web Push is decrypted and its VAPID signature verified by browser WebCrypto;
Rust also checks the RFC 8291 Appendix A vector byte for byte.

Candidates: `CHAT_READ_ONLY=true` also disables chat writes and schedules;
`CHAT_JOBS_DISABLED=true` disables scheduled digest/report work.
`REMINDERS_JOBS_DISABLED=true` disables both scheduled and manual cron execution,
while authenticated status probes remain read-only. `REMINDERS_SCHEDULE_DISABLED=true`
is manual-cron-only mode. `PUSH_OUTBOUND_DISABLED=true` refuses outbound push.
Push HTTP clients reject redirects; optional `SSL_CERT_FILE` adds a private CA
without turning off normal TLS certificate verification.

Before a stateful switch, stop its previous writer and take a consistent SQLite
backup. Keep the original named data volumes, VAPID keys and subscriptions.
Reminder receipt claims must be committed before attempting a push; unknown
transport results and lost finish acknowledgements remain unresolved and must
never cause automatic redelivery. Only PostgREST's explicit pre-SQL JWT clock
rejection is eligible for a replay. Test candidates must never run a real cron,
post an owner's chat message, send a push or trigger a forecast.
