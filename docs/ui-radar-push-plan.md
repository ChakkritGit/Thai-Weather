# แผนเพิ่มเติม: เรดาร์ การแจ้งเตือน และ navbar

สถานะ: จัดแผนแล้ว ยังไม่ได้เขียนฟีเจอร์ด้านล่าง
อัปเดต: 2026-10-12 โดย Codex
ผู้ใช้อนุญาตเตรียมแผน แบ่ง agent และ push; กำหนดเวลา 3 นาที จึงส่งมอบงานโอกาสฝนที่ตรวจผ่านแล้วและแผนนี้ก่อน

## 1. Play เรดาร์ย้อนหลังถึงล่าสุด และรับเฟรมใหม่

Target files: `backend/app/nowcast/service.py`, `backend/app/api/routes.py` หรือ router history แยก, `frontend/src/lib/api.ts`, `frontend/src/lib/useRadar.ts`, `frontend/src/views/MapPage.tsx`, timeline สำหรับเรดาร์, `backend/tests/test_nowcast_api.py`

- เก็บภาพเรดาร์ตรวจวัดย้อนหลังราว 1 ชั่วโมงแบบจำกัดจำนวน/อายุ เรียงตามเวลาจริง พร้อม frame ID/timestamp คงที่
- แยก history ที่ใช้เล่นภาพออกจากข้อมูล 3 เฟรมล่าสุดที่ใช้คำนวณ motion; รักษา endpoint nowcast/lead เดิม
- มี API รายชื่อเฟรมและ binary layer ตาม frame ID; metadata กับภาพต้องมาจาก snapshot เดียวกัน; handle frame ที่ถูก evict และข้อมูลเก่า
- เมื่อเปิดเรดาร์ ปุ่ม Play เล่นเฟรมที่ตรวจวัดย้อนหลังไปถึงล่าสุด; ตรวจเฟรมใหม่ตามรอบรับข้อมูลและเพิ่มโดยไม่ต้อง reload
- ใช้ radar index/playback แยกจาก forecast step; ปิดเรดาร์แล้ว Play พยากรณ์รายชั่วโมงทำงานตามเดิม
- แสดงเวลาเฟรมจริง คำว่าเรดาร์ย้อนหลัง/ล่าสุด และสถานะ loading/stale; ไม่แสดงภาพคาดการณ์ lead เป็นภาพตรวจวัดจริง
- preload/cache เฟรมข้างเคียง และรักษาภาพที่ใช้งานได้เมื่อ refresh ล้มเหลว

Acceptance: Play เปลี่ยนภาพและ timestamp ตามลำดับ; เฟรมใหม่เพิ่มโดยไม่ซ้ำ; เลือกย้อนหลังไม่ถูกเปลี่ยนตำแหน่งเมื่อ poll; forecast index ไม่เปลี่ยนจาก radar play; stale/error ไม่ทำให้แสดงภาพผิดเวลา; ตรวจ API retention และ browser TH/EN/mobile

## 2. ย้ายตั้งค่า Web Push ไปหน้าแจ้งเตือน

Target files: `frontend/src/components/NowcastCard.tsx`, `PushControl.tsx`, ส่วน `PushSettings` ใหม่, `frontend/src/lib/usePush.ts`, `paths.ts`, `frontend/src/views/AlertsPage.tsx`, `frontend/src/app/alerts/page.tsx`, `frontend/src/i18n/dict.ts`

- ย้ายฟอร์มเปิด/ปิด ประเภทแจ้งเตือน quiet hours และส่งทดสอบไป `/alerts#notifications`
- แผนที่เหลือลิงก์ไป `/alerts?lat=…&lon=…#notifications` เพื่อส่งจุดที่เลือก
- ลำดับตำแหน่ง: query ที่ถูกต้อง → subscription ที่บันทึกแล้ว → ให้ผู้ใช้กดใช้ตำแหน่งปัจจุบันหรือเลือกบนแผนที่; ไม่เลือกพิกัดแทนผู้ใช้
- ใช้ usePush controller เดียว แยกจุดที่เลือกจากจุด subscription; ไม่เขียนทับพิกัด/preferences จนกดบันทึก
- ขอ permission เฉพาะเมื่อผู้ใช้กด; หน้าตั้งค่ายังแสดงได้เมื่อพยากรณ์ warming/ไม่พร้อม

Acceptance: ไม่มีฟอร์มตั้งค่าบนแผนที่; ลิงก์ส่งพิกัดถูกต้อง; เข้า alerts โดยตรงจัดการ subscription เดิมได้; ย้ายหน้าหรือเปลี่ยนภาษารักษาค่าตั้ง; ไม่ขอ permission หรือบันทึกโดยอัตโนมัติ; ตรวจ TH/EN/mobile และ error states

## 3. เพิ่ม Web Push ความร้อนจากกริด 2.2 กม.

Target files: `backend/app/push/store.py`, `dispatcher.py`, `service.py`, `messages.py`, heat evaluator แยก, `backend/app/main.py`, `backend/app/api/routes.py`, `backend/tests/test_push.py`, frontend PushControl/push.ts/push.test.ts/dict.ts, `docs/PUSH.md`

- เพิ่ม `heat` preference และ checkbox; ค่าเดิมที่ไม่มี heat เป็น false; เปิดใช้ได้โดยเลือก heat อย่างเดียว
- ประเมิน Heat Index ของจุดที่บันทึกจาก fine grid ใน 3 ชั่วโมงข้างหน้า; ใช้เกณฑ์จาก weather_scales ที่ระบบมีอยู่: อันตรายเริ่ม 41°C, อันตรายมากเริ่ม 54°C
- ไม่ส่งเมื่อ run เก่า/หมดช่วงเวลา/ไม่มีข้อมูล/ค่าผิดปกติ หรือจุดอยู่นอกพื้นที่; กำหนด stale policy ให้ตรงรอบพยากรณ์
- ใช้ quiet hours และ cooldown 6 ชั่วโมง; ระดับรุนแรงขึ้นส่งซ้ำได้หลังผ่าน quiet hours; failed send ไม่กิน cooldown
- worker ทุก 5 นาทีทำงานได้แม้ปิดเรดาร์; กัน overlap และหยุด/join ก่อนปิด subscription store
- บันทึก cooldown ข้าม restart; เปลี่ยนพิกัดแล้วไม่ใช้สถานะความร้อนของจุดเก่า
- ข้อความระบุว่าเป็นดัชนีความร้อนตามพยากรณ์ พร้อมสถานที่ เวลา และลิงก์แผนที่

Acceptance: tests ใช้ fake clock/provider/sender ครอบคลุมค่า 41/54 และช่วง 3 ชม., opt-in, subscription เก่า, quiet hours, cooldown/escalation, stale/expired/missing data, failed send และ shutdown; ไม่ส่ง notification จริงในการทดสอบ

## 4. เอาโลโก้และชื่อออกจาก navbar ทุกหน้า

Target files: `frontend/src/components/Shell.tsx`, `frontend/src/design/base.css` เฉพาะ layout/spacing

- เอา brand/logo/name ออกจาก Header กลางที่ทุกหน้าใช้ร่วมกัน
- คงเมนูนำทาง ภาษา ธีม และ bottom navigation; ปรับระยะห่างตาม Design System กลาง

Acceptance: desktop/mobile ทุกหน้ามี navbar ที่ไม่แสดง logo/name; เมนูและ keyboard focus ใช้งานได้ ไม่มี overflow; ไม่ลบ logo component ที่ยังใช้ส่วนอื่น

## การแบ่งงานและการตรวจรวม

- Agent เรดาร์: service/history API client/useRadar/MapPage/timeline และ tests เรดาร์
- Agent ความร้อน: push backend/worker/evaluator/messages และ tests ความร้อน
- Agent หน้าตั้งค่า: frontend push settings/AlertsPage/query/paths/dict/types และ tests
- Root: navbar, backend routes integration, review shared-file diff, production build/browser QA/deploy/commit/push
- ให้ root เป็นเจ้าของ `backend/app/api/routes.py`; อย่าให้หลาย agent แก้ร่วมกันโดยไม่แบ่งส่วน/ส่ง patch
- รัน backend pytest+ruff, frontend test+typecheck, production build และ browser QA หลังรวมงาน
- งานโอกาสฝน 2.2 กม. เสร็จแล้ว: ค่า primary/หมายเหตุใช้ fine; coarse มีป้ายเปรียบเทียบ; source label จังหวัดอ่าน metadata; แก้ English sort locale เพื่อ SSR/CSR ตรงกัน
