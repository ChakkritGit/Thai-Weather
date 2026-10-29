# Self-hosted apps (moved off Vercel and Cloudflare Workers)

| Service | What | Public at | Was |
|---|---|---|---|
| `portfolio` | Next.js (repo WebProfile) | chakkritton.com, www | Vercel `web-profile` |
| `expenses` | Next.js (repo Spent-Cost) | expenses.chakkritton.com | Vercel `spent-cost` |
| `whiteboard` | Next.js (repo Whiteboard) | whiteboard.chakkritton.com | Vercel `whiteboard` |
| `rooms` | Rust/Yrs, Yjs relay | whiteboard.chakkritton.com/rooms/ | Worker `whiteboard-rooms` |
| `drive-music` | Next.js (repo Drive-Music-Web) | drive-music.chakkritton.com | Vercel `drive-music` |
| `calorieflow` | Next.js (repo CalorieFlowWeb), own database + passkeys, in-process push scheduler | calorieflow.chakkritton.com | Firebase Hosting (IndexedDB only) |
| `calorieflow-api` | Rust (CalorieFlowWeb `api/`): JSON API on the same database, for the native app and the web app | calorieflow.chakkritton.com/api/v1/ | (new) |
| `sync` | Rust, Party Play protocol 2 (native state machine, SQLite storage) | drive-music.chakkritton.com/parties/ | Worker `drive-music-sync` |
| `health` | Rust: every container's Docker health (host snapshot every 30 s) + the internal checks, for the status Worker; relays its alerts to Dock | health.chakkritton.com (needs `x-probe-secret`) | – |
| `analytics` | Rust, page views + Web Vitals | every site's `/_a`, read in Dock ("สถิติเว็บ") | Vercel Analytics + Speed Insights |

| `db` | Postgres 17 (`expenses`, `portfolio`, `calorieflow`) | internal only | Supabase databases |
| `rest` + `dbgw` | PostgREST behind a Rust gateway that checks Supabase Auth sessions | expenses.chakkritton.com/data/ | Supabase `/rest/v1` |
| `reminders` | Rust, Spent-Cost bill reminders (daily delivery receipts, scheduled in Bangkok) | internal | Edge Function `push-reminders` + pg_cron |
| `media` | Rust, portfolio uploads | chakkritton.com/media/ | Supabase Storage bucket |
| `backup` | Rust + pinned native tools, whole-server backup bundles | Dock → เพิ่มเติม → สำรองข้อมูล | – |
| `chat` | Rust: monthly server report (last evening of the month), commands, optional LLM, Web Push | Dock → เพิ่มเติม → แชท | – |

Stays elsewhere: the AI workers on Cloudflare, `mr-worldwide` (route `chakkritton.com/api/assistant*`) and
`calorieflow-ai` (route `calorieflow.chakkritton.com/ai/*`, in the CalorieFlowWeb repo), both Workers AI, and
**login for Spent-Cost on Supabase Auth** (project `yavhirzrepgpvvapohyz`, now auth only).

## Database

Roles mirror Supabase's (anon / authenticated / service_role / authenticator), created by `db/init.sh`
on first start. The expenses schema is `db/schema.sql` in the expenses repo. `dbgw` verifies a Supabase
session against the project's JWKS and re-signs it for PostgREST, so RLS (`auth.uid()`) works unchanged.
Nightly dumps: `apps-db-backup.timer` → `/opt/apps/backups/<db>-<date>.dump` (14 days).

## Backups and restore

Dock → สำรอง makes `chakkritton-server-backup-<date>.zip`: `restore.sh`, `README.txt`, and `payload.enc`
(AES-256 with the passphrase typed in Dock) with both databases, every Docker volume except caches,
the env files, the Origin certificate and each repo's commit. `restore.sh --check` verifies a bundle;
`restore.sh` puts this server, or a fresh Ubuntu 24.04 one, back to it (auto-deploy is left off after).

## Layout on the VPS

- `/opt/apps/repos/<app>`: clones of the app repos (main branch)
- `/opt/apps/env/<app>.env`, `sync.env`, `health.env`: secrets, mode 600, not in git
- this folder: `docker-compose.yml` (runs everything), `build.sh` (builds one image),
  `autodeploy.sh` + `apps-autodeploy.timer` (auto-deploy on push, every 2 min)

```sh
./build.sh portfolio && ../rollout.sh portfolio          # one app by hand, without downtime
./autodeploy.sh --force drive-music                      # rebuild even without a new commit
journalctl -u apps-autodeploy -n 50                      # what the timer did
```

**No downtime on deploy:** the four Next apps (and the weather site's `web`) have no `container_name`;
`../rollout.sh <service>` starts the new container next to the old one, waits for its healthcheck, gives
NPM 12 s to re-resolve the shared alias (`apps-<app>`), then stops the old one. NPM's 2 s connect timeout
(`deploy/hardening/npm-server_proxy.conf`) moves a request off a stopped container at once.

**Next builds reach the database:** `build.sh` runs `next build` on the host network with `apps-db`,
`apps-dbgw` and `apps-media` mapped to the running containers, so ISR pages (portfolio) are not
pre-rendered empty.

**Chat (`chat.env`, optional):** `LLM_PROVIDER=cloudflare` + `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_AI_MODEL`, or
`LLM_PROVIDER=openai` + `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (any OpenAI-compatible server, e.g. Ollama).
Without them it answers commands only (สรุป, เดือนก่อน, ช่วย). Its VAPID key lives in its own database.

`next.Dockerfile` builds any of the apps without touching its repo (it wraps `next.config.ts` to add
`output: 'standalone'`). The env file is mounted only during `next build`, because `NEXT_PUBLIC_*` values are
inlined there, and never lands in an image layer.

The four Next standalone servers run on **Bun 1.4.2** (`--target bun`); the pinned Node build stage
still compiles the apps. Elysia 1.4.30 handles app-owned APIs, alongside Next's existing auth and
server actions. Whiteboard rooms, Party Play, reminders and the other standalone services run as native Rust.
All Next containers use `init: true` to forward shutdown signals and poll `/api/healthz` every 30 s;
that probe does not render a page, query data, refresh a session or send a notification.

The runtime image creates `.next/cache/images` as UID/GID 1000 before Docker seeds a new named cache
volume. When adopting an existing root-owned cache volume, repair that volume's ownership to
1000:1000 once before rolling out; image permissions cannot override an existing mounted directory.
Next's disk-cache initialization memoizes failures, so an already running process needs a rolling
restart after the repair. Never make the directory world-writable. The explicit `node` build target
is retained for runtime comparisons or recovery.

## Cutover (done 2026-10-15)

1. Certificate: key + CSR on the VPS (`/root/origin-ca`), signed as a Cloudflare Origin CA cert for
   `chakkritton.com` + `*.chakkritton.com`, then `python3 upload-origin-cert.py < creds`.
2. Proxy hosts: `python3 npm-hosts.py < creds` (creates or updates them; adds `/_a` to thai-weather too).
3. Test from the VPS before DNS: `curl -k --resolve expenses.chakkritton.com:443:127.0.0.1 https://expenses.chakkritton.com/api/health`.
4. Status state: rebuilt from the live status page (services, incidents, the 90 daily bars; the CLI token
   cannot read KV) into the `status-data` volume as `/data/status.json`.
5. DNS (all **proxied**): `chakkritton.com`, `www`, `expenses`, `whiteboard`, `drive-music` → A `117.18.127.246`;
   `status`: remove the Worker custom domain, then A `117.18.127.246`.
6. Secrets used by status: set the new `STATUS_SECRET` (from `/opt/apps/env/status.env`) on Supabase
   (`supabase secrets set --project-ref yavhirzrepgpvvapohyz`), and the new `HEALTH_TOKEN` on the `mr-worldwide` Worker.
7. Retire the old side (Vercel projects, the three Workers, the KV namespace).

Done on 2026-10-15, and on request the old side was removed the same day (no week of overlap): the Vercel
projects `web-profile`, `spent-cost`, `whiteboard`, `drive-music` and the domain entry on Vercel, the Workers
`status`, `whiteboard-rooms`, `drive-music-sync` and the status KV namespace. There is no rollback to them;
recovery means redeploying from the repos (they still hold the Vercel/Wrangler setup).
The cert is NPM certificate "Cloudflare Origin CA *.chakkritton.com" (valid to 2041; key in `/root/origin-ca`).

## Status page (back on Cloudflare since 2026-10-16)

status.chakkritton.com runs as the Worker `status` (`../status-worker/wrangler.toml`, code in
`services/src/status/`): a 5-minute cron that probes the public sites, reads `health.chakkritton.com/health`
for the containers and the internal services, keeps its state in KV and serves the page. It ran on this
VPS for a day, which meant a VPS that was down or rebooting showed nothing and alerted no one.
Alerts go to Dock through the health service; when that cannot be reached they are e-mailed (Email
Routing on chakkritton.com, from status@chakkritton.com to the account's verified address).
The container snapshot comes from `container-health.sh` (`apps-container-health.timer`, every 30 s).
Deploy the Worker with `npx wrangler@4.144.0 deploy` from `../status-worker`.
