# Standalone Bun services: Rust migration assessment

Requested by the owner on 2026-10-18, after the weather API migration. This is a
review and rollout order. Later that day the owner authorized implementation, starting
with `dock-metrics`, and paused the unrelated CPU investigation. Deployment status is in
`HANDOFF.md`; this document retains the baseline and compatibility requirements.
The five Next/Bun/Elysia web containers are excluded from the proposed rewrite.
gRPC remains deferred; preserve the current HTTP/JSON and WebSocket contracts.

## Next.js with Rust

The existing weather deployment already demonstrates the useful split: Next.js
renders on Bun, and a private Rust/Axum service provides the weather HTTP API.
The browser keeps one origin through the existing Next rewrite and proxy.

Next's standalone `server.js`, server components, server actions and route
handlers still require a JavaScript runtime. Rust can serve a separate API or
proxy to that runtime; replacing Bun with an ordinary Rust HTTP server does not
execute those Next server features. The Next custom-server documentation also
warns that custom servers and standalone output cannot be used together.
See [Next custom servers](https://nextjs.org/docs/app/guides/custom-server) and
[Bun's Next guide](https://bun.com/guides/ecosystem/nextjs).

Elysia currently runs inside Next route handlers via `app.fetch`; moving those
handlers into Rust adds a service boundary and requires equivalent validation,
session checks and response types. This is feasible when an API has substantial
work to move. A liveness response alone does not justify another process.
See [Elysia's Next integration](https://elysiajs.com/integrations/nextjs).

An alternative is Next static export, served by Rust. That requires a separate
design review: export does not support request-dependent handlers/cookies, ISR,
server actions or the default image optimizer. The current apps use these
features. Whiteboard's mostly client-side board is a possible smaller experiment,
but its routing, metadata and API routes still need an audit before promising a
static conversion. See [Next static exports](https://nextjs.org/docs/app/guides/static-exports).

Recommendation: retain Next + Bun + Elysia for rendering and app-owned handlers;
use Rust for standalone services and substantial backend work. Keep authentication
in its current owner until an isolated parity test demonstrates the replacement.

## The ten standalone Bun services

This inventory comes from `deploy/apps/docker-compose.yml`,
`deploy/docker-compose.yml`, `deploy/apps/services/src/` and Spent-Cost's
`reminders/`. Elysia-only services below are candidates; the owner's exception is
the combined Next/Bun/Elysia web runtime. The status page and Scrolly AI are
Cloudflare Workers, not VPS Bun processes, and are outside this assessment.

| Order | Service | Required compatibility and evidence |
| --- | --- | --- |
| 1 | `dock-metrics` | Preserve `/metrics`, persisted history, bucket timestamps, gaps, NPM log parsing, container identity and cgroup CPU/memory accounting. Replay sanitized log and `/proc` fixtures, then run a read-only candidate against the same host views with separate history. Useful first pilot because it runs continuously and sends no notifications. |
| 2 | `health` | Preserve probe-secret checks, container snapshot freshness, dependency health, the exact status Worker JSON and authenticated `/alert` forwarding. A failed dependency must remain distinguishable from a failed host. Compare against fake dependencies and a fake alert sink before an internal candidate; never send a test alert to Dock. |
| 3 | `analytics` | Reuse the SQLite schema/WAL files, Bangkok day boundaries, daily visitor salt, bot filtering, retention and all Dock aggregates. Compare fixed-clock fixture databases; never write test page views to production analytics. |
| 4 | `media` | Preserve existing paths/UUIDs, MIME/cache headers, authenticated internal upload/delete, path validation, 20 MiB limits and atomic writes. Use a temporary media directory for mutation tests; production comparison is GET-only. |
| 5 | `dbgw` | Preserve ES256/JWKS session verification, issuer/audience/expiry, local HS256 tokens, anon/authenticated/service roles, RLS claims, first-user profile creation and PostgREST forwarding. Test synthetic users/keys and a disposable database; do not switch on a health-only test. |
| 6 | `backup` | Keep encrypted bundle layout, AES-256-CBC/PBKDF2 parameters, checksums, restore script, volume exclusions, job serialization and expiring download links. Most work remains in external archive/database/encryption tools. Verify a full restore into temporary resources before cutover. |
| 7 | Drive Music `sync` | Port the vendored `SyncServer` behavior and SQLite `kv`/alarm format, not just the WebSocket adapter. Preserve JWT room binding, per-room event serialization, reconnect/device identity and all Party Play protocol messages. Cross-test real JS clients with synthetic rooms; reconnecting clients must retain state. |
| 8 | Whiteboard `rooms` | Preserve Yjs sync/awareness binary framing, Unicode room paths, cursor removal, empty-room cleanup and malformed-frame close behavior. Audit a Rust CRDT implementation and cross-test with the existing Yjs client before accepting it. No test joins an owner's real board. |
| 9 | `chat` | Preserve SQLite messages/read markers, VAPID keys/subscriptions, push encryption, digest/report scheduling, auth boundaries and UI responses. Use fake push senders and fixture reports; a candidate must have all outbound jobs disabled. No production chat post or test push. |
| 10 | Spent-Cost `reminders` | Preserve Bangkok scheduling, service-role boundaries, delivery claims/receipts, uncertain outcomes, retry rules and the read-only status secret. Reuse the existing database receipts to prevent duplicates across cutover. Test fake recipients and a disposable database; no manual production reminder run. |

`sync` uses both a TypeScript party state machine and `partyserver.ts`; `rooms`
uses the Yjs/y-protocols/lib0 implementation. These two require protocol-level
cross-language tests. A matching HTTP health response proves little about them.

## How to decide whether each port is worthwhile

On 2026-10-18, a read-only 20-second production sample found
standalone Bun services at **0.13–0.34% of one CPU**. Sampled cgroup working memory
was about **8–22 MiB** each, except metrics at **65.8 MiB**; several also had
swapped-out pages. These are short, mostly idle observations, not load benchmarks.
Shared image/code pages and their cgroup charge complicate adding per-container
figures; these values are not a promise of how much RAM Rust would save.

Record the current service's idle CPU, cgroup working memory and swap, plus
representative request latency/CPU and, for sockets, room/connection behavior.
Use identical data and workloads for Bun and Rust candidates, with alternating
measurement order and enough warm-up. Separate idle overhead from request work,
external API/database latency and process-start costs. Rust's lack of a JS heap
may reduce per-process memory, but the actual saving and user-visible speed need
measurement; backup subprocesses or remote API waits will not disappear.

Reuse the weather API's pinned Rust/Axum/Tokio baseline where appropriate. Audit
every new dependency and transitive resolution against the exact-version and
14-day rules. Keep processes, volumes, network exposure, resource limits and
permissions separate even if their binaries share a Rust workspace/image.
Do not combine background jobs into one process merely to reduce container count.

Before each rollout, require fixture/contract tests, a candidate outside public
routing, a concrete rollback image and verified persistent-data compatibility.
Disable outbound jobs in all test candidates. Stateful writers and scheduled
notification workers must have one owner during the switch; do not run old and
new writers together. Keep Dock's marks tied to actual deployed image labels.

The first implementation, **dock-metrics**, was deployed on 2026-10-18 after
fixture, live-history and isolated shadow checks. See `HANDOFF.md` for the image,
backup, retained-history and browser verification record. Native **health, media and analytics** were also deployed and verified on 2026-10-18, after
HTTP fixtures, read-only candidate comparisons and persistent-data checks. The native database gateway was also deployed and verified on 2026-10-19. Native backup was deployed and verified on 2026-10-19 as well. Native rooms was also deployed after Yjs interoperability tests. Three standalone services
remain: sync, chat and reminders; sync is being implemented. Evaluate each
persistent-data and protocol contract before switching. No new
transport, DNS, Cloudflare setting, database schema or notification behavior is
needed for this pilot.
