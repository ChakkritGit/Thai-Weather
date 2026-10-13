# HANDOFF
อัปเดต: 2026-10-14 ICT โดย Claude · งาน: deploy VPS + แผน docs/ui-radar-push-plan.md ครบ + คำขอเพิ่มของผู้ใช้

## สถานะ
- Production: VPS 117.18.127.246 (`ssh vps`), stack `deploy/docker-compose.yml` + `docker-compose.build.yml` (build บนเครื่อง เพราะ GHCR ยังไม่มี image — Images workflow รันเมื่อ push `main` เท่านั้น)
- โดเมน (Cloudflare DNS only): thai-weather / nginx / portainer `.chakkritton.com` → NPM + Let's Encrypt, Force SSL, HSTS, HTTP/2
- ความปลอดภัย VPS: ufw เปิดเฉพาะ 22(limit)/80/443, SSH key-only, fail2ban, unattended-upgrades, sysctl hardening, docker log rotation
- รหัสแอดมิน NPM/Portainer: `/root/admin-credentials.txt` บน VPS และสำเนาบน Desktop ผู้ใช้ (ไม่อยู่ใน repo)
- แผน 4 ข้อเสร็จ: Play เรดาร์ย้อนหลัง 1 ชม., ย้ายตั้งค่า Push ไป /alerts#notifications, Push ความร้อน (opt-in), เอาโลโก้/ชื่อออกจาก navbar
- คำขอเพิ่มเสร็จ: แสดงตำแหน่งทันทีหลังรีเฟรช (เมื่อเคยอนุญาต), iOS apple-touch-icon + splash 44 ขนาด, OG/Twitter ครบทุกหน้า + การ์ดจังหวัด/จุด, แก้ pinch zoom บน iOS

## ขั้นต่อไป
1. ทดสอบบน iPhone จริง: pinch zoom แผนที่, ไอคอน/splash หลัง "เพิ่มไปยังหน้าจอโฮม" (ต้องลบไอคอนเดิมแล้วเพิ่มใหม่), Push heat
2. ตั้ง `THWX_VAPID_SUBJECT` ใน `/opt/thai-weather/deploy/.env` เป็นอีเมลจริง
3. ถ้าจะใช้ GHCR: merge เข้า `main` แล้วตั้ง package เป็น public

- รอบแก้จาก iPhone (2026-10-14): แถบชั้นข้อมูลเลื่อนได้ (เลิก pointer-events:none), เรดาร์ไม่กระพริบ (canvas source แทน updateImage), ไอคอนมี ?v= ให้ iOS โหลดใหม่ + favicon PNG/.ico, robots/sitemap/การ์ด OG เรนเดอร์ตอน request (เดิมได้ localhost จากตอน build)

## การตัดสินใจ + เหตุผล
- pinch บน iOS: ไม่มีเครื่อง iOS ให้ทดสอบ; ทำ 2 ทางที่รู้กันว่าแก้ปัญหานี้ — map page ไม่อยู่ใน scroll container (`.app-main:has(> .map-page)`) และ preventDefault `gesture*` ของ Safari บน container แผนที่; Chromium touch emulation ซูมได้
- OG: satori ไม่ทำ mark positioning ภาษาไทย (วรรณยุกต์บนสระบนหาย) จึงใช้ harfbuzzjs 1.6.2 shaping → SVG; `og:url` ของจุดบนแผนที่ละไว้ เพราะ Next ตัด query ของ URL ราก
- radar history: id = unix time ของเฟรม, รายการ+ภาพมาจาก snapshot เดียว, เลือกเฟรมย้อนหลังแล้ว poll ไม่ย้าย
- heat: 41/54°C จาก design tokens, หน้าต่างชั่วโมงปัจจุบัน+3 ชม., cooldown 6 ชม., run เก่ากว่า 2×refresh+1 ชม. ไม่ใช้

## คำสั่งตรวจ + ผลล่าสุด
- backend: ruff ผ่าน, pytest 197 passed · frontend: typecheck ผ่าน, vitest 71 passed, `next build` ผ่าน
- browser QA (Playwright 1.63 Chromium, desktop+iPhone, TH/EN): 51/51 ผ่าน, ไม่มี JS error

## สิ่งที่รันค้าง / ข้อควรระวัง
- อัปเดต production: `ssh vps 'cd /opt/thai-weather && git pull && cd deploy && docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build api web verify'`
- stack สร้างจาก CLI: อย่า redeploy ทั้ง stack จาก Portainer
