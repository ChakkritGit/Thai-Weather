import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, safePath } from './media'

const dir = mkdtempSync(join(tmpdir(), 'media-test-'))
const server = createApp(dir, 'secret-token').listen({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.server!.port}`
afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

test('paths that could escape the folder are refused', () => {
  expect(safePath('uploads/2026-10/a.png')).toBe('uploads/2026-10/a.png')
  for (const bad of ['../etc/passwd', 'uploads/../../x', '/abs/x.png', '.env', 'uploads/.hidden', 'a//b', '%2e%2e/x', 'a\\b']) expect(safePath(bad)).toBeNull()
})

test('store with the token, read publicly, delete', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  expect((await fetch(`${base}/internal/media/uploads/2026-10/x.png`, { method: 'PUT', body: png })).status).toBe(403)
  expect((await fetch(`${base}/internal/media/uploads/2026-10/x.png`, { method: 'PUT', body: png, headers: { 'x-media-token': 'nope-nope-no' } })).status).toBe(403)
  expect((await fetch(`${base}/internal/media/uploads/2026-10/x.png`, { method: 'PUT', body: png, headers: { 'x-media-token': 'secret-token' } })).status).toBe(201)
  const r = await fetch(`${base}/media/uploads/2026-10/x.png`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('image/png')
  expect(r.headers.get('cache-control')).toContain('immutable')
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(png)
  expect((await fetch(`${base}/media/uploads/..%2F..%2Fx.png`)).status).toBe(404)
  expect((await fetch(`${base}/internal/media/uploads/2026-10/x.png`, { method: 'DELETE', headers: { 'x-media-token': 'secret-token' } })).status).toBe(204)
  expect((await fetch(`${base}/media/uploads/2026-10/x.png`)).status).toBe(404)
})
