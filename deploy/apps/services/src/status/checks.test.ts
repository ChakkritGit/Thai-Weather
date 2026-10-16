// Run: bun test src/status/checks.test.ts   (from deploy/apps/services/)
import { test, afterEach } from 'bun:test'
import assert from 'node:assert/strict'
import { httpCheck, internalChecks, jsonOk, retry, runChecks } from './checks'
import { fresh, musicSyncCheck, remindersCheck, roomsCheck } from './internal'

retry.delayMs = 0

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const stub = (fn: (url: string) => Response | Promise<Response>) => {
  globalThis.fetch = (async (url: string) => fn(String(url))) as never
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('httpCheck: ok, a non-200, a throw, and ok:false in the body', async () => {
  stub(() => json({ ok: true }))
  assert.equal((await httpCheck('portfolio', 'https://x', {}, jsonOk)).ok, true)
  stub(() => json({ ok: true }, 503))
  assert.equal((await httpCheck('portfolio', 'https://x', {}, jsonOk)).ok, false)
  stub(() => {
    throw new Error('network')
  })
  const r = await httpCheck('portfolio', 'https://x', {}, jsonOk)
  assert.deepEqual([r.id, r.ok], ['portfolio', false])
  stub(() => json({ ok: false }))
  assert.equal((await httpCheck('portfolio', 'https://x', {}, jsonOk)).ok, false)
})

test('a retry\'s pause and the failed try are not counted as answer time', async () => {
  retry.delayMs = 600
  try {
    let calls = 0
    stub(async () => {
      if (++calls === 1) {
        await new Promise((r) => setTimeout(r, 300))
        return json({}, 502)
      }
      return json({ ok: true })
    })
    const r = await httpCheck('portfolio', 'https://x', {}, jsonOk, 1)
    assert.equal(r.ok, true)
    assert.ok(r.ms < 300, `ms ${r.ms}`)
    let tries = 0
    const rooms = { fetch: async () => (++tries === 1 ? new Response('no', { status: 503 }) : new Response('ok')) } as never
    const room = await roomsCheck(rooms, 'https://x/__health')
    assert.equal(room.ok, true)
    assert.ok(room.ms < 300, `rooms ms ${room.ms}`)
  } finally {
    retry.delayMs = 0
  }
})

test('fresh: within 26 hours only', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  assert.equal(fresh(new Date(now - 25 * 3600_000).toISOString(), now), true)
  assert.equal(fresh(new Date(now - 27 * 3600_000).toISOString(), now), false)
  assert.equal(fresh(null, now), false)
  assert.equal(fresh('garbage', now), false)
  assert.equal(fresh(new Date(now + 6 * 60_000).toISOString(), now), false)
})

test('a read-only probe retries transport failures once, preserving error details', async () => {
  let calls = 0
  stub(() => ++calls === 1 ? json({}, 503) : json({ ok: true }))
  assert.equal((await httpCheck('reminders', 'https://fn', {}, jsonOk, 1)).ok, true)
  assert.equal(calls, 2)
  calls = 0
  stub(() => { calls++; return json({}, 403) })
  const forbidden = await httpCheck('reminders', 'https://fn', {}, jsonOk, 1)
  assert.equal(calls, 1)
  assert.equal(forbidden.reason, 'http-error')
  assert.equal(forbidden.httpStatus, 403)
  calls = 0
  stub(() => { calls++; throw new DOMException('timeout', 'TimeoutError') })
  const timedOut = await httpCheck('reminders', 'https://fn', {}, jsonOk, 1)
  assert.equal(calls, 2)
  assert.equal(timedOut.reason, 'timeout')
})

test('reminder checks distinguish stale heartbeats and malformed responses without retrying', async () => {
  for (const [body, reason] of [
    [{ lastRun: new Date().toISOString() }, undefined],
    [{ lastRun: null }, 'heartbeat-stale'],
    [{ lastRun: new Date(Date.now() - 27 * 3600_000).toISOString() }, 'heartbeat-stale'],
    [{}, 'invalid-response'],
    ['bad', 'invalid-response'],
  ] as const) {
    let calls = 0
    stub((url) => { if (url === 'https://fn') { calls++; return json(body) } return json({ ok: true }) })
    const result = await remindersCheck('https://fn', 's')
    assert.equal(result.ok, reason === undefined)
    assert.equal(result.reason, reason)
    assert.equal(calls, 1)
  }
})

const env = { HEALTH_URL: 'https://h/health', PROBE_SECRET: 'p', HEALTH_TOKEN: 't' }
const NOW = Date.UTC(2026, 9, 16, 10, 5)
const report = (over: Record<string, unknown> = {}) => ({
  at: NOW - 30_000,
  containers: [{ name: 'apps-db', state: 'running', health: 'healthy' }, { name: 'dock', state: 'running', health: null }],
  checks: [{ id: 'rooms', ok: true, ms: 3 }, { id: 'musicsync', ok: true, ms: 2 }, { id: 'reminders', ok: false, ms: 5, reason: 'heartbeat-stale' }],
  ...over,
})

test('runChecks asks the model only in minutes 0-4', async () => {
  stub((url) => (url === env.HEALTH_URL ? json(report()) : json({ ok: true })))
  const ids = async (min: number) => (await runChecks(env, Date.UTC(2026, 9, 2, 10, min))).map((r) => r.id)
  for (const m of [0, 4]) assert.ok((await ids(m)).includes('ai'), `minute ${m}`)
  for (const m of [5, 59]) assert.ok(!(await ids(m)).includes('ai'), `minute ${m}`)
  assert.deepEqual((await ids(5)).sort(), ['assistant', 'expenses', 'music', 'musicauth', 'musicsync', 'portfolio', 'reminders', 'rooms', 'server', 'whiteboard'])
})

test('internal checks: one request with the probe secret answers for the server and the internal services', async () => {
  let secret: string | null = null
  globalThis.fetch = (async (_: string, init?: RequestInit) => {
    secret = new Headers(init?.headers).get('x-probe-secret')
    return json(report())
  }) as never
  const r = Object.fromEntries((await internalChecks(env, NOW)).map((x) => [x.id, x]))
  assert.equal(secret, 'p')
  assert.equal(r.server.ok, true)
  assert.deepEqual([r.rooms.ok, r.musicsync.ok, r.reminders.ok, r.reminders.reason], [true, true, false, 'heartbeat-stale'])
})

test('internal checks: a stopped or unhealthy container, or an old snapshot, fails the server with the names', async () => {
  stub(() => json(report({ containers: [{ name: 'apps-db', state: 'exited', health: null }, { name: 'apps-chat', state: 'running', health: 'unhealthy' }, { name: 'apps-sync', state: 'running', health: 'starting' }] })))
  const server = (await internalChecks(env, NOW)).find((x) => x.id === 'server')!
  assert.equal(server.ok, false)
  assert.equal(server.detail, 'apps-db (exited), apps-chat (unhealthy)')
  stub(() => json(report({ at: NOW - 10 * 60_000 })))
  assert.equal((await internalChecks(env, NOW)).find((x) => x.id === 'server')!.ok, false)
})

test('internal checks: an unreachable VPS fails the server and every internal check', async () => {
  stub(() => { throw new TypeError('fetch failed') })
  const all = await internalChecks(env, NOW)
  assert.deepEqual(all.map((x) => [x.id, x.ok, x.reason]), [['server', false, 'network'], ['rooms', false, 'network'], ['musicsync', false, 'network'], ['reminders', false, 'network']])
  stub(() => json({ error: 'unauthorized' }, 401))
  assert.equal((await internalChecks(env, NOW))[0].httpStatus, 401)
})


test('Party Play health requires the sync service and current protocol', async () => {
  for (const [body, status, ok] of [
    [{ status: 'ok', service: 'drive-music-sync', protocol: 2 }, 200, true],
    [{ status: 'ok', service: 'drive-music-sync', protocol: 1 }, 200, false],
    [{ status: 'degraded', service: 'drive-music-sync', protocol: 2 }, 503, false],
    [{}, 200, false],
  ] as const) {
    const result = await musicSyncCheck({ fetch: async () => json(body, status) } as never)
    assert.equal(result.id, 'musicsync')
    assert.equal(result.ok, ok)
  }
  assert.equal((await musicSyncCheck({ fetch: async () => { throw new Error('offline') } } as never)).ok, false)
})

test('roomsCheck: only a plain "ok" from the room object passes', async () => {
  const rooms = (answer: () => Response | Promise<Response>) => ({ fetch: async () => answer() }) as never
  assert.equal((await roomsCheck(rooms(() => new Response('ok\n')), 'https://x/__health')).ok, true)
  // The old Worker's reply to a plain request: up, but not the room object.
  assert.equal((await roomsCheck(rooms(() => new Response('whiteboard rooms\n')), 'https://x/__health')).ok, false)
  assert.equal((await roomsCheck(rooms(() => new Response('ok', { status: 503 })), 'https://x/__health')).ok, false)
  assert.equal((await roomsCheck(rooms(() => { throw new Error('stuck') }), 'https://x/__health')).ok, false)
})
