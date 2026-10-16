// Run: bun test src/status/state.test.ts   (from deploy/apps/services/)
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { apply, bangkokDay, emptyState } from './state'
import type { Result, State } from './types'

const T = Date.UTC(2026, 9, 2, 5, 0, 0)
const MIN = 60_000
const DAY = 24 * 60 * MIN
const ok = (ms = 100): Result => ({ id: 'portfolio', ok: true, ms })
const bad: Result = { id: 'portfolio', ok: false, ms: 10000 }
const run = (s: State, r: Result[], at: number) => apply(s, r, at)

test('one failure: no alert, status unchanged', () => {
  const s1 = run(emptyState(), [ok()], T).state
  const { state, alerts } = run(s1, [bad], T + 5 * MIN)
  assert.equal(alerts.length, 0)
  assert.equal(state.services.portfolio!.status, 'up')
  assert.equal(state.services.portfolio!.fails, 1)
})

test('two failures: down, one alert, one open incident; a third gives no second alert', () => {
  let s = run(emptyState(), [ok()], T).state
  s = run(s, [bad], T + 5 * MIN).state
  const two = run(s, [bad], T + 10 * MIN)
  assert.deepEqual(two.alerts, [{ id: 'portfolio', kind: 'down' }])
  assert.equal(two.state.services.portfolio!.status, 'down')
  assert.equal(two.state.services.portfolio!.since, T + 10 * MIN)
  assert.deepEqual(two.state.incidents, [{ id: 'portfolio', start: T + 10 * MIN }])
  const three = run(two.state, [bad], T + 15 * MIN)
  assert.equal(three.alerts.length, 0)
  assert.equal(three.state.incidents.length, 1)
  assert.equal(three.state.services.portfolio!.since, T + 10 * MIN)
})

test('recovery: up, alert with minutes, incident closed', () => {
  let s = run(emptyState(), [bad], T).state
  s = run(s, [bad], T + 5 * MIN).state
  const r = run(s, [ok()], T + 25 * MIN)
  assert.deepEqual(r.alerts, [{ id: 'portfolio', kind: 'up', minutes: 20 }])
  assert.equal(r.state.services.portfolio!.status, 'up')
  assert.equal(r.state.services.portfolio!.fails, 0)
  assert.equal(r.state.incidents[0].end, T + 25 * MIN)
})

test('slow is two answers in a row above 3000 ms and raises no alert', () => {
  const once = run(emptyState(), [ok(3001)], T)
  assert.equal(once.state.services.portfolio!.status, 'up')
  const r = run(once.state, [ok(3001)], T + 5 * MIN)
  assert.equal(r.state.services.portfolio!.status, 'slow')
  assert.equal(r.alerts.length, 0)
  assert.equal(run(r.state, [ok(3000)], T + 10 * MIN).state.services.portfolio!.status, 'up')
  const s2 = run(emptyState(), [ok(3000)], T).state
  assert.equal(run(s2, [ok(3000)], T + 5 * MIN).state.services.portfolio!.status, 'up')
})

test('an id not in results is untouched and not counted', () => {
  const s = run(emptyState(), [{ id: 'ai', ok: true, ms: 5 }], T).state
  const r = run(s, [ok()], T + 5 * MIN).state
  assert.deepEqual(r.services.ai, s.services.ai)
  assert.deepEqual(r.days.ai, s.days.ai)
})

test('day buckets count, and roll over at Bangkok midnight', () => {
  assert.equal(bangkokDay(Date.UTC(2026, 9, 2, 16, 59, 59)), '2026-10-02')
  assert.equal(bangkokDay(Date.UTC(2026, 9, 2, 17, 0, 0)), '2026-10-03')
  const before = Date.UTC(2026, 9, 2, 16, 59, 59)
  let s = run(emptyState(), [ok()], before).state
  s = run(s, [bad], before).state
  s = run(s, [ok()], before + 1000).state
  assert.deepEqual(s.days.portfolio, { '2026-10-02': [1, 2], '2026-10-03': [1, 1] })
})

test('only the last 90 days are kept', () => {
  let s = emptyState()
  for (let i = 0; i < 91; i++) s = run(s, [ok()], T + i * DAY).state
  const keys = Object.keys(s.days.portfolio!)
  assert.equal(keys.length, 90)
  assert.equal(keys.includes(bangkokDay(T)), false)
  assert.equal(keys.includes(bangkokDay(T + 90 * DAY)), true)
})

test('closed incidents older than 7 days are dropped; open ones stay', () => {
  const now = T + 40 * DAY
  const s: State = {
    ...emptyState(),
    incidents: [
      { id: 'portfolio', start: 0, end: now - 7 * DAY - 1 },
      { id: 'portfolio', start: 0, end: now - 7 * DAY },
      { id: 'rooms', start: now - 30 * DAY },
    ],
  }
  const r = run(s, [], now).state
  assert.deepEqual(r.incidents.map((i) => i.id + ':' + i.end), ['portfolio:' + (now - 7 * DAY), 'rooms:undefined'])
  assert.equal(r.lastRun, now)
})

test('the input state is not mutated', () => {
  let s = run(emptyState(), [bad], T).state
  s = run(s, [bad], T + 5 * MIN).state
  const frozen = JSON.stringify(s)
  run(s, [ok()], T + 10 * MIN)
  run(s, [bad], T + 10 * MIN)
  assert.equal(JSON.stringify(s), frozen)
})

test('failure diagnostics survive state updates and clear on recovery', () => {
  const failed: Result = { id: 'reminders', ok: false, ms: 20_000, reason: 'timeout' }
  const state = run(emptyState(), [failed], T).state
  assert.equal(state.services.reminders?.reason, 'timeout')
  const recovered = run(state, [{ id: 'reminders', ok: true, ms: 100 }], T + 5 * MIN).state
  assert.equal(recovered.services.reminders?.reason, undefined)
})
