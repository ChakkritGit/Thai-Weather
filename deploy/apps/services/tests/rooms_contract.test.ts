// Official JS Yjs clients exercise the native wire protocol without BroadcastChannel.
import { afterAll, expect, test } from 'bun:test'
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const BIN=process.env.APPS_RUST_ROOMS_BIN!
if(!BIN)throw new Error('APPS_RUST_ROOMS_BIN must identify the native fixture binary')
const until=async(fn:()=>boolean, ms=3000)=>{const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw new Error('timeout');await Bun.sleep(10)}}
async function server(prefix=''){
 const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('fixture')});const port=probe.port!;await probe.stop(true)
 const proc=Bun.spawn([BIN,'rooms'],{env:{...process.env,PORT:String(port),PATH_PREFIX:prefix},stdout:'ignore',stderr:'pipe'})
 for(let i=0;i<200;i++){if(await fetch(`http://127.0.0.1:${port}/__health`).then(r=>r.ok,()=>false))return{port,url:`ws://127.0.0.1:${port}`,stop:async()=>{proc.kill();await proc.exited}};await Bun.sleep(10)}
 proc.kill();throw new Error(await new Response(proc.stderr).text())
}
const live=await server();afterAll(()=>live.stop())
class Peer {
 doc:Y.Doc;awareness:awarenessProtocol.Awareness;ws:WebSocket;synced=false;closed=0
 constructor(url:string,doc=new Y.Doc()){
  this.doc=doc;this.awareness=new awarenessProtocol.Awareness(doc);this.ws=new WebSocket(url);this.ws.binaryType='arraybuffer'
  const send=(e:encoding.Encoder)=>{if(this.ws.readyState===WebSocket.OPEN)this.ws.send(encoding.toUint8Array(e))}
  this.ws.onopen=()=>{let e=encoding.createEncoder();encoding.writeVarUint(e,0);sync.writeSyncStep1(e,doc);send(e);e=encoding.createEncoder();encoding.writeVarUint(e,1);encoding.writeVarUint8Array(e,awarenessProtocol.encodeAwarenessUpdate(this.awareness,[doc.clientID]));send(e)}
  this.ws.onmessage=({data})=>{const d=decoding.createDecoder(new Uint8Array(data as ArrayBuffer));const e=encoding.createEncoder();const kind=decoding.readVarUint(d);if(kind===0){encoding.writeVarUint(e,0);const type=sync.readSyncMessage(d,e,doc,this);if(type===sync.messageYjsSyncStep2)this.synced=true;if(encoding.length(e)>1)send(e)}else if(kind===1){awarenessProtocol.applyAwarenessUpdate(this.awareness,decoding.readVarUint8Array(d),this)}}
  this.ws.onclose=e=>{this.closed=e.code}
  doc.on('update',(update:Uint8Array,origin:unknown)=>{if(origin===this)return;const e=encoding.createEncoder();encoding.writeVarUint(e,0);sync.writeUpdate(e,update);send(e)})
  this.awareness.on('update',({added,updated,removed}:{added:number[],updated:number[],removed:number[]},origin:unknown)=>{if(origin===this)return;const e=encoding.createEncoder();encoding.writeVarUint(e,1);encoding.writeVarUint8Array(e,awarenessProtocol.encodeAwarenessUpdate(this.awareness,[...added,...updated,...removed]));send(e)})
 }
 close(){this.ws.close();this.awareness.destroy();this.doc.destroy()}
}
test('native Yrs and JS clients converge, retain late-join data and withdraw cursors',async()=>{
 const room='/fixture-'+crypto.randomUUID();const a=new Peer(live.url+room),b=new Peer(live.url+room)
 try{
  await until(()=>a.synced&&b.synced)
  a.doc.getArray('strokes').push([{x:1,y:2,color:'red'}]);await until(()=>b.doc.getArray('strokes').length===1)
  b.doc.getArray('strokes').push([{x:3,y:4}]);await until(()=>a.doc.getArray('strokes').length===2)
  a.doc.getText('note').insert(0,'ภาษาไทย 👩🏽‍💻');a.doc.getText('note').format(0,7,{bold:true})
  b.doc.getMap('settings').set('bytes',new Uint8Array([0,255,42]));await until(()=>a.doc.getMap('settings').has('bytes')&&b.doc.getText('note').toString().includes('👩🏽‍💻'))
  a.awareness.setLocalStateField('cursor',{x:11,y:22});await until(()=>[...b.awareness.getStates().values()].some(s=>s.cursor?.x===11))
  const c=new Peer(live.url+room)
  try{await until(()=>c.synced&&c.doc.getArray('strokes').length===2);expect(c.doc.getText('note').toString()).toBe('ภาษาไทย 👩🏽‍💻');expect(c.doc.getMap('settings').get('bytes')).toEqual(new Uint8Array([0,255,42]));}finally{c.close()}
  const id=a.doc.clientID;a.close();await until(()=>!b.awareness.getStates().has(id),2000)
 }finally{if(a.ws.readyState===WebSocket.OPEN)a.close();b.close()}
})
test('room isolation, invalid frames, malformed names and dropping empty rooms',async()=>{
 const a=new Peer(live.url+'/x-'+crypto.randomUUID()),b=new Peer(live.url+'/y-'+crypto.randomUUID())
 try{await until(()=>a.synced&&b.synced);a.doc.getArray('s').push([1]);await Bun.sleep(100);expect(b.doc.getArray('s').length).toBe(0)}finally{a.close();b.close()}
 for(const [path,bytes,code]of[['/bad-frame',new Uint8Array([0,200,255,255,255,255,255]),1003],['/bad%zz',null,1008]] as const){const ws=new WebSocket(live.url+path);const closed=new Promise<number>(r=>ws.onclose=e=>r(e.code));if(bytes)ws.onopen=()=>ws.send(bytes);expect(await closed).toBe(code)}
 for(let i=0;i<100;i++){const r=await fetch(`http://127.0.0.1:${live.port}/__health`);if(r.headers.get('x-open-rooms')==='0')return;await Bun.sleep(10)}
 throw new Error('empty native rooms were retained')
})
test('prefix aliases and offline client state sync correctly',async()=>{
 const x=await server('/rooms')
 const doc=new Y.Doc();doc.getArray('offline').push(['browser IndexedDB fixture'])
 const a=new Peer(x.url+'/rooms/r1',doc),b=new Peer(x.url+'/r1')
 try{await until(()=>a.synced&&b.synced&&b.doc.getArray('offline').length===1);expect(b.doc.getArray('offline').get(0)).toBe('browser IndexedDB fixture')}finally{a.close();b.close();await x.stop()}
})
