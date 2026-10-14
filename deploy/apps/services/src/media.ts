/**
 * Portfolio media (studio images and attachments) – replaces the public Supabase Storage bucket.
 *
 *   GET    /media/<path>             public (NPM forwards chakkritton.com/media/), cached for a year:
 *                                     every stored name is a fresh uuid, so a file never changes
 *   PUT    /internal/media/<path>    store a file  ┐ x-media-token, only from the portfolio server on the
 *   DELETE /internal/media/<path>    remove it     ┘ internal network (NPM never forwards /internal)
 * Files live under MEDIA_DIR (a volume); paths are checked so nothing can escape it.
 */
import { Elysia } from 'elysia'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'

const PORT = Number(process.env.PORT ?? 8793)
const MAX_BYTES = 20 * 1024 * 1024

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', json: 'application/json', csv: 'text/csv; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm',
}

/** "uploads/2026-10/<uuid>.png" style paths only: no "..", no hidden files, no absolute paths. */
export function safePath(raw: string): string | null {
  let p: string
  try {
    p = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(p) || p.split('/').some((s) => !s || s.startsWith('.'))) return null
  const n = normalize(p)
  return n === p ? n : null
}

export function createApp(dir = process.env.MEDIA_DIR ?? '/data/media', token = process.env.MEDIA_TOKEN ?? '') {
  const authorized = (h: string | null) => {
    if (!token || !h) return false
    const a = Buffer.from(h)
    const b = Buffer.from(token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  const fileFor = (raw: string) => {
    const p = safePath(raw)
    return p ? { path: p, file: join(dir, p) } : null
  }

  return new Elysia()
    .get('/health', () => ({ ok: true }))
    .get('/media/*', async ({ params }) => {
      const f = fileFor(params['*'])
      if (!f) return new Response('not found', { status: 404 })
      const file = Bun.file(f.file)
      if (!(await file.exists())) return new Response('not found', { status: 404 })
      const ext = f.path.split('.').pop()!.toLowerCase()
      return new Response(file, {
        headers: {
          'content-type': TYPES[ext] ?? 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          // stored files are never run as a page here (an uploaded SVG or HTML stays inert)
          'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          ...(TYPES[ext] ? {} : { 'content-disposition': 'attachment' }),
        },
      })
    })
    .put('/internal/media/*', async ({ params, request }) => {
      if (!authorized(request.headers.get('x-media-token'))) return new Response('forbidden', { status: 403 })
      const f = fileFor(params['*'])
      if (!f) return new Response('bad path', { status: 400 })
      const body = await request.arrayBuffer()
      if (body.byteLength > MAX_BYTES) return new Response('too large', { status: 413 })
      await mkdir(dirname(f.file), { recursive: true })
      const tmp = `${f.file}.tmp-${crypto.randomUUID()}`
      await Bun.write(tmp, body)
      await rename(tmp, f.file)
      return new Response(null, { status: 201 })
    })
    .delete('/internal/media/*', async ({ params, request }) => {
      if (!authorized(request.headers.get('x-media-token'))) return new Response('forbidden', { status: 403 })
      const f = fileFor(params['*'])
      if (!f) return new Response('bad path', { status: 400 })
      try {
        await unlink(f.file)
        return new Response(null, { status: 204 })
      } catch {
        return new Response('not found', { status: 404 })
      }
    })
}

if (import.meta.main) {
  if (!process.env.MEDIA_TOKEN) console.warn('MEDIA_TOKEN is not set: uploads are refused')
  createApp().listen({ port: PORT, hostname: '0.0.0.0', maxRequestBodySize: MAX_BYTES + 1024 })
  console.log(`media listening on :${PORT}`)
}
