/**
 * Dock's chat ("เพิ่มเติม → แชท"): the server writes a summary of each month on its last evening,
 * and answers what is typed.
 *
 *   GET  /chat              the latest messages            POST /chat {text}  → the message + the reply
 *   GET  /chat/unread       {count} of unread server posts POST /chat/read    → marks them read
 *
 * Replies: "สรุป" / "รายงาน" → this month so far, "เดือนก่อน" → last month, "ช่วย" → the commands;
 * anything else goes to an LLM when one is configured, otherwise a short note says none is.
 *   LLM_PROVIDER=cloudflare  CF_ACCOUNT_ID, CF_API_TOKEN, CF_AI_MODEL (Workers AI)
 *   LLM_PROVIDER=openai      LLM_BASE_URL (e.g. http://ollama:11434/v1), LLM_MODEL, LLM_API_KEY (any
 *                            OpenAI-compatible server: Ollama, llama.cpp, vLLM, ...)
 *
 * dock-metrics keeps only 7 days, so every evening this stores a digest of the day (server load,
 * proxy traffic, visitors); a month is summed from those. Days missed while this was down are
 * filled in from the 7-day history the next time it runs.
 * Reachable only through Dock's proxy, behind the Portainer login.
 */
import { Elysia } from 'elysia'
import { Database } from 'bun:sqlite'

const PORT = Number(process.env.PORT ?? 8795)
const METRICS_URL = process.env.METRICS_URL ?? 'http://dock-metrics:9100'
const ANALYTICS_URL = process.env.ANALYTICS_URL ?? 'http://apps-analytics:8790'
const STATUS_URL = process.env.STATUS_URL ?? 'http://apps-status:8789'
const BACKUP_URL = process.env.BACKUP_URL ?? 'http://apps-backup:8794'
const MAX_TEXT = 4000
const HOUR = 3_600_000
const DAY = 86_400_000
/** Bangkok wall clock */
const bkk = (ms: number) => new Date(ms + 7 * HOUR)
export const bkkDay = (ms: number) => bkk(ms).toISOString().slice(0, 10)
const dayStart = (day: string) => Date.parse(`${day}T00:00:00+07:00`)
const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
/** "2026-10" → "ตุลาคม 2569" */
export const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${Number(month.slice(0, 4)) + 543}`
const daysInMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
const prevMonth = (month: string) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1))
  return d.toISOString().slice(0, 7)
}

// ------------------------------------------------------------------ storage
export type Role = 'user' | 'assistant' | 'system'
export interface Message { id: number; ts: number; role: Role; text: string; read: number }

export function open(path = process.env.CHAT_DB ?? '/data/chat.db') {
  const db = new Database(path, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 1)`)
  db.run('CREATE TABLE IF NOT EXISTS digests (day TEXT PRIMARY KEY, data TEXT NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS reports (month TEXT PRIMARY KEY, message_id INTEGER NOT NULL)')
  return db
}

function post(db: Database, role: Role, text: string, read = role !== 'system'): Message {
  const ts = Date.now()
  const r = db.query('INSERT INTO messages (ts, role, text, read) VALUES (?, ?, ?, ?) RETURNING id').get(ts, role, text, read ? 1 : 0) as { id: number }
  return { id: r.id, ts, role, text, read: read ? 1 : 0 }
}

// ------------------------------------------------------------------ daily digest
type Col = (number | null)[]
interface MetricsPayload {
  step: number
  times: number[]
  host: Record<string, Col>
  nginx: Record<string, Record<string, Col>>
  snapshot: { mem_total: number; disk_used: number; disk_total: number; cpus: number }
}
interface AnalyticsPayload { series: { day: string; views: number; visitors: number }[]; perHost: { key: string; views: number; visitors: number }[]; totals: { views: number; visitors: number } }

export interface Digest {
  day: string
  /** share of the day with samples (0–1) */
  coverage: number
  cpuAvg: number | null
  cpuMax: number | null
  memAvg: number | null
  memTotal: number
  diskUsed: number
  diskTotal: number
  netRx: number
  netTx: number
  requests: Record<string, { req: number; s4: number; s5: number; bytes: number }>
  views: number
  visitors: number
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** One Bangkok day out of dock-metrics' 7-day history (10-minute steps). */
export function digestDay(day: string, m: MetricsPayload, a: AnalyticsPayload | null): Digest | null {
  const from = dayStart(day) / 1000
  const to = from + 86_400
  const idx = m.times.flatMap((t, i) => (t >= from && t < to ? [i] : []))
  if (!idx.length) return null
  const h = m.host
  const cpu = idx.map((i) => {
    const u = num(h.cpu_user?.[i]); const s = num(h.cpu_system?.[i]); const w = num(h.cpu_iowait?.[i])
    return u === null ? null : u + (s ?? 0) + (w ?? 0)
  }).filter((v): v is number => v !== null)
  const mem = idx.map((i) => num(h.mem_used?.[i])).filter((v): v is number => v !== null)
  const sum = (col: Col | undefined, scale = 1) => idx.reduce((s, i) => s + (num(col?.[i]) ?? 0) * scale, 0)
  const requests: Digest['requests'] = {}
  for (const [host, cols] of Object.entries(m.nginx ?? {})) {
    if (host === 'all') continue
    const r = { req: sum(cols.req), s4: sum(cols.s4), s5: sum(cols.s5), bytes: sum(cols.bytes) }
    if (r.req) requests[host] = r
  }
  const an = a?.series.find((s) => s.day === day)
  return {
    day,
    coverage: Math.min(1, cpu.length / (86_400 / m.step)),
    cpuAvg: cpu.length ? cpu.reduce((s, v) => s + v, 0) / cpu.length : null,
    cpuMax: cpu.length ? Math.max(...cpu) : null,
    memAvg: mem.length ? mem.reduce((s, v) => s + v, 0) / mem.length : null,
    memTotal: m.snapshot.mem_total,
    diskUsed: m.snapshot.disk_used,
    diskTotal: m.snapshot.disk_total,
    netRx: sum(h.net_rx, m.step), // bytes/s × seconds per step
    netTx: sum(h.net_tx, m.step),
    requests,
    views: an?.views ?? 0,
    visitors: an?.visitors ?? 0,
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

/** Stores digests for the finished days of the last week that are still missing (today's after 23:50). */
export async function collectDigests(db: Database, now = Date.now()) {
  const m = await getJson<MetricsPayload>(`${METRICS_URL}/metrics?range=7d`)
  if (!m) return 0
  const a = await getJson<AnalyticsPayload>(`${ANALYTICS_URL}/stats?days=8`)
  const have = new Set((db.query('SELECT day FROM digests').all() as { day: string }[]).map((r) => r.day))
  const today = bkkDay(now)
  const lateEvening = bkk(now).getUTCHours() * 60 + bkk(now).getUTCMinutes() >= 23 * 60 + 50
  let added = 0
  for (let k = 6; k >= 0; k--) {
    const day = bkkDay(now - k * DAY)
    if (have.has(day) || (day === today && !lateEvening)) continue
    const d = digestDay(day, m, a)
    if (!d) continue
    db.run('INSERT OR REPLACE INTO digests (day, data) VALUES (?, ?)', [day, JSON.stringify(d)])
    added++
  }
  return added
}

// ------------------------------------------------------------------ the monthly report
const fmtBytes = (b: number | null) => {
  if (b === null || !Number.isFinite(b)) return '–'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`
}
const fmtPct = (p: number | null) => (p === null ? '–' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`)
const fmtNum = (n: number) => Math.round(n).toLocaleString('th-TH')
const site = (hn: string) => (hn === 'chakkritton.com' || hn === 'www.chakkritton.com' ? 'portfolio' : hn.replace(/\.chakkritton\.com$/, ''))

interface StatusPayload { services: { name: string; status: string; uptime90: number | null }[] }
interface BackupPayload { bundles: { name: string; created: string | number; size: number }[] }

/** The month's summary as plain text (Dock shows it with line breaks). */
export function composeReport(month: string, digests: Digest[], extra: { analytics?: AnalyticsPayload | null; status?: StatusPayload | null; backups?: BackupPayload | null; untilDay?: number }) {
  const total = extra.untilDay ?? daysInMonth(month)
  const lines: string[] = [`สรุปเดือน${monthName(month)}${extra.untilDay ? ` (ถึงวันที่ ${extra.untilDay})` : ''}`]
  if (!digests.length) {
    lines.push('', 'ยังไม่มีข้อมูลรายวันของเดือนนี้ (เก็บทุกคืนเวลา 23:50)')
  } else {
    const cpu = digests.filter((d) => d.cpuAvg !== null)
    const peak = cpu.reduce<Digest | null>((p, d) => (p === null || (d.cpuMax ?? 0) > (p.cpuMax ?? 0) ? d : p), null)
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null)
    const last = digests[digests.length - 1]
    const first = digests[0]
    lines.push('', 'เซิร์ฟเวอร์')
    lines.push(`• CPU เฉลี่ย ${fmtPct(avg(cpu.map((d) => d.cpuAvg!)))}${peak ? ` · สูงสุด ${fmtPct(peak.cpuMax)} (วันที่ ${Number(peak.day.slice(8))})` : ''}`)
    lines.push(`• หน่วยความจำเฉลี่ย ${fmtBytes(avg(digests.flatMap((d) => (d.memAvg === null ? [] : [d.memAvg]))))} จาก ${fmtBytes(last.memTotal)}`)
    const diskDelta = last.diskUsed - first.diskUsed
    lines.push(`• ดิสก์ใช้ ${fmtBytes(last.diskUsed)} จาก ${fmtBytes(last.diskTotal)} (ว่าง ${fmtBytes(last.diskTotal - last.diskUsed)}${Math.abs(diskDelta) >= 100 * 1024 ** 2 ? `, ${diskDelta > 0 ? 'เพิ่มขึ้น' : 'ลดลง'} ${fmtBytes(Math.abs(diskDelta))} ในเดือนนี้` : ''})`)
    lines.push(`• เครือข่าย รับ ${fmtBytes(digests.reduce((s, d) => s + d.netRx, 0))} · ส่ง ${fmtBytes(digests.reduce((s, d) => s + d.netTx, 0))}`)

    const hosts = new Map<string, { req: number; s4: number; s5: number; bytes: number }>()
    for (const d of digests) for (const [h, r] of Object.entries(d.requests)) {
      const t = hosts.get(h) ?? { req: 0, s4: 0, s5: 0, bytes: 0 }
      t.req += r.req; t.s4 += r.s4; t.s5 += r.s5; t.bytes += r.bytes
      hosts.set(h, t)
    }
    const all = [...hosts.values()].reduce((s, r) => ({ req: s.req + r.req, s4: s.s4 + r.s4, s5: s.s5 + r.s5, bytes: s.bytes + r.bytes }), { req: 0, s4: 0, s5: 0, bytes: 0 })
    if (all.req) {
      lines.push('', 'ทราฟฟิกผ่าน proxy')
      lines.push(`• คำขอ ${fmtNum(all.req)} · 4xx ${((all.s4 / all.req) * 100).toFixed(1)}% · 5xx ${((all.s5 / all.req) * 100).toFixed(2)}% · ส่งออก ${fmtBytes(all.bytes)}`)
      const top = [...hosts].sort((a, b) => b[1].req - a[1].req).slice(0, 5)
      lines.push(`• มากสุด: ${top.map(([h, r]) => `${site(h)} ${fmtNum(r.req)}`).join(' · ')}`)
      const bad = [...hosts].filter(([, r]) => r.req >= 50 && r.s5 / r.req >= 0.01)
      if (bad.length) lines.push(`• 5xx เกิน 1%: ${bad.map(([h, r]) => `${site(h)} ${((r.s5 / r.req) * 100).toFixed(1)}%`).join(' · ')}`)
    }
    const covered = digests.filter((d) => d.coverage >= 0.5).length
    if (covered < total) lines.push('', `(มีข้อมูลเซิร์ฟเวอร์ครบ ${covered} จาก ${total} วัน)`)
  }

  const an = extra.analytics
  if (an) {
    lines.push('', 'ผู้เข้าชมเว็บ')
    lines.push(`• ผู้เข้าชม ${fmtNum(an.totals.visitors)} · เพจวิว ${fmtNum(an.totals.views)}`)
    if (an.perHost.length) lines.push(`• ${an.perHost.slice(0, 5).map((r) => `${site(r.key)} ${fmtNum(r.visitors)} คน`).join(' · ')}`)
  }
  const st = extra.status
  if (st?.services.length) {
    const down = st.services.filter((s) => s.status !== 'up')
    const weak = st.services.filter((s) => s.uptime90 !== null && s.uptime90 < 99.5)
    lines.push('', 'สถานะบริการ')
    lines.push(down.length ? `• ตอนนี้มีปัญหา: ${down.map((s) => s.name).join(', ')}` : `• ทั้ง ${st.services.length} บริการทำงานปกติ`)
    if (weak.length) lines.push(`• uptime 90 วันต่ำกว่า 99.5%: ${weak.map((s) => `${s.name} ${s.uptime90}%`).join(', ')}`)
  }
  const bk = extra.backups
  if (bk) {
    const ms = (b: { created: string | number }) => (typeof b.created === 'number' ? b.created : Date.parse(b.created))
    const latest = [...bk.bundles].sort((a, b) => ms(b) - ms(a))[0]
    lines.push('', 'สำรองข้อมูล')
    if (!latest) lines.push('• ยังไม่มีไฟล์สำรองทั้งเซิร์ฟเวอร์ ควรสร้างใน เพิ่มเติม → สำรองข้อมูล')
    else {
      const age = Math.floor((Date.now() - ms(latest)) / DAY)
      lines.push(`• ล่าสุด ${bkkDay(ms(latest))} (${age} วันก่อน, ${fmtBytes(latest.size)})${age > 31 ? ' — เก่ากว่าหนึ่งเดือน ควรสร้างใหม่' : ''}`)
    }
  }
  return lines.join('\n')
}

export async function buildReport(db: Database, month: string, now = Date.now()) {
  const digests = (db.query('SELECT data FROM digests WHERE day LIKE ? ORDER BY day').all(`${month}-%`) as { data: string }[]).map((r) => JSON.parse(r.data) as Digest)
  const isCurrent = bkkDay(now).startsWith(month)
  const untilDay = isCurrent ? Number(bkkDay(now).slice(8)) : undefined
  // visitors: the month's own days (analytics keeps every day)
  const firstDay = `${month}-01`
  const days = Math.max(1, Math.round((now - dayStart(firstDay)) / DAY) + 1)
  const raw = await getJson<AnalyticsPayload>(`${ANALYTICS_URL}/stats?days=${Math.min(400, days)}`)
  const inMonth = raw?.series.filter((s) => s.day.startsWith(month)) ?? []
  const analytics = raw
    ? {
        ...raw,
        totals: { views: inMonth.reduce((s, r) => s + r.views, 0), visitors: inMonth.reduce((s, r) => s + r.visitors, 0) },
        // per-site numbers only cover the month exactly while it is the current one
        perHost: isCurrent && days <= 31 ? raw.perHost : [],
      }
    : null
  const [status, backups] = await Promise.all([getJson<StatusPayload>(`${STATUS_URL}/api/status`), getJson<BackupPayload>(`${BACKUP_URL}/backups`)])
  return composeReport(month, digests, { analytics, status, backups, untilDay })
}

/** On the month's last evening (or, if missed, in the first days after), post its report once. */
export async function maybePostReport(db: Database, now = Date.now()) {
  const t = bkk(now)
  const today = bkkDay(now)
  const month = today.slice(0, 7)
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes()
  const due = Number(today.slice(8)) === daysInMonth(month) && minutes >= 23 * 60 + 55 ? month
    : Number(today.slice(8)) <= 3 ? prevMonth(month) : null
  if (!due || db.query('SELECT 1 FROM reports WHERE month = ?').get(due)) return null
  // a month this service never saw (installed later) gets no report
  const any = db.query('SELECT 1 FROM digests WHERE day LIKE ? LIMIT 1').get(`${due}-%`)
  if (!any) return null
  const text = await buildReport(db, due, now)
  const msg = post(db, 'system', text)
  db.run('INSERT INTO reports (month, message_id) VALUES (?, ?)', [due, msg.id])
  return msg
}

// ------------------------------------------------------------------ replies
const HELP = [
  'พิมพ์ได้แบบนี้',
  '• สรุป — สรุปเดือนนี้ถึงวันนี้',
  '• เดือนก่อน — สรุปเดือนที่แล้ว',
  '• ช่วย — คำสั่งทั้งหมด',
  'ทุกสิ้นเดือน (23:55) ระบบจะส่งสรุปของเดือนมาที่นี่เอง',
].join('\n')

export function llmConfigured() {
  const p = process.env.LLM_PROVIDER
  if (p === 'cloudflare') return Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)
  if (p === 'openai') return Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL)
  return false
}

async function askLlm(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string> {
  const p = process.env.LLM_PROVIDER
  if (p === 'cloudflare') {
    const model = process.env.CF_AI_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: 800 }),
      signal: AbortSignal.timeout(90_000),
    })
    const j = (await res.json()) as { result?: { response?: string }; errors?: { message: string }[] }
    if (!res.ok || !j.result?.response) throw new Error(j.errors?.[0]?.message ?? `Workers AI ${res.status}`)
    return j.result.response.trim()
  }
  const res = await fetch(`${process.env.LLM_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}) },
    body: JSON.stringify({ model: process.env.LLM_MODEL, messages, max_tokens: 800 }),
    signal: AbortSignal.timeout(120_000),
  })
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
  const text = j.choices?.[0]?.message?.content
  if (!res.ok || !text) throw new Error(j.error?.message ?? `LLM ${res.status}`)
  return text.trim()
}

export async function reply(db: Database, text: string, now = Date.now()): Promise<string> {
  const t = text.trim().toLowerCase()
  if (/^(ช่วย|help|\/help|คำสั่ง)/.test(t)) return HELP
  if (/^(สรุป|รายงาน|report|\/report)/.test(t)) return buildReport(db, bkkDay(now).slice(0, 7), now)
  if (/^(เดือนก่อน|เดือนที่แล้ว|last month)/.test(t)) return buildReport(db, prevMonth(bkkDay(now).slice(0, 7)), now)
  if (!llmConfigured()) {
    return `ยังไม่ได้เชื่อม LLM จึงตอบได้เฉพาะคำสั่ง\n\n${HELP}\n\nต่อ LLM ได้ภายหลัง: Cloudflare Workers AI หรือเซิร์ฟเวอร์ที่ host เอง (ตั้งค่าใน chat.env)`
  }
  const context = await buildReport(db, bkkDay(now).slice(0, 7), now)
  const history = (db.query('SELECT role, text FROM messages WHERE role != ? ORDER BY id DESC LIMIT 12').all('system') as { role: Role; text: string }[]).reverse()
  return askLlm([
    { role: 'system', content: `คุณคือผู้ช่วยดูแลเซิร์ฟเวอร์ VPS ของเจ้าของระบบ ตอบเป็นภาษาไทย สั้น ตรงประเด็น ไม่เดา ถ้าข้อมูลไม่พอให้บอกตรง ๆ\nข้อมูลล่าสุดของระบบ:\n${context}` },
    ...history.map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text })),
  ])
}

// ------------------------------------------------------------------ HTTP
export function createApp(db = open()) {
  return new Elysia()
    .get('/health', () => ({ ok: true }))
    .get('/chat', () => ({
      messages: (db.query('SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 200) ORDER BY id').all() as Message[]),
      llm: llmConfigured(),
    }))
    .get('/chat/unread', () => db.query('SELECT COUNT(*) AS count FROM messages WHERE read = 0').get() as { count: number })
    .post('/chat/read', () => {
      db.run('UPDATE messages SET read = 1 WHERE read = 0')
      return { ok: true }
    })
    .post('/chat', async ({ body, set }) => {
      const text = typeof (body as { text?: unknown })?.text === 'string' ? (body as { text: string }).text.trim() : ''
      if (!text || text.length > MAX_TEXT) {
        set.status = 400
        return { error: `ข้อความต้องยาว 1–${MAX_TEXT} ตัวอักษร` }
      }
      const mine = post(db, 'user', text)
      let answer: string
      try {
        answer = await reply(db, text)
      } catch (err) {
        answer = `ตอบไม่ได้ตอนนี้: ${err instanceof Error ? err.message : String(err)}`
      }
      return { messages: [mine, post(db, 'assistant', answer)] }
    })
}

if (import.meta.main) {
  const db = open()
  const tick = async () => {
    try {
      await collectDigests(db)
      await maybePostReport(db)
    } catch (err) {
      console.error('chat: scheduled work failed', err)
    }
  }
  if (!db.query('SELECT 1 FROM messages LIMIT 1').get()) post(db, 'system', `สวัสดีครับ ที่นี่คือแชทของเซิร์ฟเวอร์\n\n${HELP}`)
  setTimeout(tick, 10_000)
  setInterval(tick, 5 * 60_000)
  createApp(db).listen(PORT)
  console.log(`chat on :${PORT}`)
}
