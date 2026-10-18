# Weather API runtime

Rust 1.90.0 / Axum owns the HTTP listener, routing, coordinate/query validation,
admin authorization, CORS, gzip, minute/day quotas, OpenAPI, GeoNames search,
verification/GeoJSON files and persisted uint8 map slices. The public URLs and
weather payloads remain compatible with the previous API.

A single long-lived Python numerical worker retains NumPy/SciPy downscaling,
point explanations, forecast products, radar, cyclones, PM2.5 and push storage /
dispatch. This is a Rust HTTP migration, not a rewrite of the numerical model.
There is no FastAPI/Uvicorn server or dependency in the production image. The
small ASGI oracle lives under `backend/tests/oracle` and is installed only for
development/tests. gRPC is deferred; use HTTP/2 for that future work. Existing
Cloudflare HTTP/3 at the public edge is independent of the origin API runtime.

The Rust process supervises its Python child. A worker exit stops HTTP and fails
the container so Docker can restart both together. Graceful shutdown drains HTTP,
stops the worker and retains its writer lease until an active forecast finishes.
The IPC socket is mode 0600 in a private 0700 directory, with framed JSON metadata
and raw binary bodies. Operations are an explicit whitelist, with bounded sizes,
concurrency and timeouts; there is no public Python port or URL-forwarding proxy.

## Build and checks

```sh
cd backend
rustup toolchain install 1.90.0 --profile minimal --component rustfmt,clippy
cargo +1.90.0 fmt --manifest-path rust-api/Cargo.toml --check
cargo +1.90.0 clippy --locked --all-targets --manifest-path rust-api/Cargo.toml -- -D warnings
cargo +1.90.0 test --locked --manifest-path rust-api/Cargo.toml
cargo +1.90.0 build --locked --manifest-path rust-api/Cargo.toml
.venv/bin/ruff check app tests scripts verify
.venv/bin/ruff format --check app tests scripts verify
THWX_RUST_TEST_BIN="$PWD/rust-api/target/debug/thwx-api" .venv/bin/pytest -q
```

Python tests build a synthetic run in a temporary directory. Real Rust HTTP tests
and the Unix-socket test need local socket permissions. Without `THWX_RUST_TEST_BIN`,
the HTTP integration tests explicitly skip; that is not a successful migration
check. CI builds the binary and sets the variable. No test uses production data,
Open-Meteo, real push recipients, Dock chat or alert mail.

New Rust dependencies are exact pins with a committed lockfile; all 74 locked
registry crates were audited against crates.io's release timestamps on 2026-10-17.
Ten initially resolved transitive versions were downgraded to satisfy 14 days.
Run `python scripts/audit_rust_lock.py --added-on YYYY-MM-DD` after changing it.
The Dockerfile pins both upstream image digests. Python 3.12.15, its base layers
and the exact 33-package numerical dependency closure are retained from the
pre-migration production image, rather than introducing a Python/library update.

## Safe deployment

Use `HANDOFF.md` for the current branch, source revision and operational commands.
Hold `/run/apps-autodeploy.lock`, build `api`, and check a candidate with
`THWX_BACKGROUND_TASKS=false`, the data volume **read-only** and networking off.
This enforced mode creates no push service, external clients, writer lease or
forecast/polling threads. Merely setting `THWX_RUN_ON_STARTUP=false` is insufficient:
it delays a forecast but does not disable it.

Before switching, assert the old refresher is **idle** and its current real run was
created less than six hours ago. Otherwise stop and wait for the existing normal
run/retry to succeed: restarting a stale API would fetch a new forecast immediately.
Never `POST /runs` for a smoke test. Stop the old API before starting the new
background worker; the previous FastAPI image did not honor the new writer lease.
The fixed-name API uses a brief stop/start, unlike the web's rolling deployment.

Compare the candidate's persisted layers byte-for-byte and its point/province
products against the running API. Dynamic radar/air/push data is unavailable in a
serve-only candidate and is checked with isolated fixtures, then read-only after
cutover. Keep the exact previous image for rollback until public/API/Dock checks
pass. Do not remove an image still used by the Python verification container.

After cutover, confirm the same run ID/LATEST, a future scheduled first wait,
one numerical worker, Docker health and no import/permission/runtime errors.
Exercise the public Next rewrite in desktop Chromium and iPhone WebKit. Dock
selects the Rust mark only for the known API image with `com.chakkrit.stack=rust-python`;
the verification service retains its Python mark. Next/Bun/Elysia icons keep their
original 20px triangular composite footprint.
