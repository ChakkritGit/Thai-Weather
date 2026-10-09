# HANDOFF
อัปเดต: 2026-10-09 16:00 โดย Claude Code · งาน: แตกงานขนาน (A เสร็จ; C1, C2, B กำลังทำใน worktree) · แผน: ใน prompt ของแต่ละ agent · Phase/sub-task: รอ C1/C2/B ส่งงาน → รีวิว → merge ตามลำดับ C1 → C2 → B

## สถานะ
- เสร็จแล้ว (commit, ยังไม่ push): 8f15c0f verification · 070fe5c station-correction feed · a2a6469 nowcast + cyclones (backend 112 tests, frontend 21 tests)
- deploy: web ใหม่แล้ว; api ยังเป็น build ก่อนแก้รอบรีวิว (cyclone category/URL) — restart api หลังรอบ 20:37 ICT
- ยังไม่เริ่ม: Sub-task 1–4 ของแผนเส้นกริด

## ขั้นต่อไป
1. (อนุมัติแล้ว) subagent กำลังแก้ backend/app/core/grid.py, frontend render.ts, WeatherMap.tsx, MapPage.tsx, PointPanel.tsx, TimeSeriesChart.tsx, dict.ts, format.ts, base.css — ตรวจ git diff ก่อนทำต่อ
2. Phase 2 subagent (sonnet) → Phase 3 รีวิว → deploy web
3. หลัง 20:37 ICT: ตรวจ /api/v1/meta observations_used > 0 แล้ว `docker compose up -d --build api verify` (THWX_RUN_ON_STARTUP=false อยู่แล้ว)
4. จากนั้น: วางแผน UI ระดับโปรดักชัน (ดูหัวข้อด้านล่าง)
5. ภายหลัง: PWA + Web Push (ต้องขึ้น VPS)

## การตัดสินใจ + เหตุผล
- ผู้ใช้อนุมัติแก้เส้นกริดหลัง nowcast + ขอเพิ่มเส้นกริด 2.2 กม. (แสดงตั้งแต่ zoom 8)
- แก้ความเข้าใจผิดของผมก่อนหน้า: ภาพช่องสี 27.8 กม. ไม่ได้ถูกบีบ (วาดตามตำแหน่งจริง) — ผิดแค่เส้นกริด + extent ที่ backend รายงาน
- RainViewer ฟรีเฉพาะ personal/educational — ผู้ใช้ยืนยันใช้

## UI ระดับโปรดักชัน (ผู้ใช้ขอ; ทำหลังงานเส้นกริด)
- ทิศทาง: ผู้ใช้ทั้งทั่วไป (หน้าแรก "ที่ฉันอยู่" แบบ Apple Weather) + ผู้สนใจ (โหมดแผนที่เต็ม); สไตล์เรียบแบบ Apple Weather + น่าเชื่อถือแบบหน่วยงาน/สื่อ; รอบแรก = แก้ความน่าเชื่อถือ + ขัดเกลาทั้งเว็บ
- ปัญหาจาก audit: ข้อมูลเตือนภัยขัดกันระหว่างหน้า — สาเหตุ: คำว่า "เตือนภัย" ใช้ 2 ความหมาย: ระดับดัชนีความร้อนของกรมอนามัย (extremeCaution 32–41°C, severity 1) กับชั้นความรุนแรงของระบบแจ้งเตือน (severity 2 = "เตือนภัย", 1 = "เฝ้าระวัง") → ตารางจังหวัดโชว์ "เตือนภัย" แต่หน้าเตือนภัย (min_severity 2) = 0; และ HI 32–41 เป็นค่าปกติของไทย → ทุกจังหวัด (77) ติดเตือนทุกวัน = noise (ข้อมูลสด: 09–10 ต.ค. heat extremeCaution 77 จังหวัด) → แผน UI: แยกศัพท์ระดับอันตราย vs ชั้นการแจ้งเตือน, ทบทวนเกณฑ์ว่าเริ่มแจ้งที่ HI ≥ 41; "22 กม." ใน Method/SEO/design-system; วันท้ายข้อมูลไม่ครบแต่สรุปเหมือนครบ; nav มี Design system; mobile ล้นจอ + แถบว่างใต้ layout; การ์ดว่างหน้าเตือนภัย; กราฟไม่มี tooltip + ตัวเลขแกนใหญ่; ศัพท์เทคนิคในหน้าหลัก
- audit ทำด้วย: `docker run --rm --network thai-weather_default -v <out>:/out zenika/alpine-chrome:124 --no-sandbox --headless=new --window-size=1440,900 --virtual-time-budget=15000 --screenshot=/out/x.png http://web:3000/` (WebGL map ไม่ render)

## คำสั่งตรวจ
- backend/frontend: ดู TASK_PLAN.md (Verification commands)

## สิ่งที่รันค้าง / ข้อควรระวัง
- docker compose (root): api, web, verify รันอยู่; .env มี THWX_RUN_ON_STARTUP=false
- รอบพยากรณ์ถัดไป ≈ 13:37Z (20:37 ICT) — ห้าม restart api ก่อนนั้น ไม่งั้นรอบเลื่อนออกไปอีก 6 ชม.

## แตกงานขนาน (ผู้ใช้สั่ง 2026-10-09 15:25: "แตก agent ออกไปทำให้หมดเลยทีเดียว" = อนุมัติให้วางแผน+ลงมือพร้อมกันโดยไม่รออนุมัติแผนทีละงาน)
- A: เส้นกริด — เสร็จ commit 9797181, deploy web แล้ว (backend grid.describe จะไปกับ api restart หลัง 20:37); หมายเหตุ merge: key i18n model22→modelCoarse, fine2→fineModel, t(key, params) รองรับ {placeholder}
- B (worktree แยก, commit ใน branch ตัวเอง): PWA + Web Push แจ้งเตือนพายุ/ฝนตามตำแหน่ง (ทดสอบ localhost ได้; ใช้งานจริงต้องขึ้น VPS)
- C1: เสร็จ merge แล้ว fc40659 (branch worktree-agent-a3e9df4b7e9eebe61) — ยังไม่ deploy (frontend ใหม่ต้องคู่กับ api ใหม่ ไม่งั้นป้ายเตือนจะเป็นเกณฑ์เก่า)
- C2 (worktree): ขัดเกลาภาพรวม — Shell/โลโก้/nav (ซ่อน Design system)/footer, layout เต็มจอ + มือถือ, LayerPicker/Legend/Timeline, กราฟ tooltip, ตัวเลข tabular, skeleton/empty/404, CTA "ตำแหน่งของฉัน"
- ผมรีวิว + merge ตามลำดับ: A → C1 → C2 → B (dict.ts/base.css/layout.tsx จะ conflict — resolve เอง)
- ไม่ทำตอนนี้: MOS/ปรับค่าคงที่ (ต้องรอข้อมูล 2–3 สัปดาห์), deploy VPS (ต้องใช้สิทธิ์เข้า VPS ของผู้ใช้)
- หมายเหตุ: worktree ของ C1/C2 สร้างจาก b1183fa (เก่า) — ส่งข้อความให้ C2 rebase บน main ก่อนส่ง; B สร้างจาก a2a6469 (มี nowcast)
- Deploy: รอรวม C2 + B แล้ว deploy ทีเดียว (`docker compose up -d --build`) — restart api แต่ละครั้งเลื่อนรอบพยากรณ์ +6 ชม.
- งาน D (ผู้ใช้แจ้ง 16:40): แผงจุดแสดง "กำลังมีฝนหนักบริเวณนี้" (เรดาร์ 15:10) แต่ "โอกาสฝน 0%" (โมเดล GFS ช่วง 15:00) — ไม่ใช่บั๊กคำนวณ แต่ UI ไม่บอกแหล่ง → ทำหลัง merge B (B แก้ NowcastCard): แยก "ตอนนี้ (เรดาร์)" กับ "พยากรณ์จากแบบจำลอง" ให้ชัด, เมื่อเรดาร์เห็นฝนให้ stat โอกาสฝนแสดงหมายเหตุ "เรดาร์ตรวจพบฝนขณะนี้ — แบบจำลองไม่ได้คาด", ชี้แจงว่าโมเดล 27.8 กม. จับเซลล์ฝนขนาดเล็กไม่ได้
- 2026-10-09 ~17:00 ICT: B merge ค้างใน working tree (ยังไม่ commit; conflict dict.ts แก้แล้ว, staged) — รอรันเทสต์ไม่ได้เพราะ Docker Desktop ค้าง (docker CLI ไม่ตอบ, container ออกเน็ตไม่ได้: nowcast last_error ConnectTimeout ตั้งแต่ 08:35Z) → ต้อง restart Docker Desktop (รอผู้ใช้อนุญาต) แล้วรัน backend/frontend checks → commit merge B
