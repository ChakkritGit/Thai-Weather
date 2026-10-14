import { afterAll, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { app } from './rooms'

const server = app.listen({ port: 0, hostname: '127.0.0.1' })
const url = `ws://127.0.0.1:${server.server!.port}`
afterAll(() => server.stop(true))

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await Bun.sleep(20)
  }
}

test('two browsers in one room see each other’s strokes and cursors', async () => {
  const a = new Y.Doc(), b = new Y.Doc()
  const pa = new WebsocketProvider(url, 'board-1', a, { WebSocketPolyfill: WebSocket as never })
  const pb = new WebsocketProvider(url, 'board-1', b, { WebSocketPolyfill: WebSocket as never })
  await until(() => pa.synced && pb.synced)
  a.getArray('strokes').push(['line-from-a'])
  await until(() => b.getArray('strokes').length === 1)
  b.getArray('strokes').push(['line-from-b'])
  await until(() => a.getArray('strokes').length === 2)
  pa.awareness.setLocalStateField('cursor', { x: 1, y: 2 })
  await until(() => [...pb.awareness.getStates().values()].some((s) => s.cursor?.x === 1))
  // A leaves: its cursor disappears for B immediately, not after the 30 s timeout
  pa.destroy()
  await until(() => ![...pb.awareness.getStates().values()].some((s) => s.cursor?.x === 1), 2000)
  pb.destroy()
})

test('rooms are isolated and the health probe answers', async () => {
  const a = new Y.Doc(), c = new Y.Doc()
  const pa = new WebsocketProvider(url, 'room-x', a, { WebSocketPolyfill: WebSocket as never })
  const pc = new WebsocketProvider(url, 'room-y', c, { WebSocketPolyfill: WebSocket as never })
  await until(() => pa.synced && pc.synced)
  a.getArray('s').push([1])
  await Bun.sleep(300)
  expect(c.getArray('s').length).toBe(0)
  pa.destroy(); pc.destroy()
  const r = await fetch(`http://127.0.0.1:${server.server!.port}/__health`)
  expect(r.status).toBe(200)
})

test('garbage bytes close only that socket', async () => {
  const ws = new WebSocket(`${url}/room-z`)
  await new Promise((r) => (ws.onopen = r))
  const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)))
  ws.send(new Uint8Array([0, 200, 255, 255, 255, 255, 255]))
  expect(await closed).toBe(1003)
})

test('a /rooms prefix is dropped when PATH_PREFIX is set', async () => {
  const proc = Bun.spawn(['bun', 'src/rooms.ts'], { env: { ...process.env, PORT: '18787', PATH_PREFIX: '/rooms' }, stdout: 'pipe' })
  await Bun.sleep(400)
  try {
    const a = new Y.Doc(), b = new Y.Doc()
    const pa = new WebsocketProvider('ws://127.0.0.1:18787/rooms', 'r1', a, { WebSocketPolyfill: WebSocket as never })
    const pb = new WebsocketProvider('ws://127.0.0.1:18787', 'r1', b, { WebSocketPolyfill: WebSocket as never })
    await until(() => pa.synced && pb.synced)
    a.getArray('s').push([1])
    await until(() => b.getArray('s').length === 1) // same room with or without the prefix
    pa.destroy(); pb.destroy()
  } finally {
    proc.kill()
  }
})
