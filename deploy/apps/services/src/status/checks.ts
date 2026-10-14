import type { CheckId, Env, Internal, Result, FailureReason } from './types'

export const CHECKS: { id: CheckId; group: 'portfolio' | 'spentcost' | 'whiteboard' | 'drivemusic'; name: string; hourly?: true }[] = [
  { id: 'portfolio', group: 'portfolio', name: 'Portfolio' },
  { id: 'assistant', group: 'portfolio', name: 'Scrolly' },
  { id: 'ai', group: 'portfolio', name: 'Scrolly AI', hourly: true },
  { id: 'expenses', group: 'spentcost', name: 'Spent-Cost' },
  { id: 'reminders', group: 'spentcost', name: 'ระบบแจ้งเตือนบิล' },
  { id: 'whiteboard', group: 'whiteboard', name: 'Whiteboard' },
  { id: 'rooms', group: 'whiteboard', name: 'ห้อง Whiteboard' },
  { id: 'music', group: 'drivemusic', name: 'Drive Music' },
  { id: 'musicsync', group: 'drivemusic', name: 'Party Play sync' },
  { id: 'musicauth', group: 'drivemusic', name: 'ล็อกอิน Google ของ Drive Music' },
]

const TIMEOUT_MS = 10_000

/** Preserve the actual elapsed time and a safe failure category for diagnostics.
 * Only read-only probes opt into one retry for a transient transport failure. */
export async function httpCheck(id: CheckId, url: string, init: RequestInit, isOk: (res: Response) => Promise<boolean | FailureReason>, retries = 0): Promise<Result> {
  const t0 = Date.now()
  let result: Result = { id, ok: false, ms: 0 }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) {
        result = { id, ok: false, ms: 0, reason: 'http-error', httpStatus: response.status }
      } else {
        const verdict = await isOk(response)
        result = { id, ok: verdict === true, ms: 0, ...(verdict === true ? {} : { reason: verdict === false ? 'unhealthy' : verdict }) }
      }
    } catch (error) {
      const name = (error as { name?: string } | null)?.name
      result = { id, ok: false, ms: 0, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
    }
    const transient = result.reason === 'timeout' || result.reason === 'network' ||
      (result.reason === 'http-error' && [502, 503, 504].includes(result.httpStatus ?? 0))
    if (result.ok || !transient) break
  }
  return { ...result, ms: Date.now() - t0 }
}

export const jsonOk = async (r: Response) => r.ok && ((await r.json().catch(() => ({}))) as { ok?: unknown }).ok === true

/** The morning job runs daily; 26 hours leaves two hours of slack before it counts as missed. */
export const fresh = (iso: unknown, now = Date.now()) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(t) && t <= now + 5 * 60_000 && now - t <= 26 * 3600_000
}

const remindersOk = async (r: Response): Promise<boolean | FailureReason> => {
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
  const t0 = Date.now()
  let ok = false
  try {
    const res = await rooms.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    ok = res.ok && (await res.text()).trim() === 'ok'
  } catch {
    ok = false
  }
  return { id: 'rooms', ok, ms: Date.now() - t0 }
}

/** The sync container's /health, on the internal network. */
export async function musicSyncCheck(sync: Internal): Promise<Result> {
  const t0 = Date.now()
  let ok = false
  try {
    const response = await sync.fetch('https://drive-music-sync/health', { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = await response.json() as { status?: unknown; service?: unknown; protocol?: unknown }
    ok = response.ok && body.status === 'ok' && body.service === 'drive-music-sync' && body.protocol === 2
  } catch {}
  return { id: 'musicsync', ok, ms: Date.now() - t0 }
}

export async function runChecks(env: Env, scheduledTime: number): Promise<Result[]> {
  // The model costs quota, so it is asked once an hour: the run whose scheduled minute is under 5.
  const hourly = new Date(scheduledTime).getUTCMinutes() < 5
  const site = 'https://chakkritton.com'
  return Promise.all([
    httpCheck('portfolio', `${site}/api/health`, {}, jsonOk),
    httpCheck('assistant', `${site}/api/assistant/health`, {}, jsonOk),
    ...(hourly ? [httpCheck('ai', `${site}/api/assistant/health?ai=1`, { headers: { 'x-health-token': env.HEALTH_TOKEN } }, jsonOk)] : []),
    httpCheck('expenses', 'https://expenses.chakkritton.com/api/health', {}, jsonOk),
    httpCheck(
      'reminders',
      env.SUPABASE_FUNCTION_URL,
      { method: 'POST', headers: { 'x-status-secret': env.STATUS_SECRET, 'content-type': 'application/json' }, body: '{"health":true}' },
      remindersOk,
      1, // The health read is safe to retry; no notifications are sent by this request.
    ),
    httpCheck('whiteboard', 'https://whiteboard.chakkritton.com/', {}, async (r) => r.status === 200),
    // On the internal network: the rooms health probe is not exposed publicly.
    roomsCheck(env.ROOMS, 'https://whiteboard-rooms/__health'),
    musicSyncCheck(env.MUSIC_SYNC),
    httpCheck('music', 'https://drive-music.chakkritton.com/', {}, async (r) => r.status === 200),
    // NextAuth's own endpoint: proves the serverless side and its Google provider are configured.
    httpCheck('musicauth', 'https://drive-music.chakkritton.com/api/auth/providers', {}, async (r) =>
      r.ok && 'google' in ((await r.json().catch(() => ({}))) as object),
    ),
  ])
}
