import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'

process.env.PARTY_TOKEN_SECRET = 'test-secret-only-for-tests'
const { createApp } = await import('../tests/oracle/sync')
const dir = mkdtempSync(join(tmpdir(), 'sync-test-'))
const db = join(dir, 'sync.db')
let server = createApp(db).app.listen({ port: 0, hostname: '127.0.0.1' })
let base = `127.0.0.1:${server.server!.port}`
afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const token = (sub: string) =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setExpirationTime('5m').sign(new TextEncoder().encode(process.env.PARTY_TOKEN_SECRET))

type Client = { ws: WebSocket; msgs: any[]; next(pred: (m: any) => boolean, ms?: number): Promise<any> }
async function connect(room: string, pk: string, tok?: string): Promise<Client> {
  const ws = new WebSocket(`ws://${base}/parties/sync-server/${encodeURIComponent(room)}?_pk=${pk}&token=${tok ?? (await token(room))}`)
  const msgs: any[] = []
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)))
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)))
  return {
    ws,
    msgs,
    async next(pred, ms = 2000) {
      const t0 = Date.now()
      for (;;) {
        const i = msgs.findIndex(pred)
        if (i >= 0) return msgs.splice(0, i + 1).pop()
        if (Date.now() - t0 > ms) throw new Error('timeout; got ' + JSON.stringify(msgs.map((m) => m.type)))
        await Bun.sleep(10)
      }
    },
  }
}

const song = (id: string) => ({ id, name: `${id}.mp3`, mimeType: 'audio/mpeg' })
const seed = {
  queue: [song('a'), song('b')], currentIndex: 0, source: null, progress: 12, duration: 200, isPlaying: true,
  shuffle: false, shuffleOrder: [], playNextIndex: null, loopMode: 'off', meta: null, updatedAt: Date.now(),
}

test('health', async () => {
  const r = await fetch(`http://${base}/health`)
  expect(r.status).toBe(200)
  expect((await r.json()).service).toBe('drive-music-sync')
})

test('refuses a token for another account, or none', async () => {
  for (const tok of [await token('someone-else'), 'garbage']) {
    const ws = new WebSocket(`ws://${base}/parties/sync-server/acct-1?_pk=x&token=${tok}`)
    const outcome = await new Promise((res) => ((ws.onopen = () => res('open')), (ws.onerror = () => res('refused')), (ws.onclose = () => res('refused'))))
    expect(outcome).toBe('refused')
  }
})

test('phone controls the laptop: output grant, command routing, report, devices list', async () => {
  const laptop = await connect('acct-1', 'laptop')
  expect((await laptop.next((m) => m.type === 'room')).playback).toBeNull()
  laptop.ws.send(JSON.stringify({ type: 'hello', protocol: 2, name: 'Laptop', commands: true }))
  expect((await laptop.next((m) => m.type === 'welcome')).deviceId).toBe('laptop')
  laptop.ws.send(JSON.stringify({ type: 'output', id: 'laptop', seed, adoptLocal: true }))
  const granted = await laptop.next((m) => m.type === 'room' && m.outputId === 'laptop')
  expect(granted.controlMode).toBe('commands')
  expect(granted.playback.queue.length).toBe(2)

  const phone = await connect('acct-1', 'phone')
  phone.ws.send(JSON.stringify({ type: 'hello', protocol: 2, name: 'iPhone', commands: true }))
  const room = await phone.next((m) => m.type === 'room' && m.devices.length === 2)
  expect(room.devices.map((d: any) => d.name).sort()).toEqual(['Laptop', 'iPhone'])

  phone.ws.send(JSON.stringify({ type: 'command', command: { type: 'next' } }))
  const cmd = await laptop.next((m) => m.type === 'player-command')
  expect(cmd.command).toEqual({ type: 'next' })

  laptop.ws.send(JSON.stringify({ type: 'report', outputGeneration: cmd.outputGeneration, commandRevision: cmd.revision, playback: { ...seed, currentIndex: 1, progress: 0 } }))
  expect((await phone.next((m) => m.type === 'room' && m.playback?.currentIndex === 1)).outputId).toBe('laptop')

  laptop.ws.send(JSON.stringify({ type: 'heartbeat', sent: 5 }))
  expect((await laptop.next((m) => m.type === 'lease')).granted).toBe(true)

  // the laptop goes away: the phone sees the output released
  laptop.ws.close()
  expect((await phone.next((m) => m.type === 'room' && m.outputId === null && m.devices.length === 1)).playback.isPlaying).toBe(false)
  phone.ws.close()
})

test('Spotify-style: device kinds in the room, and a phone sets the laptop volume', async () => {
  const laptop = await connect('acct-3', 'mac')
  laptop.ws.send(JSON.stringify({ type: 'hello', protocol: 2, name: 'Mac · Chrome', kind: 'computer', commands: true }))
  await laptop.next((m) => m.type === 'welcome')
  laptop.ws.send(JSON.stringify({ type: 'output', id: 'mac', seed, adoptLocal: true }))
  await laptop.next((m) => m.type === 'room' && m.outputId === 'mac')
  const phone = await connect('acct-3', 'iph')
  phone.ws.send(JSON.stringify({ type: 'hello', protocol: 2, name: 'iPhone · Safari', kind: 'phone', commands: true }))
  const room = await phone.next((m) => m.type === 'room' && m.devices.length === 2)
  expect(room.devices.find((d: any) => d.id === 'iph').kind).toBe('phone')
  phone.ws.send(JSON.stringify({ type: 'hello', protocol: 2, name: 'x', kind: 'toaster', commands: true })) // unknown kinds are dropped
  expect((await phone.next((m) => m.type === 'room' && m.devices.some((d: any) => d.name === 'x'))).devices.find((d: any) => d.id === 'iph').kind).toBeUndefined()
  phone.ws.send(JSON.stringify({ type: 'command', command: { type: 'volume', value: 0.35 } }))
  const cmd = await laptop.next((m) => m.type === 'player-command')
  expect(cmd.command).toEqual({ type: 'volume', value: 0.35 })
  laptop.ws.send(JSON.stringify({ type: 'report', outputGeneration: cmd.outputGeneration, commandRevision: cmd.revision, playback: { ...seed, volume: 0.35 } }))
  expect((await phone.next((m) => m.type === 'room' && m.playback?.volume === 0.35)).outputId).toBe('mac')
  laptop.ws.close(); phone.ws.close()
})

test('accounts are isolated', async () => {
  const other = await connect('acct-2', 'tv')
  expect((await other.next((m) => m.type === 'room')).playback).toBeNull()
  other.ws.close()
})

test('the queue survives a restart (stored in sqlite), paused', async () => {
  await Bun.sleep(100)
  server.stop(true)
  server = createApp(db).app.listen({ port: 0, hostname: '127.0.0.1' })
  base = `127.0.0.1:${server.server!.port}`
  const again = await connect('acct-1', 'laptop')
  const room = await again.next((m) => m.type === 'room')
  expect(room.playback.currentIndex).toBe(1)
  expect(room.playback.isPlaying).toBe(false)
  again.ws.close()
})
