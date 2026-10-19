import {afterAll,expect,test} from 'bun:test'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {jwtVerify} from 'jose'
import {fixtureTls} from './fixtures/tls'
import {decryptPush} from './fixtures/decrypt-push'
import {bangkokToday,addDays,reminderFor,missingMonthRows} from './oracle/reminders/reminders'
const BIN=process.env.APPS_RUST_REMINDERS_BIN!
if(!BIN)throw new Error('APPS_RUST_REMINDERS_BIN required')
const root=mkdtempSync(join(tmpdir(),'reminders-native-')),certdir=fixtureTls(root),SECRET='fixture-only-postgrest-key'
const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),peer=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url'),auth=crypto.getRandomValues(new Uint8Array(16))
const vapid=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),vapidPub=Buffer.from(await crypto.subtle.exportKey('raw',vapid.publicKey)).toString('base64url'),vapidJwk=await crypto.subtle.exportKey('jwk',vapid.privateKey)
const pushes:any[]=[],requests:any[]=[],receipts=new Map<string,string>()
let pushStatus=201,finishFail=false,claimFail=false,lastRun:any=null,rollout='2000-01-01',clockReject=0,writeFail=false,writeCalls=0
const tls=Bun.serve({port:0,hostname:'127.0.0.1',tls:{key:readFileSync(join(certdir,'key.pem')),cert:readFileSync(join(certdir,'server.pem'))},fetch:async req=>{pushes.push({headers:Object.fromEntries(req.headers),message:await decryptPush(Buffer.from(await req.arrayBuffer()),pair,auth)});return new Response('',{status:pushStatus})}})
const today=bangkokToday(),entries=[{user_id:'fixture-user',name:'Before',amount:'1234.50',due_date:addDays(today,-1)},{user_id:'fixture-user',name:'Today',amount:200,due_date:today},{user_id:'fixture-user',name:'Tomorrow',amount:300,due_date:addDays(today,1)}]
const plans=[{id:'fixture-plan',user_id:'fixture-user',active:true,name:'Plan',amount:'500.00',category:'bill',day_of_month:31}]
let subs=[{endpoint:`https://localhost:${tls.port}/fixture`,p256dh:peer,auth:Buffer.from(auth).toString('base64url'),user_id:'fixture-user'}],written:any[]=[],deleted:string[]=[]
const fake=Bun.serve({port:0,hostname:'127.0.0.1',fetch:async req=>{
 const url=new URL(req.url),path=url.pathname.replace('/rest/v1/',''),body=await req.json().catch(()=>null);requests.push({method:req.method,path,query:Object.fromEntries(url.searchParams),body,prefer:req.headers.get('prefer')})
 try{const {payload}=await jwtVerify((req.headers.get('authorization')??'').slice(7),new TextEncoder().encode(SECRET));if(payload.role!=='service_role')throw 0}catch{return Response.json({error:'invalid fixture token'},{status:401})}
 if(path==='reminder_retry_config')return Response.json([{start_day:rollout}])
 if(path==='heartbeats'){if(req.method==='GET')return Response.json(lastRun===null?[]:[{at:lastRun}]);lastRun=body.at;return new Response(null,{status:201})}
 if(path==='plans')return Response.json(plans)
 if(path==='entries'){
  if(req.method==='POST'){writeCalls++;if(clockReject>0){clockReject--;return Response.json({code:'PGRST303',message:'JWT issued at future'},{status:401})}written.push(...body);return writeFail?Response.json({error:'ambiguous fixture failure'},{status:503}):new Response(null,{status:201})}
  return Response.json(url.searchParams.get('select')==='user_id'?[]:entries)
 }
 if(path==='push_subscriptions'){if(req.method==='DELETE'){deleted.push(url.searchParams.get('endpoint')!);return new Response(null,{status:204})}return Response.json(subs)}
 if(path==='rpc/claim_reminder_delivery'){
  if(claimFail)return Response.json({error:'claim failed'},{status:500});const key=body.p_endpoint_hash;const state=receipts.get(key);if(state)return Response.json(state);receipts.set(key,'busy');return Response.json('claimed')
 }
 if(path==='rpc/finish_reminder_delivery'){if(finishFail)return Response.json(false);receipts.set(body.p_endpoint_hash,body.p_outcome);return Response.json(true)}
 return Response.json({error:'unexpected fixture request'},{status:500})
}})
async function start(disabled=false){const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('')});const port=probe.port!;await probe.stop(true);const proc=Bun.spawn([BIN,'reminders'],{env:{...process.env,PORT:String(port),DB_URL:`http://127.0.0.1:${fake.port}`,PGRST_JWT_SECRET:SECRET,STATUS_SECRET:'fixture-status',PUSH_CRON_SECRET:'fixture-cron',REMINDERS_SCHEDULE_DISABLED:'true',REMINDERS_JOBS_DISABLED:String(disabled),SSL_CERT_FILE:join(certdir,'cert.pem'),VAPID_PUBLIC_KEY:vapidPub,VAPID_PRIVATE_KEY:vapidJwk.d!,VAPID_SUBJECT:'https://fixture.example'},stdout:'ignore',stderr:'pipe'});for(let i=0;i<200;i++){if(await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.ok,()=>false))return{base:`http://127.0.0.1:${port}`,stop:async()=>{proc.kill();await proc.exited}};await Bun.sleep(10)}proc.kill();throw new Error(await new Response(proc.stderr).text())}
const native=await start();afterAll(async()=>{await native.stop();await fake.stop(true);await tls.stop(true);rmSync(root,{recursive:true,force:true})})
const call=(headers:any={},body:any={})=>fetch(native.base+'/',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
const cron=()=>call({'x-cron-secret':'fixture-cron'})
function reset(){pushes.length=0;requests.length=0;receipts.clear();lastRun=null;rollout='2000-01-01';pushStatus=201;finishFail=false;claimFail=false;clockReject=0;writeFail=false;writeCalls=0;written=[];deleted=[];subs=[{endpoint:`https://localhost:${tls.port}/fixture`,p256dh:peer,auth:Buffer.from(auth).toString('base64url'),user_id:'fixture-user'}]}
test('status authentication has priority and never triggers the reminder job',async()=>{
 reset();expect((await call()).status).toBe(401);expect((await call({'x-status-secret':'bad','x-cron-secret':'fixture-cron'},{health:true})).status).toBe(403);expect((await call({'x-status-secret':'fixture-status'},{})).status).toBe(400);expect(requests.length).toBe(0)
 expect(await(await call({'x-status-secret':'fixture-status'},{health:true})).json()).toEqual({lastRun:null});expect(requests.map(r=>r.path)).toEqual(['heartbeats']);expect(pushes.length).toBe(0)
 lastRun='garbage';expect((await call({'x-status-secret':'fixture-status'},{health:true})).status).toBe(500)
 const options=await fetch(native.base+'/',{method:'OPTIONS'});expect(options.headers.get('access-control-allow-origin')).toBe('*')
})
test('rollout/completed days skip writes; candidate mode blocks manual cron too',async()=>{
 reset();rollout='2999-01-01';expect((await(await cron()).json()).skipped).toBe('rollout');expect(requests.length).toBe(1)
 reset();lastRun=new Date().toISOString();expect((await(await cron()).json()).skipped).toBe('already completed');expect(pushes.length).toBe(0);expect(requests.every(r=>r.method==='GET')).toBe(true)
 const candidate=await start(true);try{expect((await fetch(candidate.base+'/',{method:'POST',headers:{'x-cron-secret':'fixture-cron'}})).status).toBe(503)}finally{await candidate.stop()}
})
test('daily delivery matches JS message/plan rows, commits receipt then heartbeat, and never repeats',async()=>{
 reset();const response=await cron();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({users:1,sent:1,failed:0});expect(pushes.length).toBe(1);expect(pushes[0].message).toEqual({...reminderFor(entries.map(e=>({...e,amount:Number(e.amount)})),today),url:'/'});expect(pushes[0].headers.ttl).toBe('43200');expect(pushes[0].headers.topic).toBe('bill-reminder-'+today.replaceAll('-',''))
 const firstMonth=today.slice(0,7),expected=missingMonthRows(plans.map(p=>({...p,amount:Number(p.amount)})),new Set(),Number(firstMonth.slice(0,4)),Number(firstMonth.slice(5))-1);expect(written.slice(0,expected.length)).toEqual(expected)
 const claim=requests.find(r=>r.path==='rpc/claim_reminder_delivery');expect(claim.body.p_endpoint_hash).toMatch(/^[a-f0-9]{64}$/);const finish=requests.find(r=>r.path==='rpc/finish_reminder_delivery');expect(finish.body.p_claim).toBe(claim.body.p_claim);expect(finish.body.p_outcome).toBe('sent');expect(requests.at(-1).path).toBe('heartbeats');expect(requests.at(-1).method).toBe('POST');
 expect((await(await cron()).json()).skipped).toBe('already completed');expect(pushes.length).toBe(1)
})
test('gone subscriptions resolve; existing sent receipts never send again',async()=>{
 reset();pushStatus=410;expect((await(await cron()).json()).removed).toBe(1);expect(pushes.length).toBe(1);expect(deleted.length).toBe(1)
 reset();const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subs[0].endpoint))).toString('hex');receipts.set(hash,'sent');expect(await(await cron()).json()).toMatchObject({alreadySent:1,sent:0});expect(pushes.length).toBe(0)
})
test('failed/lost acknowledgements remain unresolved and do not duplicate a push',async()=>{
 reset();finishFail=true;expect((await cron()).status).toBe(503);expect(pushes.length).toBe(1);expect(lastRun).toBeNull();finishFail=false;expect((await cron()).status).toBe(503);expect(pushes.length).toBe(1);expect(requests.filter(r=>r.path==='rpc/finish_reminder_delivery').length).toBe(1)
 reset();claimFail=true;expect((await cron()).status).toBe(503);expect(pushes.length).toBe(0);expect(lastRun).toBeNull()
 reset();pushStatus=503;expect((await cron()).status).toBe(503);expect(pushes.length).toBe(1);expect(requests.find(r=>r.path==='rpc/finish_reminder_delivery').body.p_outcome).toBe('failed');expect(lastRun).toBeNull()
})
test('unknown push result becomes uncertain, never retried automatically',async()=>{
 reset();subs[0].endpoint='https://localhost:9/unreachable';expect((await cron()).status).toBe(503);expect(requests.find(r=>r.path==='rpc/finish_reminder_delivery').body.p_outcome).toBe('uncertain');expect((await cron()).status).toBe(503);expect(requests.filter(r=>r.path==='rpc/finish_reminder_delivery').length).toBe(1);expect(pushes.length).toBe(0);expect(lastRun).toBeNull()
})
test('only the explicit pre-SQL JWT clock rejection can replay a write',async()=>{
 reset();clockReject=2;expect((await cron()).status).toBe(200);expect(writeCalls).toBeGreaterThanOrEqual(3);expect(written.filter(r=>r.due_date.startsWith(today.slice(0,7))).length).toBe(1)
 reset();writeFail=true;expect((await cron()).status).toBe(500);expect(writeCalls).toBe(1);expect(pushes.length).toBe(0);expect(lastRun).toBeNull()
},10000)
