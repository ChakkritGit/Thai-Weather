import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'

const SECRET='test-secret-only-for-tests'
const BIN=process.env.APPS_RUST_SYNC_BIN!
if(!BIN)throw new Error('APPS_RUST_SYNC_BIN must identify the native fixture binary')
const dir=mkdtempSync(join(tmpdir(),'sync-native-test-'))
const db=join(dir,'sync.db')
async function start(){
 const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('fixture')});const port=probe.port!;await probe.stop(true)
 const proc=Bun.spawn([BIN,'sync'],{env:{...process.env,PORT:String(port),PARTY_TOKEN_SECRET:SECRET,SYNC_DB:db},stdout:'ignore',stderr:'pipe'})
 for(let i=0;i<200;i++){if(await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.ok,()=>false))return{server:{port},stop:async()=>{proc.kill();await proc.exited}};await Bun.sleep(10)}
 proc.kill();throw new Error(await new Response(proc.stderr).text())
}
let server=await start();let base=`127.0.0.1:${server.server.port}`
afterAll(async()=>{await server.stop();rmSync(dir,{recursive:true,force:true})})

const token = (sub: string) =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setExpirationTime('5m').sign(new TextEncoder().encode(SECRET))

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

test('handoff queues commands, rejects stale release and fences old reports',async()=>{
 const a=await connect('fixture-transfer','a'),b=await connect('fixture-transfer','b')
 try{
  a.ws.send(JSON.stringify({type:'hello',protocol:2,name:'A',commands:true}));await a.next(m=>m.type==='welcome')
  b.ws.send(JSON.stringify({type:'hello',protocol:2,name:'B',commands:true}));await b.next(m=>m.type==='welcome')
  a.ws.send(JSON.stringify({type:'output',id:'a',seed,adoptLocal:true}));const first=await a.next(m=>m.type==='room'&&m.outputId==='a')
  b.ws.send(JSON.stringify({type:'output',id:'b'}));const releasing=await a.next(m=>m.type==='room'&&m.pendingOutputId==='b')
  b.ws.send(JSON.stringify({type:'command',command:{type:'next'}}))
  a.ws.send(JSON.stringify({type:'released',revision:releasing.revision-1}));await Bun.sleep(40)
  expect(b.msgs.some(m=>m.type==='player-command')).toBe(false)
  a.ws.send(JSON.stringify({type:'released',revision:releasing.revision}));const command=await b.next(m=>m.type==='player-command')
  expect(command.command.type).toBe('next');expect(command.outputGeneration).toBeGreaterThan(first.outputGeneration)
  b.ws.send(JSON.stringify({type:'report',outputGeneration:first.outputGeneration,commandRevision:command.revision,playback:{...seed,currentIndex:1}}));await Bun.sleep(30)
  expect(a.msgs.some(m=>m.type==='room'&&m.playback?.currentIndex===1)).toBe(false)
  b.ws.send(JSON.stringify({type:'report',outputGeneration:command.outputGeneration,commandRevision:command.revision,playback:{...seed,currentIndex:1}}));expect((await a.next(m=>m.type==='room'&&m.playback?.currentIndex===1)).outputId).toBe('b')
 }finally{a.ws.close();b.ws.close()}
})
test('reconnect replaces a device and an old close cannot evict its replacement',async()=>{
 const a=await connect('fixture-reconnect','same');a.ws.send(JSON.stringify({type:'hello',protocol:2,name:'Old',commands:true}));await a.next(m=>m.type==='welcome');a.ws.send(JSON.stringify({type:'output',id:'same',seed}));await a.next(m=>m.type==='room'&&m.outputId==='same')
 const b=await connect('fixture-reconnect','same')
 try{b.ws.send(JSON.stringify({type:'hello',protocol:2,name:'New',commands:true}));await b.next(m=>m.type==='room'&&m.devices.some((d:any)=>d.name==='New'));a.ws.close();await Bun.sleep(40);b.ws.send(JSON.stringify({type:'heartbeat',sent:42}));expect((await b.next(m=>m.type==='lease')).granted).toBe(true)}finally{a.ws.close();b.ws.close()}
})
test('legacy snapshots retain safe queue edits and transport revision rules',async()=>{
 const a=await connect('fixture-legacy','legacy'),b=await connect('fixture-legacy','controller')
 try{a.ws.send(JSON.stringify({type:'hello',protocol:2,name:'Legacy'}));await a.next(m=>m.type==='welcome');b.ws.send(JSON.stringify({type:'hello',protocol:2,name:'Controller',commands:true}));await b.next(m=>m.type==='welcome');a.ws.send(JSON.stringify({type:'output',id:'legacy',seed}));const initial=await b.next(m=>m.type==='room'&&m.outputId==='legacy');expect(initial.controlMode).toBe('snapshots');b.ws.send(JSON.stringify({type:'command',command:{type:'insert',file:song('c')}}));const inserted=await b.next(m=>m.type==='room'&&m.playback?.queue.length===3);expect(inserted.playback.queue.map((f:any)=>f.id)).toEqual(['a','c','b']);expect(inserted.transportRevision).toBe(initial.transportRevision);expect(inserted.positionRevision).toBe(initial.positionRevision);b.ws.send(JSON.stringify({type:'command',command:{type:'remove',index:1,fileId:'stale'}}));await Bun.sleep(20);b.ws.send(JSON.stringify({type:'command',command:{type:'next'}}));const next=await b.next(m=>m.type==='room'&&m.playback?.currentIndex===1);expect(next.playback.queue[1].id).toBe('c');expect(next.transportRevision).toBeGreaterThan(initial.transportRevision);expect(next.positionRevision).toBeGreaterThan(initial.positionRevision)}finally{a.ws.close();b.ws.close()}
})
test('the queue survives a restart (stored in sqlite), paused', async () => {
  await Bun.sleep(100)
  await server.stop()
  server = await start()
  base = `127.0.0.1:${server.server!.port}`
  const again = await connect('acct-1', 'laptop')
  const room = await again.next((m) => m.type === 'room')
  expect(room.playback.currentIndex).toBe(1)
  expect(room.playback.isPlaying).toBe(false)
  again.ws.close()
})
