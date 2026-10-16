/**
 * One scheduled run of the status Worker: probe, update the state in KV, send the alerts.
 *
 * Alerts go through the VPS's health service to Dock's chat (a message + a push to the subscribed
 * devices). When that relay cannot be reached, the VPS itself is down, so what could not be delivered
 * goes out as one e-mail instead.
 */
import { CHECKS, runChecks } from './checks'
import { alertEmail } from './email'
import { apply, emptyState, type Alert } from './state'
import type { Env, State } from './types'

const KEY = 'state'

/** The bits of KVNamespace used here. */
export interface Store {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string): Promise<void>
}
export interface Message {
  title: string
  body: string
  id: string
  kind: Alert['kind']
}
/** Sends one e-mail (plain text + HTML); absent until Email Routing is set up. */
export type Mailer = (mail: { subject: string; text: string; html: string }) => Promise<void>

export async function load(kv: Store): Promise<State> {
  const s = (await kv.get(KEY, 'json').catch(() => null)) as State | null
  return s && s.v === 1 ? s : emptyState()
}

const nameOf = (id: string) => CHECKS.find((c) => c.id === id)?.name ?? id

export function message(a: Alert): Message {
  const name = nameOf(a.id)
  return a.kind === 'down'
    ? { title: `${name} ล่ม`, body: 'เข้าไม่ได้ติดกันเกิน 5 นาที', id: a.id, kind: a.kind }
    : { title: `${name} กลับมาแล้ว`, body: `ล่มไปประมาณ ${a.minutes} นาที`, id: a.id, kind: a.kind }
}

/** POST /alert on the health service, which forwards it to Dock's chat. */
async function relay(env: Env, m: Message): Promise<boolean> {
  try {
    const r = await fetch(new URL('/alert', env.HEALTH_URL), {
      method: 'POST',
      headers: { 'x-probe-secret': env.PROBE_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ alert: m }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) console.error('alert relay failed', m.id, r.status)
    return r.ok
  } catch (err) {
    console.error('alert relay failed', m.id, (err as Error).message)
    return false
  }
}

export async function tick(env: Env, kv: Store, scheduledTime: number, mail?: Mailer, now = Date.now) {
  const results = await runChecks(env, scheduledTime)
  for (const r of results) if (r.ok && r.ms > 3000) console.log('slow', r.id, `${r.ms} ms`)
  const out = apply(await load(kv), results, now())
  await kv.put(KEY, JSON.stringify(out.state))

  const undelivered: Message[] = []
  for (const m of out.alerts.map(message)) if (!(await relay(env, m))) undelivered.push(m)
  if (undelivered.length && mail) {
    await mail(alertEmail(undelivered, now())).catch((err) => console.error('alert e-mail failed', (err as Error).message))
  }
  return { ...out, undelivered }
}
