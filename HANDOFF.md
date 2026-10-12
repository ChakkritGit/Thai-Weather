# HANDOFF
อัปเดต: 2026-10-12 17:45 ICT โดย Codex · งาน: โอกาสฝน 2.2 กม. และแผน UI/เรดาร์/Push · แผน: docs/ui-radar-push-plan.md · Phase/sub-task: งานโอกาสฝน Phase 3 ผ่าน; แผนเพิ่มเติมพร้อมส่ง

## สถานะ
- แก้ PointPanel.tsx/dict.ts: โอกาสฝนหลักและ radar note อิง fineKm; coarse pop อยู่กราฟเปรียบเทียบ; เพิ่มป้าย comparison; ยังรอ verification/review
- แก้ ProvinceView.tsx และ app/provinces/[slug]/page.tsx: ส่ง fine/coarse resolution จาก meta ที่โหลดอยู่แล้ว; แหล่ง fine และ global comparison แยกชัด ไม่ใช้ค่าความละเอียด hardcode
- ปรับ nowcast.test.ts เดิมให้ตรวจข้อความกับ fine=2.2; ยังไม่มี backend changes
- ตรวจโค้ดแล้ว: map หลัก, point pop, province hourly pop ใช้ fine อยู่แล้ว; PointPanel แสดง coarse pop ใต้การ์ดหลักและส่ง coarseKm ให้หมายเหตุของ fine จึงต้องแก้แหล่งอ้างอิง/การจัดวาง
- แผนใน TASK_PLAN.md: ค่าหลัก/หมายเหตุอิง fine; coarse pop อยู่ส่วนเปรียบเทียบ; ตรวจ TH/EN/mobile และ browser fixture fine/coarse ต่างกัน
- Live ล่าสุด run 20261012T0700Z-open-meteo, fine=2.2, coarse=27.8, idle, last_error=null; ระบบทำรอบอัตโนมัติใหม่แล้ว
- POST /api/v1/runs รับคำสั่ง 202 scheduled; รอบใหม่เสร็จ 09:41 ICT, run 20261012T0200Z-open-meteo, status idle, last_error=null
- /api/v1/meta ครอบคลุม 2026-10-12 09:00 ถึง 2026-10-14 08:00 ICT; observations_used=26; log คำนวณเสร็จใน 15.4 วินาที หลังดึงต้นทางประมาณ 6.5 นาที
- ก่อนสั่งรอบใหม่ใช้ run 20261009T0500Z-open-meteo ซึ่งสิ้นสุด 2026-10-11 11:00 ICT
- API เริ่ม 2026-10-12 08:35:23 ICT; ค่าที่ใช้งานจริง run_on_startup=False, refresh_minutes=360, horizon_hours=48, source=open-meteo, fallback_to_demo=False
- scheduler รอครบ 6 ชั่วโมงหลังเริ่มก่อนทำรอบแรก; อัตโนมัติรอบถัดไปประมาณ 14:35 ICT บวกเวลาดึงและคำนวณ
- งานโค้ดเดิมผ่าน review และ push แล้วตาม HANDOFF ก่อนหน้า; ยังไม่เริ่ม VPS/HTTPS หรือปรับ MOS

## ขั้นต่อไป
1. งานโอกาสฝนเสร็จและ deploy เฉพาะ web localhost3000 แล้ว; git diff --check/tests/typecheck/build/browser QA ผ่าน
2. งานใหม่ 4 ข้อยังไม่ได้ implement; อ่าน docs/ui-radar-push-plan.md แล้วสร้าง TASK_PLAN.md สำหรับ implementation ครั้งต่อไป
3. ผู้ใช้อนุญาตเตรียมแผนและ push พร้อมแบ่ง agent; รอบนี้มีเวลา3นาที จึงส่งงานที่ตรวจผ่านและแผนเพิ่มเติม; ไม่ถือว่าฟีเจอร์ใหม่เสร็จ

## การตัดสินใจ + เหตุผล
- คำสั่งล่าสุด: “เสร็จแล้ว commit push”, “เตรียมแผนงานแล้ว push ได้เลยแตก agent ก็ได้”, “ให้ 3 นาที”; ได้แผน read-only จาก agents ทั้งสามแล้ว และเขียนแผนถาวรที่จะ push ใน docs/ui-radar-push-plan.md
- ขณะตรวจงานเดิม ผู้ใช้เพิ่มงาน: Play เรดาร์แบบ realtime, ย้ายตั้งค่าแจ้งเตือนไปหน้าอื่น, เพิ่ม Web Push ความร้อน และเอาโลโก้/ชื่อออกจาก navbar; ยังไม่ได้เริ่ม implementation ของงานเพิ่ม ต้องจัด Phase 1 แผนรวมและรออนุมัติตาม AGENTS.md
- เสนอ Play เล่นเฟรมย้อนหลัง→ล่าสุดและต่อเฟรมใหม่อัตโนมัติ (ส่งคำถามตัวเลือกแล้ว ยังไม่มีคำตอบ); หน้าแจ้งเตือนเป็นตำแหน่งตั้งค่าที่เหมาะสมสำหรับแผน; heat push อิง fine heat index/เกณฑ์เดิม ต้องกำหนด cutoff และช่วงล่วงหน้า
- อธิบายแก่ผู้ใช้แล้วว่า Push ปัจจุบันส่งพายุฝน/ฝนหนักภายใน45นาที และพายุหมุนเข้าใกล้300กม.ภายใน48ชม./เขตลมแรง พร้อม quiet hours/cooldown
- ผู้ใช้ล่าสุดอนุมัติแผนโอกาสฝน 2.2 กม. ทั้งหมด และ 27.8 กม. เฉพาะเปรียบเทียบ พร้อม Codex implementation/review แทน Sonnet/Opus ที่เรียกไม่ได้
- ใช้ chakkritdev-workflow ตาม Phase 1 → approval → implementation → review; approval มีผลแล้ว
- ผู้ใช้ถามวิธีดึงทันที; ใช้ endpoint ที่มีอยู่เพื่อสั่งรอบนี้ ไม่แก้โค้ดหรือ restart
- การเปลี่ยนให้ดึงทันทีทุกครั้งที่เปิดระบบทำได้ด้วย THWX_RUN_ON_STARTUP=true แต่ยังไม่ได้เปลี่ยน
- ผู้ใช้เดิมสั่งเก็บ HANDOFF และ push; จึงรักษาไฟล์นี้ไว้ ไม่ commit/push ในงานนี้จนมีคำสั่ง

## คำสั่งตรวจ + ผลล่าสุด
- docker compose ps: api healthy, web/verify up
- docker inspect เวลาเริ่ม API และอ่าน get_settings เฉพาะค่าที่ไม่ลับ: ผ่าน
- POST /api/v1/runs: 202; /api/v1/meta หลังเสร็จ: run ใหม่วันที่ 12, วันพยากรณ์ 12–14, idle, last_error=null, last_success=2026-10-12T02:41:07.301197+00:00
- http://localhost:3000/api/v1/meta: run 20261012T0200Z-open-meteo, วันพยากรณ์ 12–14, idle, last_error=null; git diff --check ผ่าน
- git status --short: ว่างก่อนอัปเดต HANDOFF
- frontend npm.cmd test: 62 passed; npm.cmd run typecheck: ผ่าน
- docker compose build web: production npm run build ผ่าน; image thai-weather-web:latest ใหม่ พร้อม deploy
- fine-source-probe.py (Git ignore) ผ่าน: point fine/coarse แยก, default pop layer ตรง saved fine grid, mean ของ 77 จังหวัดตรง fine grid ภายใน quantization tolerance, province API ตรง fine summaries
- browser QA หลังแก้ English sort locale: passed, browserErrors=[]; fine0/coarse100, fine35/coarse0/100, TH/EN/mobile/chart/table/map compare/province/PWA/404 ผ่าน; report อยู่ frontend/node_modules/.cache/thwx-qa/browser-qa.json (Git ignore)

## สิ่งที่รันค้าง / ข้อควรระวัง
- root compose: api localhost:8000, web localhost:3000, verify worker
- Chrome QA container thwx-rain-qa-chrome เปิด port127.0.0.1:9222 network thai-weather_default; ต้องลบเมื่อทดสอบเสร็จ
- Preview web thwx-rain-qa-web localhost3001 และ Chrome thwx-rain-qa-chrome localhost9222 ต้อง cleanup หลัง push; root web เป็น imageใหม่ที่ผ่าน QA แล้ว; API ไม่ restart/ไม่มี fetch ใหม่
- Next dev port3002 หยุดแล้ว; agents ทำแผนเท่านั้น ไม่ได้แก้ไฟล์
- sandbox เริ่ม shell ไม่ได้ helper_unknown_error; ใช้ escalation ที่ผู้ใช้อนุมัติ
- ไม่แสดง .env/admin token/credentials; .claude/worktrees เดิมยังอยู่ ไม่ได้แตะ
