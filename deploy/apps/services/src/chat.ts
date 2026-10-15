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
 * POST /chat/alert (x-alert-secret = ALERT_SECRET): the status service's "X ล่ม" / "X กลับมาแล้ว", posted
 * as a server message and pushed.
 * Web Push: Dock subscribes a device (POST /chat/push/subscribe) and the monthly report is pushed to it.
 * Encrypted per RFC 8291 (aes128gcm) and signed with a VAPID key the service makes on first use.
 * Reachable only through Dock's proxy, behind the Portainer login.
 */
import { Elysia } from 'elysia'
import { Database } from 'bun:sqlite'
import { importJWK, SignJWT, type JWK } from 'jose'
import { timingSafeEqual } from 'node:crypto'

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
/** what a server post is about, so Dock can draw an icon for it: a service down / back up, a month's report */
export type Kind = 'down' | 'up' | 'report' | null
export interface Message { id: number; ts: number; role: Role; text: string; read: number; kind: Kind; data?: ReportData | null }

export function open(path = process.env.CHAT_DB ?? '/data/chat.db') {
  const db = new Database(path, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 1)`)
  const cols = (db.query("SELECT name FROM pragma_table_info('messages')").all() as { name: string }[]).map((c) => c.name)
  if (!cols.includes('kind')) db.run('ALTER TABLE messages ADD COLUMN kind TEXT')
  if (!cols.includes('data')) db.run('ALTER TABLE messages ADD COLUMN data TEXT') // a report's figures, for Dock's charts
  db.run('CREATE TABLE IF NOT EXISTS digests (day TEXT PRIMARY KEY, data TEXT NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS reports (month TEXT PRIMARY KEY, message_id INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function post(db: Database, role: Role, text: string, kind: Kind = null, read = role !== 'system', data: ReportData | null = null): Message {
  const ts = Date.now()
  const r = db.query('INSERT INTO messages (ts, role, text, read, kind, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .get(ts, role, text, read ? 1 : 0, kind, data ? JSON.stringify(data) : null) as { id: number }
  return { id: r.id, ts, role, text, read: read ? 1 : 0, kind, data }
}
const parsed = (rows: (Omit<Message, 'data'> & { data?: string | null })[]): Message[] =>
  rows.map((m) => ({ ...m, data: m.data ? (JSON.parse(m.data) as ReportData) : null }))

const PAGE = 30
/**
 * One page of the conversation, oldest first: the latest PAGE, or the PAGE before `before` (scrolling
 * up), or everything after `after` (polling for new ones). `hasMore` says whether older ones exist.
 */
export function page(db: Database, { before, after, limit = PAGE }: { before?: number; after?: number; limit?: number }) {
  const n = Math.min(100, Math.max(1, limit))
  let rows: Message[]
  if (after !== undefined) rows = parsed(db.query('SELECT * FROM messages WHERE id > ? ORDER BY id LIMIT 500').all(after) as Message[] as never)
  else rows = parsed((db.query(`SELECT * FROM messages ${before !== undefined ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(before !== undefined ? [before, n] : [n])) as never[]).reverse())
  const first = rows[0]?.id ?? before
  const hasMore = first !== undefined && after === undefined ? Boolean(db.query('SELECT 1 FROM messages WHERE id < ? LIMIT 1').get(first)) : false
  return { messages: rows, hasMore }
}

// ------------------------------------------------------------------ web push
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'https://docker.chakkritton.com'
const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url')
const unb64u = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(s, 'base64url'))
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** The service's VAPID key pair, made once and kept in the database. */
export async function vapidKeys(db: Database): Promise<{ publicKey: string; privateJwk: JWK }> {
  const row = db.query("SELECT value FROM settings WHERE key = 'vapid'").get() as { value: string } | null
  if (row) return JSON.parse(row.value)
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const keys = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JWK }
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)", [JSON.stringify(keys)])
  return keys
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/** RFC 8291 message encryption (one aes128gcm record). `salt` and `sender` are for the RFC's test vector. */
export async function encryptPush(plain: Uint8Array<ArrayBuffer>, p256dh: string, auth: string, salt = crypto.getRandomValues(new Uint8Array(16)), sender?: CryptoKeyPair) {
  const uaPublic = unb64u(p256dh)
  const as = sender ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair)
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256))
  const enc = new TextEncoder()
  const ikm = await hkdf(unb64u(auth), shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plain, new Uint8Array([2]))))
  const header = new Uint8Array(16 + 4 + 1 + 65)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = 65
  header.set(asPublic, 21)
  return concat(header, ct)
}

export interface PushSub { endpoint: string; p256dh: string; auth: string }
export interface PushMessage { title: string; body: string; url: string; tag?: string }

/** Sends to one device; a subscription the push service no longer knows (404/410) is dropped. */
export async function sendPush(db: Database, sub: PushSub, msg: PushMessage): Promise<number> {
  const { publicKey, privateJwk } = await vapidKeys(db)
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(new URL(sub.endpoint).origin)
    .setExpirationTime('12h')
    .setSubject(VAPID_SUBJECT)
    .sign(await importJWK(privateJwk, 'ES256'))
  const body = await encryptPush(new TextEncoder().encode(JSON.stringify(msg)), sub.p256dh, sub.auth)
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: `vapid t=${jwt}, k=${publicKey}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 404 || res.status === 410) db.run('DELETE FROM push_subs WHERE endpoint = ?', [sub.endpoint])
  return res.status
}

export async function pushAll(db: Database, msg: PushMessage) {
  const subs = db.query('SELECT endpoint, p256dh, auth FROM push_subs').all() as PushSub[]
  const results = await Promise.allSettled(subs.map((s) => sendPush(db, s, msg)))
  return results.map((r) => (r.status === 'fulfilled' ? r.value : 0))
}

/** only the push services browsers use; anything else is refused (it would make this server fetch it) */
export function allowedEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint)
    return u.protocol === 'https:' && /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(u.hostname)
  } catch {
    return false
  }
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

/** A report's figures for Dock's card: tiles, daily CPU and visitors, traffic per site, recommendations. */
export interface ReportData {
  month: string
  title: string
  tiles: { label: string; value: string; sub?: string; tone?: 'warn' | 'bad' }[]
  cpu: { day: string; avg: number | null; max: number | null }[]
  visitors: { day: string; visitors: number; views: number }[]
  sites: { site: string; requests: number; errorsPct: number }[]
  tips: { level: 'bad' | 'warn' | 'info' | 'ok'; text: string }[]
}

export function reportData(
  month: string,
  digests: Digest[],
  extra: { visitorsDaily?: { day: string; visitors: number; views: number }[]; totals?: { visitors: number; views: number } | null; status?: StatusPayload | null; backups?: BackupPayload | null; untilDay?: number },
): ReportData {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const cpuAvg = avg(digests.flatMap((d) => (d.cpuAvg === null ? [] : [d.cpuAvg])))
  const peak = digests.reduce<Digest | null>((p, d) => (d.cpuMax !== null && (p === null || d.cpuMax > (p.cpuMax ?? 0)) ? d : p), null)
  const memAvg = avg(digests.flatMap((d) => (d.memAvg === null ? [] : [d.memAvg])))
  const last = digests[digests.length - 1]
  const first = digests[0]
  const memPct = memAvg !== null && last ? (memAvg / last.memTotal) * 100 : null
  const diskPct = last ? (last.diskUsed / last.diskTotal) * 100 : null
  const sites = new Map<string, { req: number; s5: number }>()
  for (const d of digests) for (const [h, r] of Object.entries(d.requests)) {
    const t = sites.get(h) ?? { req: 0, s5: 0 }
    t.req += r.req
    t.s5 += r.s5
    sites.set(h, t)
  }
  const all = [...sites.values()].reduce((a, r) => a + r.req, 0)
  const s4 = digests.reduce((a, d) => a + Object.values(d.requests).reduce((b, r) => b + r.s4, 0), 0)

  const tips: ReportData['tips'] = []
  if (diskPct !== null && diskPct >= 80) tips.push({ level: 'bad', text: `ดิสก์ใช้ไป ${Math.round(diskPct)}% แล้ว ลบอิมเมจที่ไม่ได้ใช้ในหน้า "อิมเมจ" หรือขยายดิสก์` })
  else if (first && last && last.diskUsed - first.diskUsed > 1024 ** 3) tips.push({ level: 'info', text: `ดิสก์โตขึ้น ${fmtBytes(last.diskUsed - first.diskUsed)} ในเดือนนี้ ถ้าโตแบบนี้ต่อ ควรดูว่าอะไรเพิ่ม (อิมเมจ log หรือข้อมูลพยากรณ์)` })
  if (memPct !== null && memPct >= 80) tips.push({ level: 'warn', text: `หน่วยความจำใช้เฉลี่ย ${Math.round(memPct)}% ถ้าสูงต่อเนื่องอาจทำให้แอปช้าหรือถูกปิด ลองดูคอนเทนเนอร์ที่ใช้ RAM มากที่สุด` })
  if (peak?.cpuMax != null && peak.cpuMax >= 90) tips.push({ level: 'info', text: `CPU แตะ ${Math.round(peak.cpuMax)}% วันที่ ${Number(peak.day.slice(8))} ถ้าเกิดบ่อย ดูกราฟ CPU ต่อคอนเทนเนอร์ในหน้าภาพรวม` })
  for (const [h, r] of sites) if (r.req >= 50 && r.s5 / r.req >= 0.01) tips.push({ level: 'warn', text: `${site(h)} ตอบ error 5xx ${((r.s5 / r.req) * 100).toFixed(1)}% ของคำขอ ดู log ของคอนเทนเนอร์นั้น` })
  if (all >= 200 && s4 / all >= 0.15) tips.push({ level: 'info', text: `คำขอผิด (4xx) ${((s4 / all) * 100).toFixed(0)}% ส่วนใหญ่มักเป็นบอทสแกนหาไฟล์ที่ไม่มี ไม่ต้องทำอะไรถ้าเว็บใช้งานได้ปกติ` })
  for (const sv of extra.status?.services ?? []) {
    if (sv.status !== 'up') tips.push({ level: 'bad', text: `${sv.name} มีปัญหาอยู่ตอนนี้ ดูที่ status.chakkritton.com` })
    else if (sv.uptime90 !== null && sv.uptime90 < 99.5) tips.push({ level: 'warn', text: `${sv.name} uptime 90 วัน ${sv.uptime90}% ต่ำกว่าเป้า 99.5% ดูช่วงที่ล่มในหน้าสถานะ` })
  }
  const ms = (b: { created: string | number }) => (typeof b.created === 'number' ? b.created : Date.parse(b.created))
  const latest = extra.backups ? [...extra.backups.bundles].sort((a, b) => ms(b) - ms(a))[0] : undefined
  if (extra.backups && !latest) tips.push({ level: 'warn', text: 'ยังไม่มีไฟล์สำรองทั้งเซิร์ฟเวอร์ สร้างได้ที่ เพิ่มเติม → สำรองข้อมูล แล้วเก็บไว้นอกเซิร์ฟเวอร์' })
  else if (latest && Date.now() - ms(latest) > 31 * DAY) tips.push({ level: 'warn', text: `ไฟล์สำรองล่าสุดเก่ากว่าหนึ่งเดือน (${bkkDay(ms(latest))}) ควรสร้างใหม่` })
  const total = extra.untilDay ?? daysInMonth(month)
  const covered = digests.filter((d) => d.coverage >= 0.5).length
  if (digests.length && covered < total) tips.push({ level: 'info', text: `ข้อมูลเซิร์ฟเวอร์มี ${covered} จาก ${total} วัน (เก็บทุกคืน 23:50) ตัวเลขเดือนนี้จึงยังไม่ครบ` })
  if (!tips.some((t) => t.level === 'bad' || t.level === 'warn')) tips.unshift({ level: 'ok', text: 'ทุกอย่างปกติดี ไม่มีอะไรต้องทำ' })

  const tone = (p: number | null, warn: number, bad: number) => (p === null ? undefined : p >= bad ? ('bad' as const) : p >= warn ? ('warn' as const) : undefined)
  return {
    month,
    title: `สรุปเดือน${monthName(month)}${extra.untilDay ? ` (ถึงวันที่ ${extra.untilDay})` : ''}`,
    tiles: [
      { label: 'CPU เฉลี่ย', value: fmtPct(cpuAvg), sub: peak?.cpuMax != null ? `สูงสุด ${fmtPct(peak.cpuMax)} วันที่ ${Number(peak.day.slice(8))}` : undefined, tone: tone(cpuAvg, 60, 85) },
      { label: 'RAM เฉลี่ย', value: fmtBytes(memAvg), sub: last ? `จาก ${fmtBytes(last.memTotal)}` : undefined, tone: tone(memPct, 75, 90) },
      { label: 'ดิสก์', value: diskPct === null ? '–' : `${Math.round(diskPct)}%`, sub: last ? `ว่าง ${fmtBytes(last.diskTotal - last.diskUsed)}` : undefined, tone: tone(diskPct, 75, 90) },
      { label: 'ผู้เข้าชม', value: extra.totals ? fmtNum(extra.totals.visitors) : '–', sub: extra.totals ? `เพจวิว ${fmtNum(extra.totals.views)}` : undefined },
    ],
    cpu: digests.map((d) => ({ day: d.day, avg: d.cpuAvg, max: d.cpuMax })),
    visitors: extra.visitorsDaily ?? [],
    sites: [...sites].sort((a, b) => b[1].req - a[1].req).slice(0, 6).map(([h, r]) => ({ site: site(h), requests: r.req, errorsPct: r.req ? (r.s5 / r.req) * 100 : 0 })),
    tips,
  }
}

export async function buildReport(db: Database, month: string, now = Date.now()): Promise<{ text: string; data: ReportData }> {
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
  return {
    text: composeReport(month, digests, { analytics, status, backups, untilDay }),
    data: reportData(month, digests, { visitorsDaily: inMonth, totals: analytics?.totals ?? null, status, backups, untilDay }),
  }
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
  const { text, data } = await buildReport(db, due, now)
  const msg = post(db, 'system', text, 'report', false, data)
  db.run('INSERT INTO reports (month, message_id) VALUES (?, ?)', [due, msg.id])
  await pushAll(db, { title: 'Dock', body: `${text.split('\n')[0]} — แตะเพื่ออ่าน`, url: '/#/chat', tag: `report-${due}` }).catch(() => undefined)
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

export interface Reply { text: string; kind?: Kind; data?: ReportData }

export async function reply(db: Database, text: string, now = Date.now()): Promise<Reply> {
  const t = text.trim().toLowerCase()
  if (/^(ช่วย|help|\/help|คำสั่ง)/.test(t)) return { text: HELP }
  if (/^(สรุป|รายงาน|report|\/report)/.test(t)) return { ...(await buildReport(db, bkkDay(now).slice(0, 7), now)), kind: 'report' }
  if (/^(เดือนก่อน|เดือนที่แล้ว|last month)/.test(t)) return { ...(await buildReport(db, prevMonth(bkkDay(now).slice(0, 7)), now)), kind: 'report' }
  if (!llmConfigured()) {
    return { text: `ยังไม่ได้เชื่อม LLM จึงตอบได้เฉพาะคำสั่ง\n\n${HELP}\n\nต่อ LLM ได้ภายหลัง: Cloudflare Workers AI หรือเซิร์ฟเวอร์ที่ host เอง (ตั้งค่าใน chat.env)` }
  }
  const context = (await buildReport(db, bkkDay(now).slice(0, 7), now)).text
  const history = (db.query('SELECT role, text FROM messages WHERE role != ? ORDER BY id DESC LIMIT 12').all('system') as { role: Role; text: string }[]).reverse()
  return { text: await askLlm([
    { role: 'system', content: `คุณคือผู้ช่วยดูแลเซิร์ฟเวอร์ VPS ของเจ้าของระบบ ตอบเป็นภาษาไทย สั้น ตรงประเด็น ไม่เดา ถ้าข้อมูลไม่พอให้บอกตรง ๆ\nข้อมูลล่าสุดของระบบ:\n${context}` },
    ...history.map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text })),
  ]) }
}

// ------------------------------------------------------------------ HTTP
function sameSecret(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createApp(db = open()) {
  return new Elysia()
    .get('/health', () => ({ ok: true }))
    .get('/chat', ({ query }) => {
      const num = (v: unknown) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))
      return { ...page(db, { before: num(query.before), after: num(query.after), limit: num(query.limit) }), llm: llmConfigured() }
    })
    .delete('/chat', () => {
      // clears the conversation; the month reports already sent stay marked as sent
      db.run('DELETE FROM messages')
      return { ok: true }
    })
    .get('/chat/unread', () => db.query('SELECT COUNT(*) AS count FROM messages WHERE read = 0').get() as { count: number })
    .post('/chat/read', () => {
      db.run('UPDATE messages SET read = 1 WHERE read = 0')
      return { ok: true }
    })
    .post('/chat/alert', async ({ body, headers, set }) => {
      const secret = process.env.ALERT_SECRET ?? ''
      if (!secret || !sameSecret(headers['x-alert-secret'] ?? '', secret)) {
        set.status = 403
        return { error: 'forbidden' }
      }
      const a = (body as { alert?: { title?: unknown; body?: unknown; id?: unknown; kind?: unknown } })?.alert
      if (typeof a?.title !== 'string' || typeof a.body !== 'string' || a.title.length > 200 || a.body.length > 500) {
        set.status = 400
        return { error: 'bad alert' }
      }
      // no emoji: Dock draws the icon from `kind`
      const msg = post(db, 'system', `${a.title}\n${a.body}\nดูรายละเอียด: https://status.chakkritton.com`, a.kind === 'up' ? 'up' : 'down')
      // one notification per service: "back up" replaces its "down"
      const tag = `status-${typeof a.id === 'string' ? a.id.slice(0, 40) : 'x'}`
      await pushAll(db, { title: a.title, body: a.body, url: '/#/chat', tag }).catch(() => undefined)
      return { ok: true, id: msg.id }
    })
    .get('/chat/push/key', async () => ({ key: (await vapidKeys(db)).publicKey }))
    .post('/chat/push/subscribe', ({ body, set }) => {
      const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
      const ok = typeof b?.endpoint === 'string' && allowedEndpoint(b.endpoint) && typeof b.keys?.p256dh === 'string' && typeof b.keys?.auth === 'string'
      if (!ok) {
        set.status = 400
        return { error: 'subscription ไม่ถูกต้อง' }
      }
      db.run('INSERT OR REPLACE INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?)', [b.endpoint as string, b.keys!.p256dh as string, b.keys!.auth as string, Date.now()])
      return { ok: true }
    })
    .post('/chat/push/unsubscribe', ({ body }) => {
      const endpoint = (body as { endpoint?: unknown })?.endpoint
      if (typeof endpoint === 'string') db.run('DELETE FROM push_subs WHERE endpoint = ?', [endpoint])
      return { ok: true }
    })
    .post('/chat/push/test', async ({ body, set }) => {
      const endpoint = (body as { endpoint?: unknown })?.endpoint
      const sub = typeof endpoint === 'string' ? (db.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint = ?').get(endpoint) as PushSub | null) : null
      if (!sub) {
        set.status = 404
        return { error: 'ยังไม่ได้ลงทะเบียนเครื่องนี้' }
      }
      const status = await sendPush(db, sub, { title: 'Dock', body: 'เปิดการแจ้งเตือนแล้ว สรุปรายเดือนจะเด้งมาที่เครื่องนี้', url: '/#/chat', tag: 'test' })
      return { status }
    })
    .post('/chat', async ({ body, set }) => {
      const text = typeof (body as { text?: unknown })?.text === 'string' ? (body as { text: string }).text.trim() : ''
      if (!text || text.length > MAX_TEXT) {
        set.status = 400
        return { error: `ข้อความต้องยาว 1–${MAX_TEXT} ตัวอักษร` }
      }
      const mine = post(db, 'user', text)
      let answer: Reply
      try {
        answer = await reply(db, text)
      } catch (err) {
        answer = { text: `ตอบไม่ได้ตอนนี้: ${err instanceof Error ? err.message : String(err)}` }
      }
      return { messages: [mine, post(db, 'assistant', answer.text, answer.kind ?? null, true, answer.data ?? null)] }
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
  setTimeout(tick, 10_000)
  setInterval(tick, 5 * 60_000)
  createApp(db).listen(PORT)
  console.log(`chat on :${PORT}`)
}
