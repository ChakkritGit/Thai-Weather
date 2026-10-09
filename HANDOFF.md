# HANDOFF
อัปเดต: 2026-10-09 17:28 ICT โดย Codex · งาน: สรุปการคำนวณพยากรณ์ API และสถานะเว็บล่าสุด · แผน: TASK_PLAN.md ปิดและลบแล้ว · Phase/sub-task: Phase 3 ผ่าน; บันทึกและ push ตามคำสั่งผู้ใช้

## สถานะ

- งาน A/C1/C2/B และ D เสร็จ; โค้ดล่าสุด `d6907a1` อยู่บน `origin/claude/vigilant-ride-i3yr1m` แล้ว (fetch และเทียบ HEAD กับ upstream ได้ 0/0)
- D แยก "ตอนนี้ (เรดาร์)" / "พยากรณ์จากแบบจำลอง" พร้อมเวลา TH/EN; ใช้ nowcast request เดียว; หมายเหตุเมื่อเรดาร์พบฝนแต่โมเดลแสดง 0% อิงจุด เวลา และความสดของข้อมูล
- แก้ service-worker notification URL ให้ same-origin, ปิด inherited HTTP healthcheck เฉพาะ verify worker, ให้ Next cache เป็นของ node และทำวันที่ TH/EN ให้ตรงกันระหว่าง Node/Chrome
- deploy web และ recreate verify เสร็จ; API ไม่ restart และ source ใน container ตรงกับ repo ทั้ง 41 Python files
- ตรวจผ่าน: backend 176 tests + ruff, frontend 62 tests + typecheck, production build, browser TH/EN/mobile/timeline/chart/PWA/routes/404 ไม่มี JavaScript errors; cache write ด้วย uid1000 ผ่าน
- ไม่มีไฟล์ implementation ค้างครึ่งทาง; TASK_PLAN.md / REVIEW_FEEDBACK.md ลบแล้วตาม workflow
- Forecast ปัจจุบัน `20261009T0500Z-open-meteo`, model `gfs_seamless`, created 12:49 ICT, ensemble 8, coarse 27.8 กม. / fine 2.2 กม.; `observations_used=0` เป็น run เก่า
- verify ส่งข้อมูลสถานีเข้า API สำเร็จ 26 สถานี (กัน 10 สถานีไว้ตรวจความแม่นยำ); การใช้สถานีใน run ใหม่ยังรอตรวจเมื่อรอบคำนวณถัดไปเสร็จ
- ยังไม่เริ่มในรอบนี้: VPS/HTTPS และ MOS/ปรับค่าฟิสิกส์จากผล verification หลายสัปดาห์

## API รับ Open-Meteo แล้วคำนวณอะไร

1. `backend/app/sources/openmeteo.py` รับพยากรณ์ GFS ผ่าน Open-Meteo บนกริด 0.25° (~27.8 กม.): อุณหภูมิ จุดน้ำค้าง ฝน CAPE ลม เมฆ รังสี และความกดอากาศ; ใช้ `elevation=nan` / `cell_selection=nearest` เพื่อปรับรายละเอียดพื้นที่เอง
2. `backend/app/downscale/pipeline.py` กระจายข้อมูลด้วย bilinear interpolation ลงกริด 0.02° (~2.2 กม.) แล้วปรับตามภูมิประเทศและสภาพผิวพื้น
3. อุณหภูมิปรับตามความสูง หุบเขา เมือง และสัดส่วนบก/ทะเล; ความชื้นคำนวณใหม่ตามอุณหภูมิ/ความกดอากาศ; ลมปรับตามภูมิประเทศและความขรุขระผิวพื้น
4. ฝนปรับตามลมยกตัวบนภูเขา/ชายฝั่งและคำนวณ stochastic ensemble 8 สมาชิก; โอกาสฝนของ fine grid มาจากสัดส่วนสมาชิกที่ฝนถึง 0.5 มม./ชม. พร้อม spatial smoothing (ไม่ได้รับ precipitation probability จาก Open-Meteo โดยตรง); coarse comparison ใช้เกณฑ์ฝนเดียวกันให้ค่า 0/100%
5. `backend/app/downscale/observations.py` ใช้ค่าคลาดเคลื่อนอุณหภูมิจากสถานีจริงเมื่อมีข้อมูลใกล้เวลาเริ่ม run แล้วลดน้ำหนักการแก้ตามเวลาพยากรณ์
6. คำนวณดัชนีความร้อน โอกาสฝนหนัก/พายุ สรุปรายชั่วโมง/รายวัน/จังหวัด และแจ้งเตือน แล้วบันทึกให้ API/หน้าเว็บอ่าน; scheduler รับข้อมูลต้นทางและคำนวณรอบใหม่ทุก 360 นาที

- ผลเป็นพยากรณ์ที่ปรับละเอียดจาก GFS (downscaling); ความละเอียด 2.2 กม. คือกริดผลคำนวณ และต้องประเมินความแม่นยำกับข้อมูลสถานี
- RainViewer radar/nowcast และ GDACS cyclones เป็นอีก pipeline; ฝนเรดาร์ยังไม่ได้ป้อนกลับไปปรับพยากรณ์ GFS/downscaling จึงอาจพบฝนปัจจุบันแม้โมเดลแสดง 0%

## ขั้นต่อไป (เรียงลำดับ ทำได้ทันที)

1. ตรวจ `git status` / `git diff` และสถานะจริงก่อนทำต่อ; งานรอบนี้จบแล้ว ไม่มี coding task ใหม่ที่ค้าง
2. หลังรอบอัตโนมัติประมาณ 21:48 ICT (บวกเวลารับข้อมูล/คำนวณ) ตรวจ `/api/v1/meta`: run ใหม่, `observations_used > 0` และ `status.last_error=null`; ถ้ายังเป็น 0 ให้ดูเวลา/ความสดของ observations และ logs
3. ไม่ต้อง rebuild/restart API ตามข้อความ HANDOFF เก่า เพราะ API มี source ล่าสุดแล้ว; restart จะเลื่อนรอบถัดไปอีก 6 ชั่วโมง

## การตัดสินใจ + เหตุผล

- ผู้ใช้สั่งไม่ใช้ Claude และอนุญาตงานที่จำเป็นในขอบเขตทั้งหมด; ใช้ Codex implementation/review และไม่ขออนุมัติแผนซ้ำ
- ผู้ใช้ยืนยันใช้ RainViewer; VPS และการปรับค่าคงที่ยังอยู่นอกงานรอบนี้
- ผู้ใช้ล่าสุดสั่ง "เขียนใน Handoff และ push": รอบนี้จึงเก็บและ commit HANDOFF.md ตามคำสั่งล่าสุด (แทนแนวทางปกติที่เป็นไฟล์ชั่วคราวไม่ commit)
- Branch มีชื่อ `claude/...` จาก session เดิม; ไม่มีการเรียก Claude ในงาน Codex รอบนี้

## คำสั่งตรวจ + ผลล่าสุด

- Backend: container ทดสอบชั่วคราว mount source read-only, `python -m pytest -q -p no:cacheprovider` → 176 passed; `python -m ruff check --no-cache app tests verify` → ผ่าน
- Frontend: `npm.cmd test` → 62 passed; `npm.cmd run typecheck` → ผ่าน; `git diff --check` → ผ่าน
- Deploy: `docker compose up -d --build --no-deps web` → production build/deploy ผ่าน; `docker compose up -d --no-deps verify` → worker Up ไม่มี false unhealthy
- Browser: `node frontend/node_modules/.cache/thwx-qa/browser-qa.cjs` → passed, nowcastRequests=1, browserErrors=[]; report/screenshots อยู่ directory เดียวกัน (Git ignore)
- Cache: `node frontend/node_modules/.cache/thwx-qa/cache-probe.cjs` → runtimeUid=1000, cacheUid=1000, cacheWrite=passed; logs web ไม่มี EACCES
- Live: `/api/v1/meta` → source open-meteo, status idle, last_error=null; `/api/v1/push/public-key` ผ่าน web proxy → public key length87 (ไม่แสดง keys/secrets)

## สิ่งที่รันค้าง / ข้อควรระวัง

- Root compose: API localhost:8000, web localhost:3000, verify worker; API started `2026-10-09T08:48:55.440367715Z` (15:48:55 ICT), run_on_startup=false, refresh 360 นาที
- Next dev port3001 ปิดแล้ว; Chrome QA container/port9222 ลบและปิดแล้ว; ไม่มี Codex subagent/background task ค้าง
- .claude/worktrees จาก session เดิมยังอยู่ ไม่ได้แก้หรือลบ; อย่าเริ่ม agent เก่าหรือ merge ซ้ำโดยไม่ตรวจ commits
- อย่าแสดง `.env`/credentials; Windows sandbox ของ session นี้เริ่ม shell ไม่ได้ (`helper_unknown_error: setup refresh had errors`) จึงต้อง exec escalation ตามระบบ
