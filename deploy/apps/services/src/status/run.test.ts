// Run: bun test src/status/run.test.ts   (from deploy/apps/services/)
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { retry } from './checks'
import { alertEmail } from './email'
import { load, tick, type Store } from './run'

retry.delayMs = 0
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const env = { HEALTH_URL: 'https://health.test/health', PROBE_SECRET: 'p', HEALTH_TOKEN: 't', CALORIEFLOW_HEALTH_TOKEN: 'c' }
const kv = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, get: async (k) => (data.has(k) ? JSON.parse(data.get(k)!) : null), put: async (k, v) => void data.set(k, v) }
}
const T = Date.UTC(2026, 9, 16, 3, 10) // not the hourly AI run

/** Every site answers; `vps` false = nothing on the VPS answers (the health endpoint, the relay, the sites). */
function world(opts: { vps: boolean; relayed: unknown[] }) {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (!opts.vps) throw new TypeError('fetch failed')
    if (url === 'https://health.test/alert') {
      opts.relayed.push(JSON.parse(String(init?.body)).alert)
      return Response.json({ ok: true })
    }
    if (url === env.HEALTH_URL) return Response.json({ at: Date.now(), containers: [{ name: 'apps-db', state: 'running', health: 'healthy' }], checks: [{ id: 'rooms', ok: true, ms: 1 }, { id: 'musicsync', ok: true, ms: 1 }, { id: 'reminders', ok: true, ms: 1 }] })
    if (url.includes('/api/auth/providers')) return Response.json({ google: {} })
    if (url.endsWith('.com/')) return new Response('<html>')
    return Response.json({ ok: true })
  }) as never
}

test('a VPS that stops answering: one e-mail for every down alert, then "back up" goes to Dock again', async () => {
  const store = kv()
  const relayed: unknown[] = []
  const mails: { subject: string; text: string; html: string }[] = []
  const mail = async (m: (typeof mails)[number]) => void mails.push(m)

  world({ vps: true, relayed })
  await tick(env, store, T, mail, () => T)
  assert.equal((await load(store)).services.server?.status, 'up')
  assert.equal((await load(store)).services.weather?.status, 'up')
  assert.equal((await load(store)).services.weatherapi?.status, 'up')
  assert.equal(relayed.length, 0)
  assert.equal(mails.length, 0)

  world({ vps: false, relayed })
  await tick(env, store, T + 5 * 60_000, mail, () => T + 5 * 60_000)
  assert.equal(mails.length, 0) // one failure is not "down" yet
  const down = await tick(env, store, T + 10 * 60_000, mail, () => T + 10 * 60_000)
  assert.equal(down.alerts.length, 13) // every check goes through the VPS
  assert.equal(mails.length, 1)
  assert.match(mails[0].subject, /^เซิร์ฟเวอร์และ container ล่ม และอีก 12 รายการ$/)
  assert.match(mails[0].html, /ดูหน้าสถานะ/)

  world({ vps: true, relayed })
  const back = await tick(env, store, T + 30 * 60_000, mail, () => T + 30 * 60_000)
  assert.equal(back.undelivered.length, 0)
  assert.equal(relayed.length, 13)
  assert.equal(mails.length, 1)
  assert.equal((await load(store)).incidents.length, 13)
})

test('the e-mail escapes what it shows and keeps a plain-text part', () => {
  const m = alertEmail([{ title: '<b>x</b> ล่ม', body: 'เข้าไม่ได้', id: 'server', kind: 'down' }], T)
  assert.ok(!m.html.includes('<b>x</b>'))
  assert.match(m.text, /<b>x<\/b> ล่ม — เข้าไม่ได้/)
  assert.match(m.text, /https:\/\/status\.chakkritton\.com/)
})
