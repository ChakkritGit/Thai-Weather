/**
 * The probes health.ts runs on the VPS for the status Worker: services on the Docker network that are not
 * public (whiteboard rooms, Party Play sync) and the bill reminders' heartbeat, read with its own secret.
 */
import { TIMEOUT_MS, httpCheck, pause } from './checks'
import type { FailureReason, Internal, Result } from './types'

/** The morning job runs daily; 26 hours leaves two hours of slack before it counts as missed. */
export const fresh = (iso: unknown, now = Date.now()) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(t) && t <= now + 5 * 60_000 && now - t <= 26 * 3600_000
}

export const remindersOk = async (r: Response): Promise<boolean | FailureReason> => {
  const body = await r.json().catch(() => null) as { lastRun?: unknown } | null
  if (!body || typeof body !== 'object' || !('lastRun' in body)) return 'invalid-response'
  return fresh(body.lastRun) ? true : 'heartbeat-stale'
}

/**
 * A room object answers a plain request with "ok" (whiteboard-rooms' /__health);
 * no answer means the Durable Object is stuck. Plain HTTP, not a socket: every
 * socket the probe opened and closed was counted against the room as an error.
 */
export async function roomsCheck(rooms: Internal, url: string): Promise<Result> {
  let t0 = Date.now()
  let ok = false
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    if (attempt) await pause()
    t0 = Date.now()
    try {
      const res = await rooms.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      ok = res.ok && (await res.text()).trim() === 'ok'
    } catch {
      ok = false
    }
  }
  return { id: 'rooms', ok, ms: Date.now() - t0 }
}

/** The sync container's /health, on the internal network. */
export async function musicSyncCheck(sync: Internal): Promise<Result> {
  let t0 = Date.now()
  let ok = false
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    if (attempt) await pause()
    t0 = Date.now()
    try {
      const response = await sync.fetch('https://drive-music-sync/health', { signal: AbortSignal.timeout(TIMEOUT_MS) })
      const body = await response.json() as { status?: unknown; service?: unknown; protocol?: unknown }
      ok = response.ok && body.status === 'ok' && body.service === 'drive-music-sync' && body.protocol === 2
    } catch {}
  }
  return { id: 'musicsync', ok, ms: Date.now() - t0 }
}

/** The reminders service answers {"health":true} with when its morning run last completed. */
export const remindersCheck = (url: string, secret: string) =>
  httpCheck(
    'reminders',
    url,
    { method: 'POST', headers: { 'x-status-secret': secret, 'content-type': 'application/json' }, body: '{"health":true}' },
    remindersOk,
    1, // The health read is safe to retry; no notifications are sent by this request.
  )
