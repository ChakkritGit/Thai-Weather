import { CHECKS } from './checks'
import { bangkokDay } from './state'
import type { CheckId, Service, State } from './types'

const DAY = 24 * 60 * 60_000
type Check = (typeof CHECKS)[number]

const GROUPS = [
  { id: 'server', name: 'เซิร์ฟเวอร์' },
  { id: 'thaiweather', name: 'Thai Weather' },
  { id: 'portfolio', name: 'Portfolio' },
  { id: 'spentcost', name: 'Spent-Cost' },
  { id: 'whiteboard', name: 'Whiteboard' },
  { id: 'drivemusic', name: 'Drive Music' },
] as const
const LABEL = { up: 'ปกติ', slow: 'ช้า', down: 'ล่ม', unknown: 'ยังไม่มีข้อมูล' } as const

const REASON = {
  'http-error': 'ปลายทางตอบผิดพลาด', timeout: 'ตรวจสถานะเกินเวลาที่กำหนด',
  network: 'เชื่อมต่อปลายทางไม่ได้', 'invalid-response': 'ข้อมูลตรวจสถานะไม่ถูกต้อง',
  unhealthy: 'ปลายทางรายงานปัญหา', 'heartbeat-stale': 'งานส่งบิลยังไม่มีรอบสำเร็จภายใน 26 ชั่วโมง',
} as const

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const hhmm = (ms: number) => new Date(ms + 7 * 60 * 60_000).toISOString().slice(11, 16)
const dayMonth = (ms: number) => bangkokDay(ms).slice(8) + '/' + bangkokDay(ms).slice(5, 7) + ' ' + hhmm(ms)

/** 90-day uptime as a percentage with one decimal, or null with no data. */
function uptime90(state: State, id: CheckId): number | null {
  let ok = 0
  let total = 0
  for (const [a, b] of Object.values(state.days[id] ?? {})) (ok += a), (total += b)
  return total ? Math.round((ok / total) * 1000) / 10 : null
}

const statusOf = (state: State, id: CheckId): Service['status'] => state.services[id]?.status ?? 'unknown'

/** What the JSON endpoint serves. Every check shows, "unknown" until it first runs. */
export function summary(state: State, now: number, checks: Check[] = CHECKS) {
  return {
    services: checks.map((c) => {
      const s = state.services[c.id]
      return { id: c.id, name: c.name, group: c.group, status: statusOf(state, c.id), ms: s?.ms ?? 0, since: s?.since ?? 0, uptime90: uptime90(state, c.id), reason: s?.reason ?? null, httpStatus: s?.httpStatus ?? null, detail: s?.detail ?? null, checkedAt: s?.checkedAt ?? 0 }
    }),
    incidents: recent(state, now).map((i) => ({ name: nameOf(checks, i.id), start: i.start, end: i.end ?? null })),
    lastRun: state.lastRun,
  }
}

const nameOf = (checks: Check[], id: CheckId) => checks.find((c) => c.id === id)?.name ?? id
const recent = (state: State, now: number) =>
  state.incidents.filter((i) => i.end === undefined || now - i.end <= 7 * DAY).sort((a, b) => b.start - a.start)

/** The portfolio's mark, so the page reads as part of chakkritton.com. Also the favicon. */
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="#0000FF"/><path d="M44 18.7H20v26.6h24" fill="none" stroke="#FFFFFF" stroke-width="6.7" stroke-linecap="square"/></svg>'

const thaiDate = (ms: number) =>
  new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' }).format(ms)

/** Minutes of open or closed incidents inside one Bangkok day. Incidents are kept 7 days, so older days have none. */
function downMinutes(state: State, id: CheckId, day: string, now: number): number {
  const start = Date.parse(`${day}T00:00:00+07:00`)
  const end = start + DAY
  let total = 0
  for (const i of state.incidents) {
    if (i.id !== id) continue
    const a = Math.max(start, i.start)
    const b = Math.min(end, i.end ?? now)
    if (b > a) total += b - a
  }
  return Math.round(total / 60_000)
}

/** One bar per Bangkok day, oldest first. The tooltip reads the data attributes; the label is for screen readers. */
function strip(state: State, id: CheckId, now: number): string {
  const days = state.days[id] ?? {}
  let out = ''
  for (let i = 89; i >= 0; i--) {
    const at = now - i * DAY
    const day = bangkokDay(at)
    const c = days[day]
    const ratio = c && c[1] ? c[0] / c[1] : null
    const cls = ratio === null ? 'none' : ratio === 1 ? 'ok' : ratio >= 0.9 ? 'warn' : 'bad'
    const pct = ratio === null ? 'ไม่มีข้อมูล' : `${Math.round(ratio * 1000) / 10}%`
    const down = downMinutes(state, id, day, now)
    // Incidents give the minutes; past their 7 days, each failed 5-minute check stands for 5 minutes.
    const failed = c ? c[1] - c[0] : 0
    const note = ratio === null ? 'ยังไม่มีข้อมูล' : down || failed ? `ล่มราว ${down || failed * 5} นาที` : 'ไม่มีช่วงที่ล่ม'
    const date = thaiDate(at)
    out += `<i class="bar ${cls}" role="img" tabindex="0" data-d="${esc(date)}" data-u="${esc(pct)}" data-n="${esc(note)}" aria-label="${esc(`${date}: ${pct}, ${note}`)}"></i>`
  }
  return out
}

const SITE = 'https://status.chakkritton.com'
const DESCRIPTION = 'สถานะการทำงานและ uptime ย้อนหลัง 90 วันของทุกแอปบน chakkritton.com ตรวจทุก 5 นาที'
/** share image (1200×630), shipped next to this file */
const ROBOTS = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc><changefreq>always</changefreq></url></urlset>\n`
const llms = (checks: Check[]) => `# สถานะระบบ · chakkritton.com

> Status page for the apps on chakkritton.com: whether each one is up, its response time and 90 days of uptime. Checked every 5 minutes.

## Checked services

${checks.map((c) => `- ${c.name}`).join('\n')}

## Data

- [Current status as JSON](${SITE}/api/status): overall state and each service's status
- [Status page](${SITE}/)

## Related

- [Author: Chakkrit Laolit](https://chakkritton.com)
`
const text = (body: string, type: string) =>
  new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'public, max-age=3600' } })

const BANNER = { ok: 'ทุกระบบปกติ', slow: 'บางระบบตอบช้า', down: 'มีบางระบบล่ม', none: 'ยังไม่มีข้อมูล' } as const

export function render(state: State, now: number, checks: Check[] = CHECKS): string {
  const down = checks.filter((c) => statusOf(state, c.id) === 'down')
  const slow = checks.filter((c) => statusOf(state, c.id) === 'slow')
  const tone = !state.lastRun ? 'none' : down.length ? 'down' : slow.length ? 'slow' : 'ok'
  const named = tone === 'down' ? down : tone === 'slow' ? slow : []
  const head = named.length ? `${BANNER[tone]}: ${named.map((c) => c.name).join(', ')}` : BANNER[tone]
  const checked = state.lastRun ? `อัปเดตล่าสุด ${hhmm(state.lastRun)} · อัปเดตทุก 5 นาที` : 'ข้อมูลชุดแรกจะมาภายใน 5 นาที'
  // SVG, not text glyphs: a glyph sits on the font's baseline and was off centre in the circle.
  const path = {
    ok: 'M5 12.5l4.5 4.5L19 7.5',
    slow: 'M12 6v7M12 17.5v.5',
    down: 'M7 7l10 10M17 7 7 17',
    none: 'M7 12h.01M12 12h.01M17 12h.01',
  }[tone]
  const icon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`

  const groups = GROUPS.map((g) => {
    const rows = checks
      .filter((c) => c.group === g.id)
      .map((c) => {
        const st = statusOf(state, c.id)
        const up = uptime90(state, c.id)
        const service = state.services[c.id]
        const ms = service?.ms
        const detail = service?.reason ? `${REASON[service.reason]}${service.httpStatus ? ` (HTTP ${service.httpStatus})` : ''}${service.detail ? `: ${service.detail}` : ''}` : ''
        return `<li class="row">
<div class="head"><b>${esc(c.name)}</b><span class="st ${st}">${esc(LABEL[st])}${st !== 'unknown' && ms ? ` <small>${esc(ms)} ms</small>` : ''}</span></div>
${detail ? `<p class="check-detail">${esc(detail)}</p>` : ''}
<div class="strip">${strip(state, c.id, now)}</div>
<div class="axis"><span class="d90">90 วันก่อน</span><span class="d30">30 วันก่อน</span><span class="rule"></span><span>${up === null ? 'ยังไม่มีข้อมูล' : `uptime ${esc(up.toFixed(1))}%`}</span><span class="rule"></span><span>วันนี้</span></div>
</li>`
      })
      .join('')
    return `<section><h2>${esc(g.name)}</h2><ul class="card">${rows}</ul></section>`
  }).join('')

  const inc = recent(state, now)
  const incidents = inc.length
    ? `<ul class="card inc">${inc.map((i) => `<li><b>${esc(nameOf(checks, i.id))}</b><span>${esc(dayMonth(i.start))} - ${i.end === undefined ? '<em>ยังไม่กลับมา</em>' : esc(dayMonth(i.end))}</span></li>`).join('')}</ul>`
    : '<p class="card empty">ไม่มีเหตุขัดข้องใน 7 วันที่ผ่านมา</p>'

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>สถานะระบบ · chakkritton.com</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<link rel="canonical" href="${SITE}/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="chakkritton.com">
<meta property="og:locale" content="th_TH">
<meta property="og:url" content="${SITE}/">
<meta property="og:title" content="สถานะระบบ · chakkritton.com">
<meta property="og:description" content="${esc(head)} · ${esc(DESCRIPTION)}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="สถานะระบบ chakkritton.com: uptime ย้อนหลัง 90 วันของทุกแอป">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.png">
<style>
:root{--bg:#f6f6f2;--card:#fff;--fg:#1a1a17;--muted:#6b6b63;--line:#e3e3dc;--ok:#3f9d4a;--ok-strong:#2f7d39;--warn:#e0a100;--bad:#d6322e;--none:#dcdcd4;--tip:#1a1a17;--tip-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1b1b19;--fg:#ecece6;--muted:#9a9a90;--line:#2c2c29;--ok:#4cb85a;--ok-strong:#2f7d39;--warn:#f0b429;--bad:#ff6b66;--none:#34342f;--tip:#ecece6;--tip-fg:#121211}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,'Segoe UI','Noto Sans Thai',sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none;font-weight:700;font-size:1.35rem}
.brand svg{width:36px;height:36px;display:block}
.brand span small{display:block;font-weight:500;font-size:.8rem;color:var(--muted)}
.site{font-size:.875rem;color:var(--fg);border:1.5px solid var(--fg);padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600}
.site:hover{background:var(--fg);color:var(--bg)}
.banner{margin:32px 0 6px;padding:18px 22px;border-radius:10px;color:#fff;font-size:1.2rem;font-weight:600;display:flex;gap:12px;align-items:center}
.banner i{font-style:normal;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:rgb(255 255 255 / .22);flex:none}.banner i svg{display:block}
.banner.ok{background:var(--ok-strong)}.banner.slow{background:#9a6a00}.banner.down{background:#b42520}.banner.none{background:#5f5f58}
.checked{color:var(--muted);font-size:.875rem;margin:0 0 28px}
h2{font-size:1rem;margin:28px 0 10px}
ul{list-style:none;margin:0;padding:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0}
.row{padding:18px 20px}.row+.row{border-top:1px solid var(--line)}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}
.head b{font-weight:600}
.check-detail{margin:0 0 10px;color:var(--muted);font-size:.85rem}
.st{font-size:.9rem;white-space:nowrap}.st small{color:var(--muted);font-variant-numeric:tabular-nums}
.st.up{color:var(--ok)}.st.slow{color:var(--warn)}.st.down{color:var(--bad)}.st.unknown{color:var(--muted)}
.strip{display:flex;gap:3px;height:34px}
.bar{flex:1;min-width:0;border-radius:2px;background:var(--none);outline-offset:2px}
.bar.ok{background:var(--ok)}.bar.warn{background:var(--warn)}.bar.bad{background:var(--bad)}
.bar:hover,.bar:focus-visible{opacity:.7}
.axis{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:.8rem;color:var(--muted);white-space:nowrap}
.axis .rule{flex:1;height:1px;background:var(--line)}
.d30{display:none}
@media (max-width:640px){.strip .bar:nth-child(-n+60){display:none}.d90{display:none}.d30{display:inline}.strip{gap:2px}}
.inc li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 20px}.inc li+li{border-top:1px solid var(--line)}
.inc em{font-style:normal;color:var(--bad)}
.empty{padding:16px 20px;color:var(--muted)}
#tip{position:fixed;z-index:9;pointer-events:none;background:var(--tip);color:var(--tip-fg);border-radius:8px;padding:10px 12px;font-size:.85rem;line-height:1.45;max-width:240px;box-shadow:0 6px 24px rgb(0 0 0 / .18)}
#tip b{display:block}#tip span{opacity:.75}
</style>
</head>
<body>
<main>
<header class="top">
<a class="brand" href="https://chakkritton.com">${LOGO}<span>สถานะระบบ<small>chakkritton.com</small></span></a>
<a class="site" href="https://chakkritton.com">ไปที่เว็บไซต์ ↗</a>
</header>
<div class="banner ${tone}" role="status"><i aria-hidden="true">${icon}</i>${esc(head)}</div>
<p class="checked">${esc(checked)}</p>
${groups}
<section><h2>เหตุขัดข้องใน 7 วันที่ผ่านมา</h2>${incidents}</section>
</main>
<div id="tip" hidden></div>
<script>
(() => {
  const tip = document.getElementById('tip')
  const show = (bar) => {
    tip.replaceChildren()
    const b = document.createElement('b'); b.textContent = bar.dataset.d
    const u = document.createElement('div'); u.textContent = 'ใช้งานได้ ' + bar.dataset.u
    const n = document.createElement('span'); n.textContent = bar.dataset.n
    tip.append(b, u, n)
    tip.hidden = false
    const r = bar.getBoundingClientRect(), t = tip.getBoundingClientRect()
    const x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8)
    const y = r.top - t.height - 10 < 8 ? r.bottom + 10 : r.top - t.height - 10
    tip.style.left = x + 'px'; tip.style.top = y + 'px'
  }
  const hide = () => { tip.hidden = true }
  const pick = (e) => { const bar = e.target.closest && e.target.closest('.bar'); bar ? show(bar) : hide() }
  document.addEventListener('pointerover', pick)
  document.addEventListener('focusin', pick)
  document.addEventListener('scroll', hide, { passive: true })
  // fresh data every minute (was <meta refresh>, which reloads under the reader): only while the tab is
  // visible and no day's tooltip is open, else it waits for the next minute
  setInterval(() => { if (document.visibilityState === 'visible' && tip.hidden) location.reload() }, 60000)
})()
</script>
</body>
</html>`
}

/** The same browser hardening the sites behind NPM send; the Worker answers directly, without NPM. */
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
}

/** `og` is the share image's bytes (the Worker bundles og.png). */
export function handle(req: Request, state: State, now: number, og?: ArrayBuffer): Response {
  const res = route(req, state, now, og)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value)
  return res
}

function route(req: Request, state: State, now: number, og?: ArrayBuffer): Response {
  const path = new URL(req.url).pathname
  if (path === '/api/status') {
    return new Response(JSON.stringify(summary(state, now)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } })
  }
  if (path === '/favicon.svg' || path === '/favicon.ico') {
    return new Response(LOGO, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } })
  }
  if (path === '/og.png' && og) return new Response(og, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
  if (path === '/robots.txt') return text(ROBOTS, 'text/plain')
  if (path === '/sitemap.xml') return text(SITEMAP, 'application/xml')
  if (path === '/llms.txt') return text(llms(CHECKS), 'text/plain')
  if (path === '/') return new Response(render(state, now), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } })
  return new Response('not found', { status: 404 })
}
