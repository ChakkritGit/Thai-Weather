/**
 * Web analytics for the self-hosted sites – replaces Vercel Analytics + Speed Insights, read in Dock.
 *
 * POST /_a  (each site's own origin; NPM forwards it here)  {t:'pv', p, r} or {t:'v', p, n, v}
 *   - no cookies, nothing stored about a person: a visitor is sha256(daily salt + IP + user agent),
 *     and the salt is replaced every Bangkok day, so the same person cannot be followed across days
 *   - host = the site that was visited (Host header), country from Cloudflare's CF-IPCountry
 * GET /stats?host=&days=  aggregates for Dock (reachable only from Dock, behind its Portainer login)
 */
import { Elysia } from 'elysia'
import { Database } from 'bun:sqlite'

const PORT = Number(process.env.PORT ?? 8790)
const DAY = 86_400_000
const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 400)
/** sites we count; anything else posting here is ignored */
const HOSTS = new Set(
  (process.env.HOSTS ?? 'chakkritton.com,expenses.chakkritton.com,whiteboard.chakkritton.com,drive-music.chakkritton.com,thai-weather.chakkritton.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
)
const VITALS = new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB'])

/** YYYY-MM-DD in Asia/Bangkok */
export const bkkDay = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10)

export function device(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|(Android(?!.*Mobile))/i.test(ua)) return 'tablet'
  if (/Mobi|iPhone|Android/i.test(ua)) return 'mobile'
  return 'desktop'
}

export function browser(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge'
  if (/SamsungBrowser/.test(ua)) return 'Samsung'
  if (/Line\//.test(ua)) return 'LINE'
  if (/FBAN|FBAV|Instagram/.test(ua)) return 'Facebook/IG'
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox'
  if (/Chrome|CriOS/.test(ua)) return 'Chrome'
  if (/Safari/.test(ua)) return 'Safari'
  return 'Other'
}

const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|monitor|curl|wget|python|httpx|node-fetch/i

/** keep paths short and free of query strings / fragments (they can carry personal data) */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.startsWith('/')) return null
  const path = p.split(/[?#]/)[0].slice(0, 200)
  return path || '/'
}

/** only the referring site, never the full URL; same-site navigation is not a referrer */
export function refHost(r: unknown, host: string): string | null {
  if (typeof r !== 'string' || !r) return null
  try {
    const h = new URL(r).hostname.replace(/^www\./, '')
    return h && h !== host.replace(/^www\./, '') ? h.slice(0, 100) : null
  } catch {
    return null
  }
}

export function open(path = process.env.ANALYTICS_DB ?? '/data/analytics.db') {
  const db = new Database(path, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE IF NOT EXISTS views (
    ts INTEGER NOT NULL, day TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, ref TEXT,
    country TEXT, device TEXT, browser TEXT, visitor TEXT NOT NULL)`)
  db.run('CREATE INDEX IF NOT EXISTS views_host_day ON views (host, day)')
  db.run(`CREATE TABLE IF NOT EXISTS vitals (
    ts INTEGER NOT NULL, day TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
    value REAL NOT NULL, device TEXT)`)
  db.run('CREATE INDEX IF NOT EXISTS vitals_host_day ON vitals (host, day)')
  db.run('CREATE TABLE IF NOT EXISTS salt (day TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

export function createApp(db = open()) {
  let saltDay = ''
  let salt = ''
  const todaysSalt = (now: number) => {
    const d = bkkDay(now)
    if (d !== saltDay) {
      const row = db.query('SELECT value FROM salt WHERE day = ?').get(d) as { value: string } | null
      salt = row?.value ?? crypto.randomUUID()
      if (!row) {
        db.run('DELETE FROM salt')
        db.query('INSERT INTO salt (day, value) VALUES (?, ?)').run(d, salt)
      }
      saltDay = d
    }
    return salt
  }
  const insView = db.query('INSERT INTO views VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insVital = db.query('INSERT INTO vitals VALUES (?, ?, ?, ?, ?, ?, ?)')

  // daily retention sweep
  const sweep = () => {
    const cut = bkkDay(Date.now() - KEEP_DAYS * DAY)
    db.query('DELETE FROM views WHERE day < ?').run(cut)
    db.query('DELETE FROM vitals WHERE day < ?').run(cut)
  }
  sweep()
  const timer = setInterval(sweep, DAY)
  timer.unref?.()

  return new Elysia()
    .post('/_a', async ({ request, set }) => {
      set.status = 204
      const host = (request.headers.get('host') ?? '').split(':')[0].replace(/^www\./, '').toLowerCase()
      const ua = request.headers.get('user-agent') ?? ''
      if (!HOSTS.has(host) || BOT.test(ua)) return
      let body: Record<string, unknown>
      try {
        const text = await request.text()
        if (text.length > 2000) return
        body = JSON.parse(text)
      } catch {
        return
      }
      const path = cleanPath(body.p)
      if (!path) return
      const now = Date.now()
      const day = bkkDay(now)
      const dev = device(ua)
      if (body.t === 'pv') {
        const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? ''
        const visitor = new Bun.CryptoHasher('sha256').update(`${todaysSalt(now)}|${host}|${ip}|${ua}`).digest('hex').slice(0, 16)
        const country = (request.headers.get('cf-ipcountry') ?? '').slice(0, 2).toUpperCase() || null
        insView.run(now, day, host, path, refHost(body.r, host), country === 'XX' ? null : country, dev, browser(ua), visitor)
      } else if (body.t === 'v' && typeof body.n === 'string' && VITALS.has(body.n) && typeof body.v === 'number' && Number.isFinite(body.v) && body.v >= 0 && body.v < 600_000) {
        insVital.run(now, day, host, path, body.n, body.v, dev)
      }
    })
    .get('/stats', ({ query }) => stats(db, String(query.host ?? ''), Math.min(400, Math.max(1, Number(query.days ?? 7) || 7))))
    .get('/health', () => ({ ok: true }))
}

type Row = Record<string, string | number | null>

export function stats(db: Database, hostParam: string, days: number) {
  const now = Date.now()
  const from = bkkDay(now - (days - 1) * DAY)
  const host = hostParam && HOSTS.has(hostParam) ? hostParam : ''
  const where = host ? 'day >= ? AND host = ?' : 'day >= ?'
  const args = host ? [from, host] : [from]
  const q = <T = Row>(sql: string) => db.query(sql).all(...args) as T[]

  const totals = (db.query(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor || day) AS visitors FROM views WHERE ${where}`).get(...args) ?? { views: 0, visitors: 0 }) as Row
  const series = q(`SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM views WHERE ${where} GROUP BY day ORDER BY day`)
  const top = (col: string, limit = 10) =>
    q(`SELECT ${col} AS key, COUNT(*) AS views, COUNT(DISTINCT visitor || day) AS visitors FROM views WHERE ${where} AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY views DESC LIMIT ${limit}`)
  const perHost = db.query(`SELECT host AS key, COUNT(*) AS views, COUNT(DISTINCT visitor || day) AS visitors FROM views WHERE day >= ? GROUP BY host ORDER BY views DESC`).all(from)

  // Web Vitals: 75th percentile per metric (what Speed Insights reports), per device class
  const vitals: Record<string, { p75: number; n: number; mobile: number | null; desktop: number | null }> = {}
  const p75 = (vals: number[]) => {
    if (!vals.length) return null
    vals.sort((a, b) => a - b)
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.75))]
  }
  for (const name of VITALS) {
    const rows = db.query(`SELECT value, device FROM vitals WHERE ${where} AND name = ?`).all(...args, name) as { value: number; device: string }[]
    if (!rows.length) continue
    vitals[name] = {
      p75: p75(rows.map((r) => r.value))!,
      n: rows.length,
      mobile: p75(rows.filter((r) => r.device !== 'desktop').map((r) => r.value)),
      desktop: p75(rows.filter((r) => r.device === 'desktop').map((r) => r.value)),
    }
  }
  return {
    host: host || null,
    hosts: [...HOSTS],
    days,
    from,
    totals,
    series,
    perHost,
    pages: top('path'),
    referrers: top('ref'),
    countries: top('country'),
    devices: top('device', 5),
    browsers: top('browser', 8),
    vitals,
  }
}

if (import.meta.main) {
  createApp().listen({ port: PORT, hostname: '0.0.0.0' })
  console.log(`analytics listening on :${PORT}`)
}
