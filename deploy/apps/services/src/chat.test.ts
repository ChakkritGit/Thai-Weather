import { expect, test } from 'bun:test'
import { allowedEndpoint, composeReport, createApp, digestDay, encryptPush, maybePostReport, monthName, open, reply, vapidKeys, type Digest } from './chat'

const day = '2026-10-14'
const from = Date.parse(`${day}T00:00:00+07:00`) / 1000
/** 7-day-style payload: 10-minute steps covering the whole day plus one sample of the next */
function metrics() {
  const times = Array.from({ length: 145 }, (_, i) => from + i * 600)
  const col = (v: number) => times.map(() => v)
  return {
    step: 600,
    times,
    host: { cpu_user: col(10), cpu_system: col(4), cpu_iowait: col(1), mem_used: col(1e9), net_rx: col(1000), net_tx: col(2000) },
    nginx: { all: { req: col(9) }, 'thai-weather.chakkritton.com': { req: col(6), s4: col(1), s5: col(0), bytes: col(5000) }, 'expenses.chakkritton.com': { req: col(3), s4: col(0), s5: col(1), bytes: col(100) } },
    snapshot: { mem_total: 3e9, disk_used: 14e9, disk_total: 29e9, cpus: 2 },
  }
}

test('a day digest sums the day and nothing outside it', () => {
  const d = digestDay(day, metrics(), { series: [{ day, views: 40, visitors: 7 }], perHost: [], totals: { views: 40, visitors: 7 } })!
  expect(d.coverage).toBe(1)
  expect(d.cpuAvg).toBeCloseTo(15)
  expect(d.netRx).toBe(144 * 600 * 1000) // the 145th sample belongs to the next day
  expect(d.requests['thai-weather.chakkritton.com'].req).toBe(144 * 6)
  expect(d.requests.all).toBeUndefined()
  expect(d.visitors).toBe(7)
  expect(digestDay('2026-10-20', metrics(), null)).toBeNull()
})

test('the report reads like a summary', () => {
  const d = digestDay(day, metrics(), null) as Digest
  const text = composeReport('2026-10', [d], {
    analytics: { series: [], perHost: [{ key: 'chakkritton.com', views: 10, visitors: 4 }], totals: { views: 10, visitors: 4 } },
    status: { services: [{ name: 'Portfolio', status: 'up', uptime90: 100 }, { name: 'Whiteboard', status: 'down', uptime90: 98 }] },
    backups: { bundles: [] },
    untilDay: 15,
  })
  expect(text).toStartWith('สรุปเดือนตุลาคม 2569 (ถึงวันที่ 15)')
  expect(text).toContain('CPU เฉลี่ย 15%')
  expect(text).toContain('มากสุด: thai-weather')
  expect(text).toContain('5xx เกิน 1%: expenses')
  expect(text).toContain('portfolio 4 คน')
  expect(text).toContain('ตอนนี้มีปัญหา: Whiteboard')
  expect(text).toContain('ยังไม่มีไฟล์สำรอง')
  expect(text).toContain('ครบ 1 จาก 15 วัน')
  expect(monthName('2027-01')).toBe('มกราคม 2570')
})

test('commands answer without an LLM, anything else says none is set up', async () => {
  delete process.env.LLM_PROVIDER
  const db = open(':memory:')
  expect(await reply(db, 'ช่วย')).toContain('สรุป — สรุปเดือนนี้')
  expect(await reply(db, 'สวัสดี')).toContain('ยังไม่ได้เชื่อม LLM')
})

test('the month report is posted once, only for a month with data', async () => {
  const db = open(':memory:')
  const lastEvening = Date.parse('2026-10-31T23:56:00+07:00')
  expect(await maybePostReport(db, lastEvening)).toBeNull() // no digests of October
  db.run('INSERT INTO digests (day, data) VALUES (?, ?)', [day, JSON.stringify(digestDay(day, metrics(), null))])
  const msg = await maybePostReport(db, lastEvening)
  expect(msg?.role).toBe('system')
  expect(msg?.read).toBe(0)
  expect(await maybePostReport(db, lastEvening + 60_000)).toBeNull()
  // missed on the 31st: still posted on the 1st of the next month
  const db2 = open(':memory:')
  db2.run('INSERT INTO digests (day, data) VALUES (?, ?)', [day, JSON.stringify(digestDay(day, metrics(), null))])
  expect((await maybePostReport(db2, Date.parse('2026-11-01T09:00:00+07:00')))?.text).toStartWith('สรุปเดือนตุลาคม 2569')
  expect(await maybePostReport(db2, Date.parse('2026-10-20T23:56:00+07:00'))).toBeNull() // not a last day
})

test('HTTP: post, list, unread and read', async () => {
  const app = createApp(open(':memory:'))
  const call = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init)).then((r) => r.json())
  const sent = await call('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'ช่วย' }) })
  expect(sent.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant'])
  const bad = await app.handle(new Request('http://localhost/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) }))
  expect(bad.status).toBe(400)
  const list = await call('/chat')
  expect(list.messages).toHaveLength(2)
  expect(list.llm).toBe(false)
  expect((await call('/chat/unread')).count).toBe(0)
})

const u = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'base64url'))

test('push encryption matches RFC 8291 Appendix A byte for byte', async () => {
  const asPublic = u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')
  const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: Buffer.from(asPublic.slice(1, 33)).toString('base64url'), y: Buffer.from(asPublic.slice(33)).toString('base64url') }
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
  const body = await encryptPush(u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    u('DGv6ra1nlYgDCS1FRnbzlw'), { privateKey, publicKey })
  const header = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8'
  const cipher = '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ'
  expect(Buffer.from(body).toString('base64url')).toBe(Buffer.from([...u(header), ...u(cipher)]).toString('base64url'))
})

test('push: one VAPID key, only real push services, subscribe and unsubscribe', async () => {
  const db = open(':memory:')
  const a = await vapidKeys(db)
  expect((await vapidKeys(db)).publicKey).toBe(a.publicKey)
  expect(u(a.publicKey)).toHaveLength(65)
  expect(allowedEndpoint('https://web.push.apple.com/QGu...')).toBe(true)
  expect(allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
  expect(allowedEndpoint('http://fcm.googleapis.com/x')).toBe(false)
  expect(allowedEndpoint('https://apps-db:5432/')).toBe(false)
  const app = createApp(db)
  const post = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  expect((await post('/chat/push/subscribe', { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(400)
  expect((await post('/chat/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(200)
  expect(db.query('SELECT COUNT(*) AS n FROM push_subs').get()).toEqual({ n: 1 })
  await post('/chat/push/unsubscribe', { endpoint: 'https://web.push.apple.com/abc' })
  expect(db.query('SELECT COUNT(*) AS n FROM push_subs').get()).toEqual({ n: 0 })
  const key = await (await app.handle(new Request('http://localhost/chat/push/key'))).json()
  expect(key.key).toBe(a.publicKey)
})
