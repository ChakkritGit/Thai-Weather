# Agent notes

Start with **HANDOFF.md** (current state, how to deploy, rules, open work). It is kept up to date; older
notes in `docs/` may be stale.

- Reply to the owner in Thai; code, commits and docs in English.
- Work is pre-approved: test, commit, push and deploy. Ask before deleting DNS records, certificates or cloud
  projects, changing the VPS plan or Cloudflare security settings, or anything that messages real people.
- This repository is public: no secrets, no e-mail addresses, no `.env` files, no `.wrangler/`.
- Pin new dependencies and images exactly, at versions at least 14 days old. New services: Bun + Elysia.
- Never trigger extra forecast runs (Open-Meteo quota). Tests must not post to Dock chat or send pushes/e-mails.
- One SSH connection per batch of commands (`ssh vps`; ufw allows 6 per 30 s).
- Frontend: `frontend/AGENTS.md` (Next.js 16 — read its docs before writing Next code).
