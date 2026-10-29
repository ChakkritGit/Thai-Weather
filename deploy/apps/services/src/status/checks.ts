import { INTERNAL_IDS, type CheckId, type Env, type HealthReport, type Result, type FailureReason } from './types'

export const CHECKS: { id: CheckId; group: 'server' | 'thaiweather' | 'portfolio' | 'spentcost' | 'whiteboard' | 'drivemusic' | 'calorieflow'; name: string; hourly?: true }[] = [
  { id: 'server', group: 'server', name: 'เซิร์ฟเวอร์และ container' },
  { id: 'weather', group: 'thaiweather', name: 'Thai Weather' },
  { id: 'weatherapi', group: 'thaiweather', name: 'Thai Weather API' },
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
  { id: 'calorieflow', group: 'calorieflow', name: 'CalorieFlow' },
  { id: 'calorieflowapi', group: 'calorieflow', name: 'CalorieFlow API' },
  { id: 'calorieflowai', group: 'calorieflow', name: 'โค้ช AI ของ CalorieFlow', hourly: true },
]

export const TIMEOUT_MS = 10_000
/**
 * A failed probe is tried once more after this pause before it counts. Deploys restart containers,
 * and a check that landed in that second or two marked five minutes down (Whiteboard rooms' 98%).
 * Tests set it to 0.
 */
export const retry = { delayMs: 5000 }
export const pause = () => (retry.delayMs > 0 ? new Promise((r) => setTimeout(r, retry.delayMs)) : Promise.resolve())

/** The answer time of the last attempt (a retry's pause and the failed try are not the site being slow)
 * and a safe failure category for diagnostics. Only read-only probes opt into one retry for a transient
 * transport failure. */
export async function httpCheck(id: CheckId, url: string, init: RequestInit, isOk: (res: Response) => Promise<boolean | FailureReason>, retries = 0): Promise<Result> {
  let t0 = Date.now()
  let result: Result = { id, ok: false, ms: 0 }
  for (let attempt = 0; attempt <= retries; attempt++) {
    t0 = Date.now()
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
    if (attempt < retries) await pause()
  }
  return { ...result, ms: Date.now() - t0 }
}

export const jsonOk = async (r: Response) => r.ok && ((await r.json().catch(() => ({}))) as { ok?: unknown }).ok === true

/** A container snapshot older than this means the host's timer stopped (it writes every 30 s). */
const SNAPSHOT_MAX_AGE = 3 * 60_000

/**
 * One request to the VPS's health endpoint answers for everything the Worker cannot reach from outside:
 * the containers (from Docker's own health checks) and the internal services. When it cannot be reached
 * the server and every internal check fail with the same reason.
 */
export async function internalChecks(env: Env, now = Date.now()): Promise<Result[]> {
  let report = null as HealthReport | null
  const server = await httpCheck('server', env.HEALTH_URL, { headers: { 'x-probe-secret': env.PROBE_SECRET } }, async (r) => {
    const body = (await r.json().catch(() => null)) as HealthReport | null
    if (!body || !Array.isArray(body.containers) || !Array.isArray(body.checks)) return 'invalid-response'
    report = body
    return true
  }, 1)
  if (!report) return [server, ...INTERNAL_IDS.map((id) => ({ ...server, id }))]
  const { at, containers, checks } = report as HealthReport
  const bad = containers.filter((c) => c.state !== 'running' || c.health === 'unhealthy')
  const stale = !at || now - at > SNAPSHOT_MAX_AGE
  const serverResult: Result = stale
    ? { ...server, ok: false, reason: 'unhealthy', detail: 'ข้อมูล container ไม่อัปเดต' }
    : bad.length
      ? { ...server, ok: false, reason: 'unhealthy', detail: bad.map((c) => `${c.name} (${c.health === 'unhealthy' ? 'unhealthy' : c.state})`).join(', ') }
      : server
  const byId = new Map(checks.map((c) => [c.id, c]))
  return [
    serverResult,
    ...INTERNAL_IDS.map((id): Result => {
      const c = byId.get(id)
      return c ? { id, ok: c.ok === true, ms: Number(c.ms) || 0, ...(c.reason ? { reason: c.reason } : {}) } : { id, ok: false, ms: 0, reason: 'invalid-response' }
    }),
  ]
}

export async function runChecks(env: Env, scheduledTime: number): Promise<Result[]> {
  // The model costs quota, so it is asked once an hour: the run whose scheduled minute is under 5.
  const hourly = new Date(scheduledTime).getUTCMinutes() < 5
  const site = 'https://chakkritton.com'
  const weather = 'https://thai-weather.chakkritton.com'
  const results = await Promise.all([
    internalChecks(env),
    httpCheck('weather', `${weather}/`, {}, async (r) => r.status === 200, 1),
    // Read-only liveness: a scheduled forecast failure does not mean the API stopped serving data.
    httpCheck('weatherapi', `${weather}/api/v1/health`, {}, jsonOk, 1),
    httpCheck('portfolio', `${site}/api/health`, {}, jsonOk, 1),
    httpCheck('assistant', `${site}/api/assistant/health`, {}, jsonOk, 1),
    ...(hourly ? [httpCheck('ai', `${site}/api/assistant/health?ai=1`, { headers: { 'x-health-token': env.HEALTH_TOKEN } }, jsonOk)] : []),
    httpCheck('expenses', 'https://expenses.chakkritton.com/api/health', {}, jsonOk, 1),
    httpCheck('whiteboard', 'https://whiteboard.chakkritton.com/', {}, async (r) => r.status === 200, 1),
    httpCheck('music', 'https://drive-music.chakkritton.com/', {}, async (r) => r.status === 200, 1),
    // NextAuth's own endpoint: proves the serverless side and its Google provider are configured.
    httpCheck('musicauth', 'https://drive-music.chakkritton.com/api/auth/providers', {}, async (r) =>
      r.ok && 'google' in ((await r.json().catch(() => ({}))) as object), 1,
    ),
    // ok only with the database answering and the reminder scheduler's heartbeat under 5 minutes old
    httpCheck('calorieflow', 'https://calorieflow.chakkritton.com/api/health', {}, jsonOk, 1),
    // the Rust API (web and native app): 204 only with its database answering
    httpCheck('calorieflowapi', 'https://calorieflow.chakkritton.com/api/v1/healthz', {}, async (r) => r.status === 204, 1),
    ...(hourly
      ? [httpCheck('calorieflowai', 'https://calorieflow.chakkritton.com/ai/health?ai=1', { headers: { 'x-health-token': env.CALORIEFLOW_HEALTH_TOKEN } }, jsonOk)]
      : []),
  ])
  return results.flat()
}
