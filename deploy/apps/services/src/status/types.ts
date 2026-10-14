export type CheckId = 'portfolio' | 'assistant' | 'ai' | 'expenses' | 'reminders' | 'whiteboard' | 'rooms' | 'music' | 'musicauth' | 'musicsync'
export type FailureReason = 'http-error' | 'timeout' | 'network' | 'invalid-response' | 'unhealthy' | 'heartbeat-stale'
export interface Result {
  id: CheckId
  ok: boolean
  ms: number
  reason?: FailureReason
  httpStatus?: number
}
export interface Service {
  status: 'up' | 'slow' | 'down' | 'unknown'
  fails: number
  since: number
  ms: number
  reason?: FailureReason
  httpStatus?: number
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
/** Something that answers fetch(): the rooms / sync containers, reached on the internal network. */
export interface Internal {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
export interface Env {
  /** Probed directly on the internal network: their health endpoints are not public. */
  MUSIC_SYNC: Internal
  ROOMS: Internal
  STATUS_SECRET: string
  HEALTH_TOKEN: string
  SUPABASE_FUNCTION_URL: string
}
