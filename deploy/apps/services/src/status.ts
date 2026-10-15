/**
 * status.chakkritton.com – replaces the `status` Worker (5-minute cron + KV).
 *
 * The checks, the up/down state machine and the page are in ./status (moved here from the portfolio repo,
 * where they ran as a Worker). The state is a JSON file (written atomically), the run is a timer aligned to
 * every fifth minute, and rooms / sync are probed on the internal network.
 */
import { Elysia } from 'elysia'
import { rename, readFile, writeFile } from 'node:fs/promises'
import { CHECKS, runChecks } from './status/checks'
import { handle } from './status/page'
import { apply, emptyState } from './status/state'
import type { State } from './status/types'

const PORT = Number(process.env.PORT ?? 8789)
const STATE_FILE = process.env.STATUS_STATE ?? '/data/status.json'
const ROOMS_URL = process.env.ROOMS_URL ?? 'http://apps-rooms:8787'
const SYNC_URL = process.env.SYNC_URL ?? 'http://apps-sync:8788'
const STEP = 5 * 60_000

/** An internal service: the same request path, sent to its base URL on the Docker network. */
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
  // down / back-up alerts go to Dock's chat (a message + a push to the devices subscribed there)
  ALERT_URL: process.env.ALERT_URL ?? 'http://apps-chat:8795/chat/alert',
  ALERT_SECRET: process.env.ALERT_SECRET ?? '',
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
  const results = await runChecks(e, scheduledTime)
  const out = apply(state, results, Date.now())
  state = out.state
  await save(file)
  for (const a of out.alerts) {
    const name = nameOf(a.id)
    const alert = a.kind === 'down' ? { title: `${name} ล่ม`, body: 'เข้าไม่ได้ติดกันเกิน 5 นาที' } : { title: `${name} กลับมาแล้ว`, body: `ล่มไปประมาณ ${a.minutes} นาที` }
    // the state is saved already, so a failed alert is logged and never thrown
    try {
      const r = await fetch(e.ALERT_URL, {
        method: 'POST',
        headers: { 'x-alert-secret': e.ALERT_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ alert: { ...alert, id: a.id, kind: a.kind } }),
        signal: AbortSignal.timeout(20_000),
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
