# Self-hosted apps (moved off Vercel and Cloudflare Workers)

| Service | What | Public at | Was |
|---|---|---|---|
| `portfolio` | Next.js (repo WebProfile) | chakkritton.com, www | Vercel `web-profile` |
| `expenses` | Next.js (repo Spent-Cost) | expenses.chakkritton.com | Vercel `spent-cost` |
| `whiteboard` | Next.js (repo Whiteboard) | whiteboard.chakkritton.com | Vercel `whiteboard` |
| `rooms` | Bun + Elysia, Yjs relay | whiteboard.chakkritton.com/rooms/ | Worker `whiteboard-rooms` |
| `drive-music` | Next.js (repo Drive-Music-Web) | drive-music.chakkritton.com | Vercel `drive-music` |
| `sync` | Bun + Elysia, Party Play (runs the repo's own `SyncServer` on a partyserver shim, SQLite storage) | drive-music.chakkritton.com/parties/ | Worker `drive-music-sync` |
| `status` | Bun + Elysia, checks every 5 min | status.chakkritton.com | Worker `status` (cron + KV) |
| `analytics` | Bun + Elysia, page views + Web Vitals | every site's `/_a`, read in Dock ("สถิติเว็บ") | Vercel Analytics + Speed Insights |

Stays on Cloudflare: the AI worker `mr-worldwide` (route `chakkritton.com/api/assistant*`, Workers AI).
Supabase (database + login) is unchanged for now.

## Layout on the VPS

- `/opt/apps/repos/<app>`: clones of the app repos (main branch)
- `/opt/apps/env/<app>.env`, `sync.env`, `status.env`: secrets, mode 600, not in git
- this folder: `docker-compose.yml` (runs everything), `build.sh` (builds one image),
  `autodeploy.sh` + `apps-autodeploy.timer` (auto-deploy on push, every 2 min)

```sh
./build.sh portfolio && docker compose up -d portfolio   # one app by hand
./autodeploy.sh --force drive-music                      # rebuild even without a new commit
journalctl -u apps-autodeploy -n 50                      # what the timer did
```

`next.Dockerfile` builds any of the apps without touching its repo (it wraps `next.config.ts` to add
`output: 'standalone'`). The env file is mounted only during `next build`, because `NEXT_PUBLIC_*` values are
inlined there, and never lands in an image layer.

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
