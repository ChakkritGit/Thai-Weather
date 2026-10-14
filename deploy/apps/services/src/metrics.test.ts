import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { LogTail, TIERS, Tiered, logTime, normPath } from './metrics'

const MX = process.env.MX_DIR // python fixtures (see the comparison test); skipped when absent

test('log time and path normalisation', () => {
  expect(logTime('14/Oct/2026:20:07:33 +0000')).toBe(Date.UTC(2026, 9, 14, 20, 7, 33) / 1000)
  expect(logTime('14/Oct/2026:20:07:33 +0700')).toBe(Date.UTC(2026, 9, 14, 13, 7, 33) / 1000)
  expect(logTime('garbage')).toBeNaN()
  expect(normPath('/api/v1/provinces/123?x=1')).toBe('/api/v1/provinces/:n')
  expect(normPath('/c/0123456789abcdef0123/logs')).toBe('/c/:id/logs')
  expect(normPath('/_next/static/chunk.js')).toBe('/_next/*')
})

test.skipIf(!MX)('same series, top paths and saved-history format as the Python collector', () => {
  const py = JSON.parse(readFileSync(`${MX}/py.json`, 'utf8'))
  const h = new Tiered()
  const lt = new LogTail(h, '/nonexistent')
  const T0 = 1792000000
  for (let i = 0; i < 50; i++) h.add(T0 + i * 7, { cpu_user: (i % 13) * 1.5, mem_used: 1000 + i })
  for (const l of [
    '[14/Oct/2026:20:07:33 +0000] - 200 200 - GET https thai-weather.chakkritton.com "/api/v1/meta?x=1" [Client 1.2.3.4] [Length 512] [Gzip -] [Sent-to api] "UA" "-"',
    '[14/Oct/2026:20:07:40 +0000] - 404 404 - GET https thai-weather.chakkritton.com "/nope/123" [Client 5.6.7.8] [Length 20] [Gzip -] [Sent-to api] "UA" "-"',
    '[14/Oct/2026:20:08:01 +0000] - 200 200 - GET https docker.chakkritton.com "/_next/static/x.js" [Client 1.2.3.4] [Length 900] [Gzip -] [Sent-to x] "UA" "-"',
  ]) lt.ingest(l, false, null)
  lt.ingest('[14/Oct/2026:20:09:00 +0000] 444 - GET http 117.18.127.246 "/" [Client 9.9.9.9] [Length 0] [Gzip -] "UA" "-"', true, null)
  const now = 1792009800
  for (const r of Object.keys(TIERS)) expect(h.series(r, now)).toEqual(py.series[r])
  const top = lt.top(now - 3600 * 24)
  expect(top.unique_clients).toBe(py.top.unique_clients)
  const sortKey = (p: any) => `${p.count}|${p.host}|${p.path}|${p.method}`
  expect(top.paths.map(sortKey).sort()).toEqual(py.top.paths.map(sortKey).sort())

  // a history file written by the Python collector loads and gives the same series
  const saved = JSON.parse(gunzipSync(readFileSync(`${MX}/py-history.json.gz`)).toString())
  const h2 = new Tiered()
  h2.load(saved.hist)
  for (const r of Object.keys(TIERS)) expect(h2.series(r, now)).toEqual(py.series[r])
  expect(JSON.parse(JSON.stringify(h2.dump()))).toEqual(saved.hist)
})
