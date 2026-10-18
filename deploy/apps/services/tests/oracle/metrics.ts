// Frozen Bun compatibility oracle for the Rust collector; never copied into a runtime image.
/**
 * Dock metrics collector – host, container and Nginx Proxy Manager traffic history (Bun + Elysia port
 * of the former Python collector; same /metrics payload and the same saved history file).
 *
 * Reads, read-only:
 *   /host/proc        host procfs          → CPU, memory, swap, load, network, disk I/O, uptime
 *   /host/cgroup      host cgroup v2       → per-container CPU, memory, block I/O (docker-<id>.scope)
 *   /host/hostname    a host file          → hostname; statfs of it gives the root filesystem usage
 *   /host/os-release  the host's /etc/os-release
 *   /npm-logs         NPM's log directory  → requests, status codes and bytes per proxy host
 * No Docker socket: containers are reported by id; the page maps ids to names via Portainer.
 *
 * History tiers: 1 h at 10 s, 24 h at 1 min, 7 d at 10 min. Saved to /data every 5 minutes.
 * Serves GET /metrics?range=1h|24h|7d on :9100 (reachable only through the dock proxy, behind
 * Portainer authentication).
 */
import { Elysia } from 'elysia'
import { closeSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, statfsSync, writeFileSync, mkdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const PROC = process.env.HOST_PROC ?? '/host/proc'
const CGROUP = process.env.HOST_CGROUP ?? '/host/cgroup'
const HOSTFILE = process.env.HOST_FILE ?? '/host/hostname'
const LOGS = process.env.NPM_LOGS ?? '/npm-logs'
const DATA = process.env.DATA_DIR ?? '/data'
const PORT = Number(process.env.PORT ?? 9100)
const SAMPLE_S = 5
const SAVE_EVERY_S = 300
export const TIERS: Record<string, [step: number, points: number]> = { '1h': [10, 360], '24h': [60, 1440], '7d': [600, 1008] }

/** Gauges are averaged inside a bucket, counters (ng:*) summed. */
const isCounter = (key: string) => key.startsWith('ng:')

type Acc = [sum: number, count: number]
export class Tiered {
  // tier -> bucket start -> field -> [sum, count]
  buckets: Record<string, Map<number, Map<string, Acc>>> = Object.fromEntries(Object.keys(TIERS).map((k) => [k, new Map()]))

  add(ts: number, values: Record<string, number>) {
    for (const [tier, [step]] of Object.entries(TIERS)) {
      const start = Math.floor(ts / step) * step
      let b = this.buckets[tier].get(start)
      if (!b) this.buckets[tier].set(start, (b = new Map()))
      for (const [k, v] of Object.entries(values)) {
        const acc = b.get(k)
        if (acc) {
          acc[0] += v
          acc[1] += 1
        } else b.set(k, [v, 1])
      }
    }
  }

  prune(now: number) {
    for (const [tier, [step, n]] of Object.entries(TIERS)) {
      const oldest = now - step * n
      for (const t of this.buckets[tier].keys()) if (t < oldest) this.buckets[tier].delete(t)
    }
  }

  series(tier: string, now: number): [number[], Record<string, (number | null)[]>] {
    const [step, n] = TIERS[tier]
    const end = Math.floor(now / step) * step
    const times = Array.from({ length: n }, (_, i) => end - step * (n - 1) + i * step)
    const b = this.buckets[tier]
    const keys = new Set<string>()
    for (const bucket of b.values()) for (const k of bucket.keys()) keys.add(k)
    const out: Record<string, (number | null)[]> = {}
    for (const k of [...keys].sort()) {
      const counter = isCounter(k)
      out[k] = times.map((t) => {
        const acc = b.get(t)?.get(k)
        if (!acc) return counter && b.has(t) ? 0 : null
        return Math.round((counter ? acc[0] : acc[0] / acc[1]) * 1e4) / 1e4
      })
    }
    return [times, out]
  }

  dump() {
    return Object.fromEntries(Object.entries(this.buckets).map(([tier, b]) => [tier, Object.fromEntries([...b].map(([t, m]) => [String(t), Object.fromEntries(m)]))]))
  }

  load(d: Record<string, Record<string, Record<string, Acc>>>) {
    for (const tier of Object.keys(TIERS)) {
      this.buckets[tier] = new Map(Object.entries(d[tier] ?? {}).map(([t, m]) => [Number(t), new Map(Object.entries(m))]))
    }
  }
}

// ------------------------------------------------------------------ host
const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const lines = (s: string) => s.split('\n').filter(Boolean)
const words = (s: string) => s.trim().split(/\s+/)

/** user nice system idle iowait irq softirq steal */
const cpuTimes = () => words(lines(read(join(PROC, 'stat')))[0] ?? '').slice(1, 9).map(Number)

function meminfo(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines(read(join(PROC, 'meminfo')))) {
    const [k, rest] = line.split(':')
    out[k] = Number(words(rest)[0]) * 1024
  }
  return out
}

/** bytes received / sent on the physical interface(s) of the given net/dev file */
function netDev(file: string, skipVirtual: boolean): [number, number] {
  let rx = 0
  let tx = 0
  for (const line of lines(read(file)).slice(2)) {
    const [rawName, rest] = line.split(':')
    const name = rawName.trim()
    if (name === 'lo' || (skipVirtual && /^(veth|br-|docker)/.test(name))) continue // count traffic once
    const f = words(rest)
    rx += Number(f[0])
    tx += Number(f[8])
  }
  return [rx, tx]
}

const DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/
function diskBytes(): [number, number] {
  let r = 0
  let w = 0
  for (const line of lines(read(join(PROC, 'diskstats')))) {
    const f = words(line)
    if (f.length > 9 && DISK_RE.test(f[2])) {
      r += Number(f[5]) * 512
      w += Number(f[9]) * 512
    }
  }
  return [r, w]
}

function hostSnapshot() {
  const mi = meminfo()
  const st = statfsSync(HOSTFILE)
  const load = words(read(join(PROC, 'loadavg')))
  const osRelease = Object.fromEntries(lines(read(join(HOSTFILE, '..', 'os-release'))).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  return {
    hostname: read(HOSTFILE).trim(),
    os: (osRelease.PRETTY_NAME ?? '').replace(/^"|"$/g, ''),
    kernel: read(join(PROC, 'sys', 'kernel', 'osrelease')).trim(),
    uptime_s: Math.floor(Number(words(read(join(PROC, 'uptime')))[0] || 0)),
    cpus: availableParallelism(),
    mem_total: mi.MemTotal ?? 0,
    mem_available: mi.MemAvailable ?? 0,
    swap_total: mi.SwapTotal ?? 0,
    swap_free: mi.SwapFree ?? 0,
    disk_total: st.blocks * st.bsize,
    disk_free: st.bavail * st.bsize,
    disk_used: (st.blocks - st.bfree) * st.bsize,
    load: load[0] ? load.slice(0, 3).map(Number) : [],
    procs: load[3] ?? '',
  }
}

// ------------------------------------------------------------------ containers (cgroup v2)
function containers(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    for (const name of readdirSync(join(CGROUP, 'system.slice'))) {
      const m = /^docker-([0-9a-f]{64})\.scope$/.exec(name)
      if (m) out.set(m[1], join(CGROUP, 'system.slice', name))
    }
  } catch {}
  return out
}

type Cg = { cpu_usec: number; mem: number; rd: number; wr: number; rx: number; tx: number }
function cgStats(d: string): Cg {
  const out: Cg = { cpu_usec: 0, mem: 0, rd: 0, wr: 0, rx: 0, tx: 0 }
  for (const line of lines(read(join(d, 'cpu.stat')))) if (line.startsWith('usage_usec')) out.cpu_usec = Number(words(line)[1])
  const mem = Number(read(join(d, 'memory.current')).trim() || 0)
  let inactive = 0
  for (const line of lines(read(join(d, 'memory.stat')))) if (line.startsWith('inactive_file ')) inactive = Number(words(line)[1])
  out.mem = Math.max(0, mem - inactive)
  for (const line of lines(read(join(d, 'io.stat')))) {
    for (const kv of words(line).slice(1)) {
      const [k, v] = kv.split('=')
      if (k === 'rbytes') out.rd += Number(v)
      else if (k === 'wbytes') out.wr += Number(v)
    }
  }
  const pid = words(read(join(d, 'cgroup.procs')))[0]
  if (pid) [out.rx, out.tx] = netDev(join(PROC, pid, 'net', 'dev'), false) // the container's network namespace
  return out
}

// ------------------------------------------------------------------ Nginx Proxy Manager logs
const LINE_RE = /^\[(?<time>[^\]]+)\] (?<cache>\S+) (?<status>\d{3}|-) (?<up>\d{3}|-) - (?<method>\S+) (?<scheme>\S+) (?<host>\S+) "(?<path>[^"]*)" \[Client (?<client>[^\]]+)\] \[Length (?<len>\d+)\]/
const FALLBACK_RE = /^\[(?<time>[^\]]+)\] (?<status>\d{3}|-) - (?<method>\S+) (?<scheme>\S+) (?<host>\S+) "(?<path>[^"]*)" \[Client (?<client>[^\]]+)\] \[Length (?<len>\d+)\]/
const ASSET_RE = /^\/_next\/|\.(js|css|png|jpg|svg|ico|woff2?|webmanifest|map)$/
const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }

/** "14/Oct/2026:20:07:33 +0000" → epoch seconds (NaN when malformed) */
export function logTime(s: string): number {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(s)
  if (!m || !MONTHS[m[2]]) return NaN
  return Date.parse(`${m[3]}-${MONTHS[m[2]]}-${m[1]}T${m[4]}${m[5]}:${m[6]}`) / 1000
}

export function normPath(path: string): string {
  let p = path.split('?')[0] || '/'
  if (p.startsWith('/_next/')) return '/_next/*'
  p = p.replace(/\/[0-9a-f]{12,64}(?=\/|$)/g, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n')
  return p.slice(0, 80)
}

export class LogTail {
  pos: Record<string, [inode: number, offset: number]> = {}
  paths = new Map<number, Map<string, number>>() // hour -> "host\0path\0method" -> count
  clients = new Map<number, Set<number>>() // hour -> client hashes (in memory only)
  constructor(private hist: Tiered, private dir = LOGS) {}

  files(): string[] {
    try {
      return readdirSync(this.dir).filter((n) => /^(proxy-host-\d+|fallback_http)_access\.log$/.test(n)).sort()
    } catch {
      return []
    }
  }

  poll(backfillSince: number | null = null) {
    for (const name of this.files()) {
      const file = join(this.dir, name)
      let st
      try {
        st = statSync(file)
      } catch {
        continue
      }
      let [inode, offset] = this.pos[name] ?? [st.ino, backfillSince ? 0 : st.size]
      if (inode !== st.ino || st.size < offset) offset = 0 // rotated or truncated
      if (st.size === offset) {
        this.pos[name] = [st.ino, offset]
        continue
      }
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(st.size - offset)
      try {
        readSync(fd, buf, 0, buf.length, offset)
      } finally {
        closeSync(fd)
      }
      const end = buf.lastIndexOf(0x0a) + 1 // only complete lines
      this.pos[name] = [st.ino, offset + end]
      const fallback = name.startsWith('fallback')
      for (const raw of buf.subarray(0, end).toString('utf8').split('\n')) if (raw) this.ingest(raw, fallback, backfillSince)
    }
  }

  ingest(line: string, fallback: boolean, since: number | null) {
    const m = (fallback ? FALLBACK_RE : LINE_RE).exec(line)?.groups
    if (!m) return
    const ts = logTime(m.time)
    if (!Number.isFinite(ts) || (since !== null && ts < since)) return
    const host = fallback ? '(ไม่ตรงโดเมน)' : m.host
    const status = /^\d+$/.test(m.status) ? Number(m.status) : 0
    const cls = status >= 200 && status < 600 ? `s${Math.floor(status / 100)}` : 's0'
    this.hist.add(ts, { [`ng:${host}:req`]: 1, [`ng:${host}:${cls}`]: 1, [`ng:${host}:bytes`]: Number(m.len), [`ng:all:${cls}`]: 1 })
    const hour = Math.floor(ts / 3600) * 3600
    if (!ASSET_RE.test(m.path.split('?')[0])) {
      let c = this.paths.get(hour)
      if (!c) this.paths.set(hour, (c = new Map()))
      const key = `${host}\0${normPath(m.path)}\0${m.method}`
      c.set(key, (c.get(key) ?? 0) + 1)
    }
    let s = this.clients.get(hour)
    if (!s) this.clients.set(hour, (s = new Set()))
    s.add(Bun.hash.crc32(m.client))
    const old = Date.now() / 1000 - 7 * 86400
    for (const h of this.paths.keys()) if (h < old) this.paths.delete(h)
    for (const h of this.clients.keys()) if (h < old) this.clients.delete(h)
  }

  top(since: number, n = 12) {
    const total = new Map<string, number>()
    const clients = new Set<number>()
    for (const [h, c] of this.paths) if (h + 3600 > since) for (const [k, v] of c) total.set(k, (total.get(k) ?? 0) + v)
    for (const [h, s] of this.clients) if (h + 3600 > since) for (const x of s) clients.add(x)
    return {
      paths: [...total].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, count]) => {
        const [host, path, method] = k.split('\0')
        return { host, path, method, count }
      }),
      unique_clients: clients.size,
    }
  }
}

// ------------------------------------------------------------------ sampler
type Sample = { t: number; cpu: number[]; net: [number, number]; disk: [number, number]; cg: Map<string, Cg> }
export class Collector {
  hist = new Tiered()
  logs = new LogTail(this.hist)
  prev: Sample | null = null
  started = Date.now() / 1000

  constructor() {
    try {
      const d = JSON.parse(gunzipSync(readFileSync(join(DATA, 'history.json.gz'))).toString())
      this.hist.load(d.hist)
      this.logs.pos = d.logpos ?? {}
      console.log('loaded saved history')
    } catch {
      // first start: backfill the last 7 days of proxy traffic from the existing logs
      this.logs.poll(Date.now() / 1000 - 7 * 86400)
      console.log('backfilled proxy logs')
    }
  }

  save() {
    mkdirSync(DATA, { recursive: true })
    const tmp = join(DATA, 'history.json.gz.tmp')
    writeFileSync(tmp, gzipSync(JSON.stringify({ hist: this.hist.dump(), logpos: this.logs.pos })))
    renameSync(tmp, join(DATA, 'history.json.gz'))
  }

  sample() {
    const now = Date.now() / 1000
    const cur: Sample = { t: now, cpu: cpuTimes(), net: netDev(join(PROC, '1', 'net', 'dev'), true), disk: diskBytes(), cg: new Map([...containers()].map(([id, d]) => [id, cgStats(d)])) }
    const prev = this.prev
    this.prev = cur
    if (!prev) return
    const dt = Math.max(1e-3, now - prev.t)
    const d = cur.cpu.map((a, i) => a - prev.cpu[i])
    const total = Math.max(1, d.reduce((a, b) => a + b, 0))
    const mi = meminfo()
    const avail = mi.MemAvailable ?? 0
    const cache = (mi.Buffers ?? 0) + (mi.Cached ?? 0) + (mi.SReclaimable ?? 0)
    const load = words(read(join(PROC, 'loadavg')))
    const v: Record<string, number> = {
      cpu_user: (100 * (d[0] + d[1])) / total,
      cpu_system: (100 * (d[2] + d[5] + d[6])) / total,
      cpu_iowait: (100 * d[4]) / total,
      cpu_steal: (100 * d[7]) / total,
      mem_used: (mi.MemTotal ?? 0) - avail,
      mem_cache: Math.max(0, Math.min(cache, avail)),
      swap_used: (mi.SwapTotal ?? 0) - (mi.SwapFree ?? 0),
      load1: load[0] ? Number(load[0]) : 0,
      net_rx: (cur.net[0] - prev.net[0]) / dt,
      net_tx: (cur.net[1] - prev.net[1]) / dt,
      disk_rd: (cur.disk[0] - prev.disk[0]) / dt,
      disk_wr: (cur.disk[1] - prev.disk[1]) / dt,
    }
    const ncpu = availableParallelism() || 1
    for (const [cid, c] of cur.cg) {
      const p = prev.cg.get(cid)
      if (!p) continue
      const short = cid.slice(0, 12)
      v[`c:${short}:cpu`] = Math.max(0, (100 * (c.cpu_usec - p.cpu_usec)) / (dt * 1e6 * ncpu))
      v[`c:${short}:mem`] = c.mem
      v[`c:${short}:rx`] = Math.max(0, c.rx - p.rx) / dt
      v[`c:${short}:tx`] = Math.max(0, c.tx - p.tx) / dt
      v[`c:${short}:rd`] = Math.max(0, c.rd - p.rd) / dt
      v[`c:${short}:wr`] = Math.max(0, c.wr - p.wr) / dt
    }
    this.hist.add(now, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Math.round(x * 1000) / 1000])))
  }

  run() {
    let lastSave = Date.now() / 1000
    const tick = () => {
      const t0 = Date.now() / 1000
      try {
        this.sample()
        this.logs.poll()
        this.hist.prune(t0)
        if (t0 - lastSave > SAVE_EVERY_S) {
          this.save()
          lastSave = t0
        }
      } catch (e) {
        console.log(`sample error: ${(e as Error).message}`) // keep sampling whatever happens
      }
      setTimeout(tick, Math.max(500, (SAMPLE_S - (Date.now() / 1000 - t0)) * 1000))
    }
    tick()
    const stop = () => {
      try {
        this.save()
      } finally {
        process.exit(0)
      }
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  }

  payload(range: string) {
    const now = Date.now() / 1000
    const [step, n] = TIERS[range]
    const [times, cols] = this.hist.series(range, now)
    const host: Record<string, (number | null)[]> = {}
    const ctr: Record<string, Record<string, (number | null)[]>> = {}
    const nginx: Record<string, Record<string, (number | null)[]>> = {}
    for (const [k, col] of Object.entries(cols)) {
      if (k.startsWith('c:')) {
        const [, cid, f] = k.split(':')
        ;(ctr[cid] ??= {})[f] = col
      } else if (k.startsWith('ng:')) {
        const rest = k.slice(3)
        const i = rest.lastIndexOf(':') // host names have dots, never colons
        ;(nginx[rest.slice(0, i)] ??= {})[rest.slice(i + 1)] = col
      } else host[k] = col
    }
    return { range, step, times, host, containers: ctr, nginx, snapshot: hostSnapshot(), top: this.logs.top(now - step * n), collector_uptime_s: Math.floor(now - this.started) }
  }
}

export function createApp(collector: Collector) {
  return new Elysia().get('/metrics', ({ query, set }) => {
    const range = String(query.range ?? '1h')
    if (!TIERS[range]) {
      set.status = 400
      return 'bad range'
    }
    return new Response(gzipSync(JSON.stringify(collector.payload(range))), {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'no-store' },
    })
  })
}
