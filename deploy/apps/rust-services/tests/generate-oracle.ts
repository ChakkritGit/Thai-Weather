// Regenerate only when deliberately reviewing the legacy wire/storage contract.
import { writeFileSync } from 'node:fs'
import { Tiered, LogTail, TIERS } from '../../services/tests/oracle/metrics'
const now=1792009800
Date.now=()=>now*1000
const hist=new Tiered(), logs=new LogTail(hist,'/nonexistent')
for(let i=0;i<50;i++)hist.add(1792000000+i*7,{cpu_user:(i%13)*1.5,mem_used:1000+i})
const lines=[
 '[14/Oct/2026:20:07:33 +0000] - 200 200 - GET https example.test "/api/v1/meta?fixture=1" [Client 192.0.2.1] [Length 512] [Gzip -]',
 '[14/Oct/2026:20:07:40 +0000] - 404 404 - GET https example.test "/nope/123" [Client 192.0.2.2] [Length 20] [Gzip -]',
 '[14/Oct/2026:20:08:01 +0000] - 200 200 - GET https dock.example.test "/_next/static/x.js" [Client 192.0.2.1] [Length 900] [Gzip -]',
 '[14/Oct/2026:20:08:11 +0000] - 502 502 - GET https example.test "/c/0123456789abcdef0123/logs" [Client 192.0.2.3] [Length 90] [Gzip -]',
 '[14/Oct/2026:20:08:12 +0000] HIT 304 - - HEAD https example.test "/api/v1/meta" [Client 192.0.2.1] [Length 0] [Gzip -]',
 '[14/Oct/2026:20:09:00 +0000] 444 - GET http example.test "/" [Client 192.0.2.4] [Length 0] [Gzip -]',
]
for(const line of lines)logs.ingest(line,line.includes('] 444 -'),null)
const fixture={now,lines,hist:hist.dump(),series:Object.fromEntries(Object.keys(TIERS).map(t=>{const [times,cols]=hist.series(t,now);return [t,{count:times.length,first:times[0],last:times.at(-1),cols:Object.fromEntries(Object.entries(cols).map(([key,col])=>[key,col.flatMap((v,i)=>v===null?[]:[[i,v]])]))}]})),top:logs.top(now-86400)}
writeFileSync(new URL('./fixtures/bun-contract.json',import.meta.url),JSON.stringify(fixture)+'\n')
console.log('Wrote deterministic Bun history/series/log/top fixture')
