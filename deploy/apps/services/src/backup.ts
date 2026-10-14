/**
 * Full-server backup bundles for Dock's "สำรองข้อมูล" page.
 *
 * A bundle is one zip: restore.sh + README.txt + payload.enc (+ its sha256). The payload, encrypted with
 * the passphrase given when the bundle is made (AES-256-CBC, PBKDF2 600k), holds everything the server
 * needs to come back exactly as it was:
 *   db/       pg_dump of each app database (logical, consistent) + the role setup comes from env/db.env
 *   volumes/  every Docker volume except caches, anonymous volumes and the raw database files
 *   env/      /opt/apps/env/*.env and the weather stack's deploy/.env   origin-ca/  the Origin cert + key
 *   meta.json the commit of every repo, so the same code is rebuilt
 * restore.sh (deploy/apps/backup/restore.sh) puts it all back, on this server or a fresh Ubuntu one.
 *
 *   GET    /backups                  list + the running job
 *   POST   /backups {passphrase}     start a bundle (one at a time)
 *   POST   /backups/:name/link       a download link valid for 10 minutes
 *   GET    /backups/dl/:token        the file (no session needed: the token is the permission)
 *   DELETE /backups/:name
 * Only reachable through Dock, behind its Portainer login (except /dl, which needs a token from it).
 */
import { Elysia } from 'elysia'
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 8794)
const OUT = process.env.BUNDLE_DIR ?? '/bundles'
const VOLUMES = process.env.VOLUMES_DIR ?? '/volumes'
const ENV_DIR = process.env.ENV_DIR ?? '/src/env'
const TW_ENV = process.env.TW_ENV ?? '/src/thai-weather.env'
const ORIGIN = process.env.ORIGIN_DIR ?? '/src/origin-ca'
const REPOS = process.env.REPOS_DIR ?? '/src/repos'
const TW_REPO = process.env.TW_REPO ?? '/src/thai-weather'
const RESTORE = process.env.RESTORE_SCRIPT ?? '/app/backup/restore.sh'
const README = process.env.RESTORE_README ?? '/app/backup/README.txt'
const DB_HOST = process.env.DB_HOST ?? 'apps-db'
const KEEP = Number(process.env.KEEP ?? 5)
const NAME_RE = /^thai-weather-backup-\d{8}-\d{4}\.zip$/

/** Volumes left out: per-app build caches, anonymous volumes, and the raw Postgres files (dumped logically). */
export function includeVolume(name: string): boolean {
  return !/-cache$/.test(name) && !/^[0-9a-f]{64}$/.test(name) && name !== 'apps_db-data' && name !== 'apps_backup-bundles' && name !== 'metadata.db'
}

async function run(cmd: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.trim().slice(-300)}`)
}

const readEnv = async (file: string) =>
  Object.fromEntries(
    (await readFile(file, 'utf8')).split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )

/** The checked-out commit of a git repo, read from .git without running git. */
export async function gitHead(repo: string): Promise<{ commit: string; branch: string | null; url: string | null } | null> {
  const g = join(repo, '.git')
  try {
    const head = (await readFile(join(g, 'HEAD'), 'utf8')).trim()
    let commit = head
    let branch: string | null = null
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5)
      branch = ref.replace(/^refs\/heads\//, '')
      commit = existsSync(join(g, ref))
        ? (await readFile(join(g, ref), 'utf8')).trim()
        : ((await readFile(join(g, 'packed-refs'), 'utf8')).split('\n').find((l) => l.endsWith(` ${ref}`)) ?? '').split(' ')[0]
    }
    const cfg = await readFile(join(g, 'config'), 'utf8').catch(() => '')
    const url = /\[remote "origin"\][^[]*?url = (\S+)/.exec(cfg)?.[1] ?? null
    return /^[0-9a-f]{40}$/.test(commit) ? { commit, branch, url } : null
  } catch {
    return null
  }
}

type Job = { name: string; started: number; step: string; error?: string; done?: boolean }
let job: Job | null = null
const links = new Map<string, { name: string; until: number }>()

function stamp(d = new Date()) {
  const bkk = new Date(d.getTime() + 7 * 3_600_000).toISOString()
  return `${bkk.slice(0, 10).replaceAll('-', '')}-${bkk.slice(11, 16).replace(':', '')}`
}

export async function makeBundle(passphrase: string, name = `thai-weather-backup-${stamp()}.zip`) {
  job = { name, started: Date.now(), step: 'เริ่ม' }
  const work = join(OUT, `.work-${crypto.randomUUID()}`)
  try {
    const payload = join(work, 'payload')
    for (const d of ['db', 'volumes', 'env', 'origin-ca']) await mkdir(join(payload, d), { recursive: true })

    job.step = 'สำรองฐานข้อมูล'
    const db = await readEnv(join(ENV_DIR, 'db.env'))
    for (const name of ['expenses', 'portfolio']) {
      await run(['pg_dump', '-h', DB_HOST, '-U', 'postgres', '-Fc', '-f', join(payload, 'db', `${name}.dump`), name], { env: { PGPASSWORD: db.POSTGRES_PASSWORD } })
    }

    job.step = 'สำรอง volume'
    const volumes = (await readdir(VOLUMES)).filter(includeVolume).sort()
    const sizes: Record<string, number> = {}
    for (const v of volumes) {
      const data = join(VOLUMES, v, '_data')
      if (!existsSync(data)) continue
      job.step = `สำรอง volume ${v}`
      await run(['tar', '--numeric-owner', '-czf', join(payload, 'volumes', `${v}.tar.gz`), '-C', data, '.'])
      sizes[v] = (await stat(join(payload, 'volumes', `${v}.tar.gz`))).size
    }

    job.step = 'สำรองการตั้งค่า'
    for (const f of await readdir(ENV_DIR)) if (f.endsWith('.env')) await copyFile(join(ENV_DIR, f), join(payload, 'env', f))
    if (existsSync(TW_ENV)) await copyFile(TW_ENV, join(payload, 'env', 'thai-weather.deploy.env'))
    if (existsSync(ORIGIN)) for (const f of await readdir(ORIGIN)) await copyFile(join(ORIGIN, f), join(payload, 'origin-ca', f))

    const repos: Record<string, unknown> = { 'thai-weather': await gitHead(TW_REPO) }
    if (existsSync(REPOS)) for (const r of (await readdir(REPOS)).sort()) repos[r] = await gitHead(join(REPOS, r))
    await writeFile(join(payload, 'meta.json'), JSON.stringify({ created: new Date().toISOString(), format: 1, repos, volumes: sizes, databases: ['expenses', 'portfolio'] }, null, 2))

    job.step = 'เข้ารหัส'
    await run(['tar', '-cf', join(work, 'payload.tar'), '-C', payload, '.'])
    await rm(payload, { recursive: true, force: true })
    await run(['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-salt', '-in', join(work, 'payload.tar'), '-out', join(work, 'payload.enc'), '-pass', 'env:BUNDLE_PASS'], { env: { BUNDLE_PASS: passphrase } })
    await rm(join(work, 'payload.tar'))
    const hash = new Bun.CryptoHasher('sha256')
    for await (const chunk of Bun.file(join(work, 'payload.enc')).stream()) hash.update(chunk)
    await writeFile(join(work, 'payload.enc.sha256'), `${hash.digest('hex')}  payload.enc\n`)
    await copyFile(RESTORE, join(work, 'restore.sh'))
    await copyFile(README, join(work, 'README.txt'))

    job.step = 'รวมเป็น zip'
    await run(['zip', '-q', '-0', '-X', join(OUT, `${name}.part`), 'restore.sh', 'README.txt', 'payload.enc', 'payload.enc.sha256'], { cwd: work })
    await run(['mv', join(OUT, `${name}.part`), join(OUT, name)])
    job.step = 'เสร็จ'
    job.done = true

    const all = (await readdir(OUT)).filter((f) => NAME_RE.test(f)).sort()
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) await rm(join(OUT, old), { force: true })
  } catch (e) {
    job.error = (e as Error).message
    await rm(join(OUT, `${name}.part`), { force: true })
    console.error('bundle failed:', job.error)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function list() {
  await mkdir(OUT, { recursive: true })
  const files = (await readdir(OUT)).filter((f) => NAME_RE.test(f)).sort().reverse()
  return Promise.all(files.map(async (name) => {
    const s = await stat(join(OUT, name))
    return { name, size: s.size, created: s.mtime.toISOString() }
  }))
}

export function createApp() {
  return new Elysia()
    .get('/health', () => ({ ok: true }))
    .get('/backups', async () => ({ bundles: await list(), job }))
    .post('/backups', async ({ body, set }) => {
      const passphrase = (body as { passphrase?: unknown } | null)?.passphrase
      if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 200) {
        set.status = 400
        return { error: 'passphrase must be 12–200 characters' }
      }
      if (job && !job.done && !job.error) {
        set.status = 409
        return { error: 'a backup is already running' }
      }
      makeBundle(passphrase) // runs in the background; the page polls GET /backups
      return { started: job?.name }
    })
    .post('/backups/:name/link', ({ params, set }) => {
      if (!NAME_RE.test(params.name) || !existsSync(join(OUT, params.name))) {
        set.status = 404
        return { error: 'not found' }
      }
      const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
      links.set(token, { name: params.name, until: Date.now() + 10 * 60_000 })
      for (const [t, l] of links) if (l.until < Date.now()) links.delete(t)
      return { url: `/api/backups/dl/${token}` }
    })
    .get('/backups/dl/:token', ({ params }) => {
      const l = links.get(params.token)
      if (!l || l.until < Date.now()) return new Response('link expired', { status: 410 })
      const file = Bun.file(join(OUT, l.name))
      return new Response(file, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${l.name}"`,
          'cache-control': 'no-store',
        },
      })
    })
    .delete('/backups/:name', async ({ params, set }) => {
      if (!NAME_RE.test(params.name)) {
        set.status = 404
        return { error: 'not found' }
      }
      await rm(join(OUT, params.name), { force: true })
      return { deleted: params.name }
    })
}

if (import.meta.main) {
  await mkdir(OUT, { recursive: true })
  createApp().listen({ port: PORT, hostname: '0.0.0.0' })
  console.log(`backup listening on :${PORT}`)
}
