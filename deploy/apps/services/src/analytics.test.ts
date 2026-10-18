import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { bkkDay, browser, cleanPath, createApp, device, open, refHost } from '../tests/oracle/analytics'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

test('helpers', () => {
  expect(cleanPath('/th/blog/x?token=secret#a')).toBe('/th/blog/x')
  expect(cleanPath('https://evil')).toBeNull()
  expect(refHost('https://www.google.com/search?q=me', 'chakkritton.com')).toBe('google.com')
  expect(refHost('https://chakkritton.com/en', 'chakkritton.com')).toBeNull()
  expect(device(IPHONE)).toBe('mobile')
  expect(device(MAC)).toBe('desktop')
  expect(browser(IPHONE)).toBe('Safari')
  expect(browser(MAC)).toBe('Chrome')
  expect(bkkDay(Date.UTC(2026, 9, 14, 17, 30))).toBe('2026-10-15')
})

test('page views, visitors, vitals, bots and unknown hosts', async () => {
  const db = open(':memory:')
  const app = createApp(db)
  const post = (host: string, ua: string, ip: string, body: unknown) =>
    app.handle(new Request('http://localhost/_a', { method: 'POST', headers: { host, 'user-agent': ua, 'cf-connecting-ip': ip, 'cf-ipcountry': 'TH' }, body: JSON.stringify(body) }))

  expect((await post('chakkritton.com', IPHONE, '1.1.1.1', { t: 'pv', p: '/', r: 'https://www.google.com/' })).status).toBe(204)
  await post('chakkritton.com', IPHONE, '1.1.1.1', { t: 'pv', p: '/th/projects' })
  await post('www.chakkritton.com', MAC, '2.2.2.2', { t: 'pv', p: '/' })
  await post('chakkritton.com', MAC, '2.2.2.2', { t: 'v', p: '/', n: 'LCP', v: 1800 })
  await post('chakkritton.com', IPHONE, '1.1.1.1', { t: 'v', p: '/', n: 'LCP', v: 2600 })
  await post('chakkritton.com', IPHONE, '1.1.1.1', { t: 'v', p: '/', n: 'EVIL', v: 1 })
  await post('chakkritton.com', 'Googlebot/2.1', '3.3.3.3', { t: 'pv', p: '/' })
  await post('somewhere-else.com', IPHONE, '4.4.4.4', { t: 'pv', p: '/' })

  const s = (await (await app.handle(new Request('http://localhost/stats?host=chakkritton.com&days=7'))).json()) as any
  expect(s.totals).toEqual({ views: 3, visitors: 2 })
  expect(s.referrers).toEqual([{ key: 'google.com', views: 1, visitors: 1 }])
  expect(s.countries[0].key).toBe('TH')
  expect(s.pages[0]).toEqual({ key: '/', views: 2, visitors: 2 })
  expect(s.vitals.LCP.n).toBe(2)
  expect(s.vitals.LCP.mobile).toBe(2600)
  expect(s.vitals.EVIL).toBeUndefined()
  // nothing that identifies a person is stored
  const cols = (db.query('PRAGMA table_info(views)').all() as { name: string }[]).map((c) => c.name)
  expect(cols).not.toContain('ip')
  expect(cols).not.toContain('ua')
})
