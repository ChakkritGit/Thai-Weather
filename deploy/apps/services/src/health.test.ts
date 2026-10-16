import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'health-test-'))
const snap = join(dir, 'containers.tsv')
const forwarded: unknown[] = []
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/__health') return new Response('ok\n')
    if (u.pathname === '/health') return Response.json({ status: 'ok', service: 'drive-music-sync', protocol: 2 })
    if (u.pathname === '/chat/alert') {
      if (req.headers.get('x-alert-secret') !== 'a') return Response.json({ error: 'forbidden' }, { status: 403 })
      forwarded.push(await req.json())
      return Response.json({ ok: true })
    }
    if (req.headers.get('x-status-secret') !== 's') return Response.json({ error: 'forbidden' }, { status: 403 })
    return Response.json({ lastRun: new Date().toISOString() })
  },
})
const s = `http://127.0.0.1:${stub.port}`
Object.assign(process.env, {
  CONTAINERS_FILE: snap, ROOMS_URL: s, SYNC_URL: s, REMINDERS_URL: `${s}/`, ALERT_URL: `${s}/chat/alert`,
  PROBE_SECRET: 'p', STATUS_SECRET: 's', ALERT_SECRET: 'a',
})
const { app, parseSnapshot } = await import('./health')
afterAll(() => {
  stub.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

test('the snapshot: time, rollout suffix dropped, Docker health read from the status text', () => {
  const r = parseSnapshot('1792150000\napps-expenses-17\trunning\tUp 2 hours (healthy)\ndock\trunning\tUp 9 hours\napps-chat\trunning\tUp 1 minute (health: starting)\napps-db\texited\tExited (1) 3 minutes ago\napps-rest\trunning\tUp 1 hour (unhealthy)\n')
  expect(r.at).toBe(1792150000_000)
  expect(r.containers).toEqual([
    { name: 'apps-chat', state: 'running', health: 'starting' },
    { name: 'apps-db', state: 'exited', health: null },
    { name: 'apps-expenses', state: 'running', health: 'healthy' },
    { name: 'apps-rest', state: 'running', health: 'unhealthy' },
    { name: 'dock', state: 'running', health: null },
  ])
  expect(parseSnapshot('')).toEqual({ at: 0, containers: [] })
})

test('/health needs the probe secret and answers for containers and internal services', async () => {
  writeFileSync(snap, `${Math.floor(Date.now() / 1000)}\napps-db\trunning\tUp 1 hour (healthy)\n`)
  expect((await app.handle(new Request('http://health.local/health'))).status).toBe(401)
  expect((await app.handle(new Request('http://health.local/health', { headers: { 'x-probe-secret': 'wrong' } }))).status).toBe(401)
  const r = await app.handle(new Request('http://health.local/health', { headers: { 'x-probe-secret': 'p' } }))
  expect(r.status).toBe(200)
  const body = (await r.json()) as { at: number; containers: unknown[]; checks: { id: string; ok: boolean }[] }
  expect(body.containers).toEqual([{ name: 'apps-db', state: 'running', health: 'healthy' }])
  expect(body.checks.map((c) => [c.id, c.ok])).toEqual([['rooms', true], ['musicsync', true], ['reminders', true]])
})

test('/alert forwards to Dock with the alert secret, and only with the probe secret', async () => {
  const send = (secret: string) =>
    app.handle(new Request('http://health.local/alert', { method: 'POST', headers: { 'x-probe-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify({ alert: { title: 'X ล่ม', body: 'b', id: 'server', kind: 'down' } }) }))
  expect((await send('nope')).status).toBe(401)
  expect(forwarded.length).toBe(0)
  expect((await send('p')).status).toBe(200)
  expect(forwarded).toEqual([{ alert: { title: 'X ล่ม', body: 'b', id: 'server', kind: 'down' } }])
})
