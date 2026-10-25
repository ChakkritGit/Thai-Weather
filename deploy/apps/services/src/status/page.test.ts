// Run: bun test src/status/page.test.ts   (from deploy/apps/services/)
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CHECKS } from './checks'
import { handle, render } from './page'
import { bangkokDay, emptyState } from './state'
import type { State } from './types'

const NOW = Date.UTC(2026, 9, 2, 5, 0, 0)
const svc = (status: 'up' | 'down', ms = 120) => ({ status, fails: 0, since: NOW - 3600_000, ms, checkedAt: NOW })
const allUp = (): State => ({
  ...emptyState(),
  lastRun: NOW,
  services: Object.fromEntries(CHECKS.map((c) => [c.id, svc('up')])),
})

test('an empty state renders and says it has never checked', () => {
  const html = render(emptyState(), NOW)
  assert.match(html, /ยังไม่มีข้อมูล/)
  assert.match(html, /ไม่มีเหตุขัดข้องใน 7 วันที่ผ่านมา/)
})

test('all up says everything is normal, with the Bangkok check time', () => {
  const html = render(allUp(), NOW)
  assert.match(html, /ทุกระบบปกติ/)
  assert.match(html, /อัปเดตล่าสุด 12:00/)
})

test('one down names it, and an open incident reads "ยังไม่กลับมา"', () => {
  const s = allUp()
  s.services.rooms = svc('down')
  s.incidents = [{ id: 'rooms', start: NOW - 600_000 }]
  const html = render(s, NOW)
  assert.match(html, /มีบางระบบล่ม/)
  assert.match(html, /มีบางระบบล่ม: ห้อง Whiteboard/)
  assert.match(html, /ยังไม่กลับมา/)
})

test('a 95/100 day is an amber bar whose tooltip data says 95% and how many checks failed', () => {
  const s = allUp()
  s.days.portfolio = { [bangkokDay(NOW)]: [95, 100] }
  const html = render(s, NOW)
  assert.match(html, /class="bar warn" role="img" tabindex="0" data-d="[^"]+" data-u="95%" data-n="ล่มราว 25 นาที"/)
})

test('an incident inside a day shows as minutes down in that bar', () => {
  const s = allUp()
  s.days.rooms = { [bangkokDay(NOW)]: [90, 100] }
  s.incidents = [{ id: 'rooms', start: NOW - 30 * 60_000, end: NOW - 10 * 60_000 }]
  assert.match(render(s, NOW), /data-n="ล่มราว 20 นาที"/)
})

test('the banner says slow, not normal, when something is slow', () => {
  const s = allUp()
  s.services.expenses = { ...svc('up'), status: 'slow' }
  assert.match(render(s, NOW), /บางระบบตอบช้า: Spent-Cost/)
})

test('a name with markup is escaped', () => {
  const html = render(allUp(), NOW, [{ id: 'portfolio', group: 'portfolio', name: '<script>alert(1)</script>' }])
  assert.ok(!html.includes('<script>alert(1)'))
  assert.match(html, /&#60;script&#62;/)
})

test('routes: json, page, and 404', async () => {
  const get = (p: string) => handle(new Request(`https://status.chakkritton.com${p}`), allUp(), NOW)
  const j = (await get('/api/status').json()) as { services: unknown[]; incidents: unknown[]; lastRun: number }
  assert.equal(j.services.length, 15)
  assert.equal(get('/api/status').headers.get('Cache-Control'), 'public, max-age=60')
  assert.equal(get('/').status, 200)
  assert.equal(get('/nope').status, 404)
  assert.equal(get('/status').status, 404)
  assert.equal(get('/favicon.svg').headers.get('Content-Type'), 'image/svg+xml')
  for (const res of [get('/'), get('/api/status'), get('/nope')]) {
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY')
    assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin')
    assert.match(res.headers.get('Strict-Transport-Security') ?? '', /max-age=63072000/)
  }
})

test('Thai Weather has its own group with separate web and API status and history', async () => {
  const s = allUp()
  s.services.weatherapi = { ...svc('down'), reason: 'http-error', httpStatus: 503 }
  s.days.weather = { [bangkokDay(NOW)]: [10, 10] }
  s.days.weatherapi = { [bangkokDay(NOW)]: [9, 10] }
  const html = render(s, NOW)
  const group = html.match(/<section><h2>Thai Weather<\/h2>[\s\S]*?<\/section>/)?.[0]
  assert.ok(group)
  assert.match(group, /<b>Thai Weather<\/b><span class="st up">ปกติ/)
  assert.match(group, /<b>Thai Weather API<\/b><span class="st down">ล่ม/)
  assert.match(group, /uptime 100\.0%/)
  assert.match(group, /uptime 90\.0%/)
  assert.match(group, /HTTP 503/)
  const j = await handle(new Request('https://status.chakkritton.com/api/status'), s, NOW).json() as { services: { id: string; group: string; status: string }[] }
  assert.deepEqual(j.services.filter((service) => service.group === 'thaiweather').map(({ id, status }) => [id, status]), [['weather', 'up'], ['weatherapi', 'down']])
})

test('shows failure categories and measured latency', async () => {
  const s = allUp()
  s.services.reminders = { ...svc('down', 20_000), reason: 'timeout' }
  assert.match(render(s, NOW), /ตรวจสถานะเกินเวลาที่กำหนด/)
  assert.match(render(s, NOW), /20000 ms/)
  s.services.reminders = { ...svc('down'), reason: 'heartbeat-stale' }
  assert.match(render(s, NOW), /งานส่งบิลยังไม่มีรอบสำเร็จภายใน 26 ชั่วโมง/)
  const j = await handle(new Request('https://status.chakkritton.com/api/status'), s, NOW).json() as { services: { id: string; reason: string }[] }
  assert.equal(j.services.find((service) => service.id === 'reminders')?.reason, 'heartbeat-stale')
})

test('share tags and the files crawlers ask for', async () => {
  const html = render(allUp(), NOW)
  assert.match(html, /<meta property="og:image" content="https:\/\/status\.chakkritton\.com\/og\.png">/)
  assert.match(html, /<meta name="description" content="[^"]+">/)
  assert.match(html, /<link rel="canonical" href="https:\/\/status\.chakkritton\.com\/">/)
  const png = readFileSync(new URL('./og.png', import.meta.url)).buffer
  const get = (p: string) => handle(new Request(`https://status.chakkritton.com${p}`), allUp(), NOW, png)
  const og = get('/og.png')
  assert.equal(og.headers.get('content-type'), 'image/png')
  assert.ok((await og.arrayBuffer()).byteLength > 10_000)
  assert.match(await get('/robots.txt').text(), /Sitemap: https:\/\/status\.chakkritton\.com\/sitemap\.xml/)
  assert.match(await get('/sitemap.xml').text(), /<loc>https:\/\/status\.chakkritton\.com\/<\/loc>/)
  const llms = await get('/llms.txt').text()
  assert.ok(llms.startsWith('# สถานะระบบ'))
  for (const c of CHECKS) assert.ok(llms.includes(c.name))
})
