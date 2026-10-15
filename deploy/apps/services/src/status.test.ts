import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, load, tick } from './status'

const dir = mkdtempSync(join(tmpdir(), 'status-test-'))
const file = join(dir, 'status.json')
const alerts: unknown[] = []
let roomsUp = true
// one local stub stands in for every probed site
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/push') return Response.json({ lastRun: new Date().toISOString() })
    if (u.pathname === '/alert') {
      if (req.headers.get('x-alert-secret') !== 'z') return new Response('forbidden', { status: 403 })
      alerts.push((await req.json()).alert)
      return Response.json({ ok: true })
    }
    if (u.pathname === '/__health') return roomsUp ? new Response('ok\n') : new Response('no', { status: 503 })
    if (u.pathname === '/health') return Response.json({ status: 'ok', service: 'drive-music-sync', protocol: 2 })
    return Response.json({ ok: true })
  },
})
const s = `http://127.0.0.1:${stub.port}`
afterAll(() => {
  stub.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
const env = {
  STATUS_SECRET: 'x', HEALTH_TOKEN: 'y', SUPABASE_FUNCTION_URL: `${s}/push`, ALERT_URL: `${s}/alert`, ALERT_SECRET: 'z',
  ROOMS: { fetch: (_: unknown, init?: RequestInit) => fetch(`${s}/__health`, init) },
  MUSIC_SYNC: { fetch: (_: unknown, init?: RequestInit) => fetch(`${s}/health`, init) },
}

test('rooms down twice → one alert, incident, state on disk, page renders', async () => {
  await load(file)
  roomsUp = false
  const t = Date.UTC(2026, 9, 14, 3, 10) // not the hourly AI run
  const first = await tick(t, env as never, file)
  expect(first.state.services.rooms?.fails).toBe(1)
  await tick(t + 300_000, env as never, file)
  expect(alerts).toEqual([{ title: 'ห้อง Whiteboard ล่ม', body: 'เข้าไม่ได้ติดกันเกิน 5 นาที', id: 'rooms', kind: 'down' }])
  roomsUp = true
  const back = await tick(t + 600_000, env as never, file)
  expect(back.state.services.rooms?.status).toMatch(/up|slow/)
  expect(alerts.length).toBe(2)
  expect(JSON.parse(readFileSync(file, 'utf8')).incidents.length).toBe(1)

  const page = await app.handle(new Request('http://status.local/'))
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('Whiteboard')
  const api = await app.handle(new Request('http://status.local/api/status'))
  expect(api.headers.get('content-type')).toContain('json')
})
