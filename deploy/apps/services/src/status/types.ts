export type CheckId = 'server' | 'weather' | 'weatherapi' | 'portfolio' | 'assistant' | 'ai' | 'expenses' | 'reminders' | 'whiteboard' | 'rooms' | 'music' | 'musicauth' | 'musicsync' | 'calorieflow' | 'calorieflowai'
/** Checks the VPS's health endpoint answers for (the Worker cannot reach them from outside). */
export const INTERNAL_IDS = ['rooms', 'musicsync', 'reminders'] as const satisfies readonly CheckId[]
export type FailureReason = 'http-error' | 'timeout' | 'network' | 'invalid-response' | 'unhealthy' | 'heartbeat-stale'
export interface Result {
  id: CheckId
  ok: boolean
  ms: number
  reason?: FailureReason
  httpStatus?: number
  /** e.g. the containers that are not running or unhealthy */
  detail?: string
}
export interface Service {
  status: 'up' | 'slow' | 'down' | 'unknown'
  fails: number
  /** Consecutive answers over the slow threshold. */
  slowRuns?: number
  since: number
  ms: number
  reason?: FailureReason
  httpStatus?: number
  detail?: string
  checkedAt: number
}
export interface Incident {
  id: CheckId
  start: number
  end?: number
}
export interface State {
  v: 1
  services: Partial<Record<CheckId, Service>>
  /** Per Bangkok day: [ok, total] check counts. */
  days: Partial<Record<CheckId, Record<string, [ok: number, total: number]>>>
  incidents: Incident[]
  lastRun: number
}
/** One container on the VPS, from the host's snapshot of `docker ps -a`. */
export interface Container {
  name: string
  state: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
}
/** What health.chakkritton.com/health answers. */
export interface HealthReport {
  /** when the host wrote the container snapshot (ms), 0 when there is none */
  at: number
  containers: Container[]
  checks: Result[]
}
/** The status Worker's settings (wrangler.toml vars + secrets). */
export interface Env {
  /** https://health.chakkritton.com/health: containers + the internal checks, in one answer */
  HEALTH_URL: string
  /** sent as x-probe-secret to the health endpoint (and its alert relay) */
  PROBE_SECRET: string
  /** the portfolio's hourly AI check */
  HEALTH_TOKEN: string
  /** CalorieFlow's hourly AI check (the calorieflow-ai Worker's HEALTH_TOKEN) */
  CALORIEFLOW_HEALTH_TOKEN: string
}
/** Something that answers fetch(): the rooms / sync containers, reached on the internal network. */
export interface Internal {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
