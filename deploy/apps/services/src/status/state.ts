import type { CheckId, Incident, Result, Service, State } from './types'

const MIN = 60_000
const DAY = 24 * 60 * MIN
const SLOW_MS = 3000
const DAYS_KEPT = 90
const INCIDENT_KEPT = 7 * DAY

export const emptyState = (): State => ({ v: 1, services: {}, days: {}, incidents: [], lastRun: 0 })

/** YYYY-MM-DD in Asia/Bangkok (UTC+7, no DST), so a day rolls over at 17:00Z. */
export const bangkokDay = (ms: number): string => new Date(ms + 7 * 60 * MIN).toISOString().slice(0, 10)

export interface Alert {
  id: CheckId
  kind: 'down' | 'up'
  minutes?: number
}

// Two failures in a row before "down": one blip should not wake a phone.
export function apply(prev: State, results: Result[], now: number): { state: State; alerts: Alert[] } {
  const services = { ...prev.services }
  const days = { ...prev.days }
  let incidents: Incident[] = prev.incidents.map((i) => ({ ...i }))
  const alerts: Alert[] = []
  const today = bangkokDay(now)

  for (const r of results) {
    const old: Service = services[r.id] ?? { status: 'unknown', fails: 0, since: now, ms: 0, checkedAt: 0 }
    const s: Service = { ...old, ms: r.ms, checkedAt: now, reason: r.reason, httpStatus: r.httpStatus }
    const set = (status: Service['status']) => {
      if (status !== s.status) s.since = now
      s.status = status
    }
    if (r.ok) {
      s.fails = 0
      if (old.status === 'down') {
        const open = incidents.find((i) => i.id === r.id && i.end === undefined)
        if (open) open.end = now
        alerts.push({ id: r.id, kind: 'up', minutes: Math.round((now - old.since) / MIN) })
      }
      set(r.ms > SLOW_MS ? 'slow' : 'up')
    } else {
      s.fails += 1
      if (s.fails === 2 && old.status !== 'down') {
        set('down')
        incidents.push({ id: r.id, start: now })
        alerts.push({ id: r.id, kind: 'down' })
      }
    }
    services[r.id] = s

    const counts = { ...days[r.id] }
    const [ok, total] = counts[today] ?? [0, 0]
    counts[today] = [ok + (r.ok ? 1 : 0), total + 1]
    days[r.id] = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-DAYS_KEPT))
  }

  incidents = incidents.filter((i) => i.end === undefined || now - i.end <= INCIDENT_KEPT)
  return { state: { v: 1, services, days, incidents, lastRun: now }, alerts }
}
