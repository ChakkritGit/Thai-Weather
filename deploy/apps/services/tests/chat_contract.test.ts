import {afterAll,expect,test} from 'bun:test'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {fixtureTls} from './fixtures/tls'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Database} from 'bun:sqlite'
import {composeReport,reportData,digestDay,bkkDay} from './oracle/chat'
const BIN=process.env.APPS_RUST_CHAT_BIN!
if(!BIN)throw new Error('APPS_RUST_CHAT_BIN required')
const root=mkdtempSync(join(tmpdir(),'chat-native-')),dbpath=join(root,'chat.db')
const now=Date.now(),day=bkkDay(now).slice(0,7)+'-01',month=bkkDay(now).slice(0,7),untilDay=Number(bkkDay(now).slice(8))
const from=Date.parse(`${day}T00:00:00+07:00`)/1000
const times=Array.from({length:145},(_,i)=>from+i*600),col=(v:number)=>times.map(()=>v)
const metrics={step:600,times,host:{cpu_user:col(10),cpu_system:col(4),cpu_iowait:col(1),mem_used:col(1e9),net_rx:col(1000),net_tx:col(2000)},nginx:{all:{req:col(9)},'thai-weather.chakkritton.com':{req:col(6),s4:col(1),s5:col(0),bytes:col(5000)},'expenses.chakkritton.com':{req:col(3),s4:col(0),s5:col(1),bytes:col(100)}},snapshot:{mem_total:3e9,disk_used:14e9,disk_total:29e9,cpus:2}}
const analytics={series:[{day,views:40,visitors:7}],perHost:[{key:'chakkritton.com',views:10,visitors:4}],totals:{views:40,visitors:7}}
const status={services:[{name:'Fixture Up',status:'up',uptime90:100},{name:'Fixture Down',status:'down',uptime90:98}]},backups={bundles:[]}
const fake=Bun.serve({port:0,hostname:'127.0.0.1',fetch:r=>Response.json(new URL(r.url).pathname==='/stats'?analytics:new URL(r.url).pathname==='/api/status'?status:backups)})
const certdir=fixtureTls(root)
let pushed:any=null
const tls=Bun.serve({port:0,hostname:'127.0.0.1',tls:{key:readFileSync(join(certdir,'key.pem')),cert:readFileSync(join(certdir,'server.pem'))},fetch:async req=>{pushed={headers:Object.fromEntries(req.headers),body:Buffer.from(await req.arrayBuffer())};return new Response('',{status:410})}})
const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('')});const port=probe.port!;await probe.stop(true)
const url=`http://127.0.0.1:${fake.port}`
const proc=Bun.spawn([BIN,'chat'],{env:{...process.env,PORT:String(port),CHAT_DB:dbpath,CHAT_JOBS_DISABLED:'true',SSL_CERT_FILE:join(certdir,'cert.pem'),ALERT_SECRET:'fixture-secret',LLM_PROVIDER:'',METRICS_URL:url,ANALYTICS_URL:url,STATUS_URL:url,BACKUP_URL:url},stdout:'ignore',stderr:'pipe'})
const base=`http://127.0.0.1:${port}`
for(let i=0;i<200;i++){if(await fetch(base+'/health').then(r=>r.ok,()=>false))break;await Bun.sleep(10)}
const db=new Database(dbpath)
afterAll(async()=>{db.close();proc.kill();await proc.exited;await fake.stop(true);await tls.stop(true);rmSync(root,{recursive:true,force:true})})
const call=(path:string,method='GET',body?:unknown,headers={})=>fetch(base+path,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)})
test('native conversation, validation, paging and read state',async()=>{
 expect((await call('/chat','POST',{text:''})).status).toBe(400)
 expect((await call('/chat','POST',{text:'😀'.repeat(2001)})).status).toBe(400)
 const posted=await(await call('/chat','POST',{text:'ช่วย'})).json();expect(posted.messages.map((m:any)=>m.role)).toEqual(['user','assistant']);expect(posted.messages[1].text).toContain('สรุป — สรุปเดือนนี้')
 for(let i=0;i<75;i++)db.run("INSERT INTO messages(ts,role,text,read) VALUES(1,'system',?,0)",[`fixture-${i}`])
 const first=await(await call('/chat')).json();expect(first.messages.length).toBe(30);expect(first.hasMore).toBe(true);expect(first.messages.at(-1).text).toBe('fixture-74')
 const older=await(await call('/chat?before='+first.messages[0].id)).json();expect(older.messages.at(-1).id).toBe(first.messages[0].id-1)
 expect((await(await call('/chat?after='+first.messages.at(-1).id)).json()).messages).toEqual([])
 expect((await(await call('/chat/unread')).json()).count).toBe(75)
 await call('/chat/read','POST',{});expect((await(await call('/chat/unread')).json()).count).toBe(0)
})
test('native alerts require the secret; push subscriptions and keys persist',async()=>{
 expect((await call('/chat/alert','POST',{alert:{title:'fixture',body:'fixture'}})).status).toBe(403)
 expect((await call('/chat/alert','POST',{alert:{title:1}},{'x-alert-secret':'fixture-secret'})).status).toBe(400)
 const posted=await(await call('/chat/alert','POST',{alert:{title:'Fixture',body:'Synthetic only',kind:'up'}},{'x-alert-secret':'fixture-secret'})).json();expect(posted.ok).toBe(true)
 expect(db.query('SELECT kind,read FROM messages WHERE id=?').get(posted.id)).toEqual({kind:'up',read:0})
 const key=await(await call('/chat/push/key')).json();expect(Buffer.from(key.key,'base64url').length).toBe(65);expect((await(await call('/chat/push/key')).json()).key).toBe(key.key)
 expect((await call('/chat/push/subscribe','POST',{endpoint:'https://evil.example/',keys:{p256dh:'x',auth:'x'}})).status).toBe(400)
 expect((await call('/chat/push/subscribe','POST',{endpoint:'https://web.push.apple.com/fixture',keys:{p256dh:'x',auth:'x'}})).status).toBe(200)
 expect(db.query('SELECT count(*) n FROM push_subs').get()).toEqual({n:1})
 await call('/chat/push/unsubscribe','POST',{endpoint:'https://web.push.apple.com/fixture'});expect(db.query('SELECT count(*) n FROM push_subs').get()).toEqual({n:0})
})
test('native monthly report matches the frozen JS text and card with fake upstreams',async()=>{
 const digest=digestDay(day,metrics,analytics)!;db.run('INSERT OR REPLACE INTO digests(day,data) VALUES(?,?)',[day,JSON.stringify(digest)])
 const res=await(await call('/chat','POST',{text:'สรุป'})).json();const answer=res.messages[1]
 expect(answer.kind).toBe('report');const ds=day.startsWith(month)?[digest]:[]
 expect(answer.text).toBe(composeReport(month,ds,{analytics,status,backups,untilDay}))
 expect(answer.data).toEqual(reportData(month,ds,{visitorsDaily:analytics.series,totals:analytics.totals,status,backups,untilDay}))
 for(const rows of [[],[{...digest,cpuAvg:3,cpuMax:95,memAvg:2.8e9,diskUsed:27e9}],[{...digest,cpuAvg:null,cpuMax:null,memAvg:null}]]){
  db.run('DELETE FROM digests');for(const d of rows)db.run('INSERT INTO digests(day,data) VALUES(?,?)',[d.day,JSON.stringify(d)]);
  const a=(await(await call('/chat','POST',{text:'สรุป'})).json()).messages[1];expect(a.text).toBe(composeReport(month,rows,{analytics,status,backups,untilDay}));expect(a.data).toEqual(reportData(month,rows,{visitorsDaily:analytics.series,totals:analytics.totals,status,backups,untilDay}))
 }
 db.run("INSERT INTO reports(month,message_id) VALUES('2000-01',1)");await call('/chat','DELETE');expect((await(await call('/chat')).json()).messages).toEqual([]);expect(db.query('SELECT count(*) n FROM reports').get()).toEqual({n:1})
})

test('native Web Push decrypts in WebCrypto, VAPID verifies, gone subscriptions are removed',async()=>{
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);const publicKey=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey));const auth=crypto.getRandomValues(new Uint8Array(16));const endpoint=`https://localhost:${tls.port}/fixture`;
 db.run('INSERT INTO push_subs(endpoint,p256dh,auth,created) VALUES(?,?,?,1)',[endpoint,publicKey.toString('base64url'),Buffer.from(auth).toString('base64url')]);
 const response=await(await call('/chat/push/test','POST',{endpoint})).json();expect(response.status).toBe(410);expect(db.query('SELECT count(*) n FROM push_subs').get()).toEqual({n:0});expect(pushed.headers['content-encoding']).toBe('aes128gcm');expect(pushed.headers.ttl).toBe('86400');
 const body:Buffer=pushed.body,salt=body.subarray(0,16),sender=body.subarray(21,86),ct=body.subarray(86);const senderKey=await crypto.subtle.importKey('raw',sender,{name:'ECDH',namedCurve:'P-256'},false,[]);const shared=await crypto.subtle.deriveBits({name:'ECDH',public:senderKey},pair.privateKey,256);
 const expand=async(salt:Uint8Array,ikm:Uint8Array,info:Uint8Array,n:number)=>{const k=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,n*8))};const enc=new TextEncoder();const ikm=await expand(auth,new Uint8Array(shared),Buffer.concat([enc.encode('WebPush: info\0'),publicKey,sender]),32);const cek=await expand(salt,ikm,enc.encode('Content-Encoding: aes128gcm\0'),16),nonce=await expand(salt,ikm,enc.encode('Content-Encoding: nonce\0'),12);const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']);const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},key,ct));expect(plain.at(-1)).toBe(2);expect(JSON.parse(new TextDecoder().decode(plain.slice(0,-1))).title).toBe('Dock');
 const match=/^vapid t=([^,]+), k=(.+)$/.exec(pushed.headers.authorization)!;const [head,payload,sig]=match[1].split('.');const pub=await crypto.subtle.importKey('raw',Buffer.from(match[2],'base64url'),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,Buffer.from(sig,'base64url'),enc.encode(head+'.'+payload))).toBe(true);expect(JSON.parse(Buffer.from(payload,'base64url').toString()).aud).toBe(`https://localhost:${tls.port}`)
})
