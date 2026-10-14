/**
 * status.chakkritton.com – replaces the `status` Worker (5-minute cron + KV).
 *
 * Runs the Worker's own checks / state machine / page (vendored by scripts/vendor-status.sh). What was
 * Cloudflare-specific is swapped here: the KV value is a JSON file (written atomically), the cron is a
 * timer aligned to every fifth minute, and the ROOMS / MUSIC_SYNC service bindings are plain fetches to
 * the rooms and sync containers on the internal network.
 */
import { Elysia } from 'elysia'
import { rename, readFile, writeFile } from 'node:fs/promises'
import { CHECKS, runChecks } from './vendor/status/checks'
import { handle } from './vendor/status/page'
import { apply, emptyState } from './vendor/status/state'
import type { State } from './vendor/status/types'

const PORT = Number(process.env.PORT ?? 8789)
const STATE_FILE = process.env.STATUS_STATE ?? '/data/status.json'
const ROOMS_URL = process.env.ROOMS_URL ?? 'http://apps-rooms:8787'
const SYNC_URL = process.env.SYNC_URL ?? 'http://apps-sync:8788'
const STEP = 5 * 60_000

/** A service binding stand-in: same request path, sent to an internal base URL. */
const binding = (base: string) => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    return fetch(base + u.pathname + u.search, init)
  },
})

const env = {
  STATUS_SECRET: process.env.STATUS_SECRET ?? '',
  HEALTH_TOKEN: process.env.HEALTH_TOKEN ?? '',
  SUPABASE_FUNCTION_URL: process.env.SUPABASE_FUNCTION_URL ?? 'https://yavhirzrepgpvvapohyz.supabase.co/functions/v1/push-reminders',
  ROOMS: binding(ROOMS_URL),
  MUSIC_SYNC: binding(SYNC_URL),
}

let state: State = emptyState()
const nameOf = (id: string) => CHECKS.find((c) => c.id === id)?.name ?? id

export async function load(file = STATE_FILE) {
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as State
  } catch {
    state = emptyState()
  }
  return state
}

async function save(file = STATE_FILE) {
  await writeFile(file + '.tmp', JSON.stringify(state))
  await rename(file + '.tmp', file)
}

/** One scheduled run, as the Worker's `scheduled` handler did it. */
export async function tick(scheduledTime: number, e: typeof env = env, file = STATE_FILE) {
  const results = await runChecks(e as never, scheduledTime)
  const out = apply(state, results, Date.now())
  state = out.state
  await save(file)
  for (const a of out.alerts) {
    const name = nameOf(a.id)
    const alert = a.kind === 'down' ? { title: `${name} ล่ม`, body: 'เข้าไม่ได้ติดกันเกิน 5 นาที' } : { title: `${name} กลับมาแล้ว`, body: `ล่มไปประมาณ ${a.minutes} นาที` }
    // the state is saved already, so a failed alert is logged and never thrown
    try {
      const r = await fetch(e.SUPABASE_FUNCTION_URL, {
        method: 'POST',
        headers: { 'x-status-secret': e.STATUS_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ alert }),
      })
      if (!r.ok) console.error('alert failed', a.id, r.status)
    } catch (err) {
      console.error('alert failed', a.id, (err as Error).message)
    }
  }
  return out
}

export const app = new Elysia().all('/*', ({ request }) => handle(request, state, Date.now()))

/** Every fifth wall-clock minute, like `*\/5 * * * *`. */
function schedule() {
  const next = Math.ceil((Date.now() + 1) / STEP) * STEP
  setTimeout(async () => {
    try {
      await tick(next)
    } catch (err) {
      console.error('run failed', (err as Error).message)
    }
    schedule()
  }, next - Date.now())
}

if (import.meta.main) {
  await load()
  app.listen({ port: PORT, hostname: '0.0.0.0' })
  console.log(`status listening on :${PORT}, last run ${state.lastRun ? new Date(state.lastRun).toISOString() : 'never'}`)
  schedule()
}
