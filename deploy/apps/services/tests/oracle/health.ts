/**
 * health.chakkritton.com – what the status Worker on Cloudflare cannot see from outside, in one answer.
 *
 * GET /health (x-probe-secret = PROBE_SECRET):
 *   containers – every Compose container's state and Docker health check, from the snapshot the host
 *                writes every 30 s (container-health.sh); this service has no Docker socket
 *   checks     – the services on the internal network: whiteboard rooms, Party Play sync, and the bill
 *                reminders' last morning run
 * POST /alert (x-probe-secret): the Worker's "X ล่ม" / "X กลับมาแล้ว", forwarded to Dock's chat.
 */
import { Elysia } from 'elysia'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { musicSyncCheck, remindersCheck, roomsCheck } from '../../src/status/internal'
import type { Container, HealthReport, Internal } from '../../src/status/types'

const PORT = Number(process.env.PORT ?? 8789)
const SNAPSHOT = process.env.CONTAINERS_FILE ?? '/host/containers.tsv'
const ROOMS_URL = process.env.ROOMS_URL ?? 'http://apps-rooms:8787'
const SYNC_URL = process.env.SYNC_URL ?? 'http://apps-sync:8788'
const REMINDERS_URL = process.env.REMINDERS_URL ?? 'http://apps-reminders:8792/'
const ALERT_URL = process.env.ALERT_URL ?? 'http://apps-chat:8795/chat/alert'

/** An internal service: the same request path, sent to its base URL on the Docker network. */
const binding = (base: string): Internal => ({
  fetch: (input, init) => {
    const u = new URL(input)
    return fetch(base + u.pathname + u.search, init)
  },
})

const sameSecret = (given: string, secret: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return secret.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The snapshot: a first line with the time it was written (epoch seconds), then
 * `name<TAB>state<TAB>status` per container. A rollout's number suffix (apps-expenses-17) is dropped.
 */
export function parseSnapshot(text: string): { at: number; containers: Container[] } {
  const [first = '', ...lines] = text.trim().split('\n')
  const at = Number(first) * 1000 || 0
  const containers = lines
    .map((l) => l.split('\t'))
    .filter((f) => f.length >= 3 && f[0])
    .map(([name, state, status]): Container => ({
      name: name.replace(/-\d+$/, ''),
      state,
      health: /\(unhealthy\)/.test(status) ? 'unhealthy' : /\(health: starting\)/.test(status) ? 'starting' : /\(healthy\)/.test(status) ? 'healthy' : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { at, containers }
}

export async function report(env = process.env): Promise<HealthReport> {
  const [snap, checks] = await Promise.all([
    readFile(SNAPSHOT, 'utf8').then(parseSnapshot, () => ({ at: 0, containers: [] })),
    Promise.all([
      roomsCheck(binding(ROOMS_URL), 'https://whiteboard-rooms/__health'),
      musicSyncCheck(binding(SYNC_URL)),
      remindersCheck(REMINDERS_URL, env.STATUS_SECRET ?? ''),
    ]),
  ])
  return { ...snap, checks }
}

export const app = new Elysia()
  .get('/health', async ({ headers, set }) => {
    if (!sameSecret(headers['x-probe-secret'] ?? '', process.env.PROBE_SECRET ?? '')) {
      set.status = 401
      return { error: 'unauthorized' }
    }
    set.headers['cache-control'] = 'no-store'
    return report()
  })
  .post('/alert', async ({ headers, body, set }) => {
    if (!sameSecret(headers['x-probe-secret'] ?? '', process.env.PROBE_SECRET ?? '')) {
      set.status = 401
      return { error: 'unauthorized' }
    }
    const r = await fetch(ALERT_URL, {
      method: 'POST',
      headers: { 'x-alert-secret': process.env.ALERT_SECRET ?? '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null)
    set.status = r?.status ?? 502
    return r ? r.json().catch(() => ({})) : { error: 'chat unreachable' }
  })
  // the container's own healthcheck
  .get('/ping', () => 'ok')

