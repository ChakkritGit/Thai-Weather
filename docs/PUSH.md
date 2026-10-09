# Web Push alerts / การแจ้งเตือนผ่านเบราว์เซอร์

ไทย | [English](#english)

## ภาพรวม (ไทย)

ผู้ใช้กด **"รับการแจ้งเตือนที่ตำแหน่งนี้"** ในการ์ดเรดาร์ของจุดที่เลือก (หรือติดตั้งเว็บเป็นแอปแล้วเปิดใช้) ระบบจะส่งการแจ้งเตือนไปที่อุปกรณ์เมื่อ

| ประเภท | เงื่อนไข (คำนวณจาก nowcast เรดาร์ทุก ~5 นาที) |
|---|---|
| `storm` พายุฝนฟ้าคะนอง | คาดว่าถึงจุดนั้นภายใน 45 นาที (>= 45 dBZ) หรือกำลังเกิดอยู่แล้ว |
| `heavy_rain` ฝนหนัก | คาดว่าฝนระดับ "หนัก" ขึ้นไปถึงภายใน 45 นาที (ไม่ซ้ำกับ storm) |
| `cyclone` พายุหมุนเขตร้อน | จุดนั้นอยู่ในเขตลมแรงตามแนวพยากรณ์ หรือพายุเข้าใกล้สุด <= 300 กม. ภายใน 48 ชม. |

- **ไม่แจ้งซ้ำ**: คีย์เดิมไม่ส่งซ้ำภายใน 3 ชม. (storm/heavy_rain) หรือ 12 ชม. (cyclone) เว้นแต่ระดับรุนแรงขึ้น (เช่น พายุฝนฟ้าคะนอง -> รุนแรง, พายุเข้าเขตลมแรง)
- **ช่วงไม่รบกวน** (ค่าเริ่มต้น 22:00-06:00 เวลาไทย) ใช้กับทุกประเภท ยกเว้นพายุหมุนที่จุดอยู่ในเขตลมแรง
- ข้อมูลเรดาร์เก่าเกิน 30 นาที หรือจุดอยู่นอกพื้นที่เรดาร์ -> ไม่ส่งการแจ้งเตือนจากเรดาร์
- เป็นการประเมินจากเรดาร์ ไม่ใช่คำเตือนทางการ

### ตั้งค่าบน VPS

1. ต้องเป็น **HTTPS** (Nginx Proxy Manager ที่ใช้อยู่ให้ SSL แล้ว) — Service Worker และ Push ไม่ทำงานบน HTTP ยกเว้น `localhost`
2. ใน `deploy/.env` ตั้ง `THWX_VAPID_SUBJECT=mailto:อีเมลจริงของคุณ` (ค่าเริ่มต้น `mailto:admin@example.com` เป็นแค่ที่ว่าง ต้องเปลี่ยน)
3. คีย์ VAPID: ปล่อย `THWX_VAPID_PUBLIC_KEY` / `THWX_VAPID_PRIVATE_KEY` ว่างไว้ ระบบจะสร้างครั้งเดียวและเก็บที่ `/var/lib/thwx/push/vapid.json` (volume `thwx-data`, สิทธิ์ 0600) จึงคงอยู่หลังรีสตาร์ท  
   ถ้าต้องการกำหนดเอง (เช่น ย้ายเซิร์ฟเวอร์):
   ```bash
   docker compose exec api python -c "from app.push.vapid import generate; p,u=generate(); print('THWX_VAPID_PRIVATE_KEY='+p); print('THWX_VAPID_PUBLIC_KEY='+u)"
   ```
   ถ้าเปลี่ยนคีย์ การสมัครเดิมทั้งหมดจะใช้ไม่ได้ (ผู้ใช้ต้องกดเปิดใหม่)
4. สำรอง volume `thwx-data` (มี `push/subscriptions.sqlite` และ `push/vapid.json`)
5. ปิดฟีเจอร์: `THWX_PUSH_ENABLED=false`
6. ตรวจสถานะ: `curl -H "Authorization: Bearer $THWX_ADMIN_TOKEN" https://<โดเมน>/api/v1/push/status` (จำนวนผู้สมัคร + ผลรอบส่งล่าสุด)

### iOS / iPadOS

Safari บน iOS รองรับ Web Push เฉพาะเว็บที่ **เพิ่มไปยังหน้าจอโฮม** แล้ว (iOS/iPadOS **16.4+**): แตะปุ่มแชร์ -> "เพิ่มไปยังหน้าจอโฮม" -> เปิดจากไอคอน แล้วจึงกดเปิดการแจ้งเตือน หน้าเว็บจะแสดงคำแนะนำนี้เองเมื่อตรวจพบ iOS ที่ยังไม่ได้ติดตั้ง

### ความเป็นส่วนตัวและขีดจำกัด

- ไม่ต้องสมัครสมาชิก ไม่เก็บชื่อ/อีเมล/IP เก็บเฉพาะ: รหัสสุ่ม, endpoint และกุญแจของ push service, พิกัด **ปัดเป็น 0.01 องศา (~1 กม.)**, ชื่อที่ผู้ใช้ตั้ง, การตั้งค่า และเวลาส่งล่าสุด
- กุญแจ (p256dh/auth) ไม่ถูกเขียนลง log
- รับเฉพาะ endpoint จาก push service ที่รู้จักผ่าน https (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com`, `*.push.apple.com`) — กันไม่ให้เซิร์ฟเวอร์ส่งคำขอไปยังโฮสต์อื่น
- จำกัดผู้สมัครรวม 5,000 ราย, ขนาด body 4 KB, พิกัดต้องอยู่ในพื้นที่ให้บริการ, ปุ่ม "ส่งทดสอบ" ได้ 1 ครั้ง/นาที/อุปกรณ์
- ยกเลิก/แก้ไขต้องส่ง endpoint + auth secret ของตัวเอง; ถ้า push service ตอบ 404/410 ระบบลบการสมัครให้อัตโนมัติ
- 1 อุปกรณ์/เบราว์เซอร์ = 1 ตำแหน่ง (กด "ย้ายมาตำแหน่งนี้" เพื่อเปลี่ยน)

### ทดสอบบน localhost

`localhost` ถือเป็น secure context จึงทดสอบ Push ได้โดยไม่ต้องมี HTTPS (Chrome/Edge/Firefox; Safari/iOS ต้องติดตั้งแอปบน HTTPS)

```bash
docker compose up --build            # web http://localhost:3000, API http://localhost:8000
# เปิด http://localhost:3000 -> แตะจุดบนแผนที่ -> การ์ด "ฝนใน 1 ชั่วโมงข้างหน้า" -> "รับการแจ้งเตือนที่ตำแหน่งนี้"
# -> อนุญาตการแจ้งเตือน -> "ส่งทดสอบ"
```

ดูใน DevTools -> Application -> Service Workers / Manifest ได้ ปรับ `THWX_VAPID_SUBJECT` ได้ใน `.env` (ค่าเริ่มต้นใช้ทดสอบได้)  
เพื่อดูการแจ้งเตือนพายุจริงโดยไม่รอฝน ให้ทดสอบเงื่อนไขด้วย `pytest backend/tests/test_push.py` (ใช้ข้อมูลจำลอง ไม่ต่อเครือข่าย)

### API

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `/api/v1/push/public-key` | VAPID public key (base64url) |
| POST | `/api/v1/push/subscribe` | `{subscription, lat, lon, label, prefs}` -> `{id, ...}`; สมัครซ้ำด้วย endpoint+auth เดิม = อัปเดต |
| POST | `/api/v1/push/unsubscribe` | `{endpoint, keys}` |
| POST | `/api/v1/push/test` | `{endpoint, keys}` ส่งการแจ้งเตือนทดสอบ (429 ถ้าถี่เกิน) |
| GET | `/api/v1/push/status` | admin: จำนวนผู้สมัคร + ผลรอบส่งล่าสุด |

---

## English

Users tap **"Get alerts for this spot"** in the radar card of a selected point (works best once the site is installed as an app). The server pushes a notification when:

| Kind | Condition (evaluated from the radar nowcast after every ~5 min ingest) |
|---|---|
| `storm` | a thunderstorm (>= 45 dBZ) is expected at the spot within 45 min, or is already there |
| `heavy_rain` | "heavy" or stronger rain is expected within 45 min (not sent in addition to `storm`) |
| `cyclone` | the spot is inside a forecast wind swath, or the closest approach is <= 300 km within 48 h |

- **De-duplication**: the same alert key is not re-sent within 3 h (storm / heavy rain) or 12 h (cyclone) unless its tier rises (thunderstorm -> severe, cyclone enters a wind swath).
- **Quiet hours** (default 22:00-06:00 Asia/Bangkok) apply to everything except a cyclone wind-swath warning. A suppressed alert is not consumed: if the threat persists it is sent when quiet hours end.
- Stale radar (> 30 min) or a spot outside radar coverage means no radar alerts. These are radar-based estimates, not official warnings.

### Setup on the VPS

1. **HTTPS is required** (service workers and push are disabled on plain HTTP except `localhost`); Nginx Proxy Manager already terminates TLS.
2. Set `THWX_VAPID_SUBJECT=mailto:you@your-domain` in `deploy/.env`. The default `mailto:admin@example.com` is a placeholder and must be changed; the push services use it to contact the operator.
3. VAPID keys: leave `THWX_VAPID_PUBLIC_KEY` / `THWX_VAPID_PRIVATE_KEY` empty and a pair is generated once into `/var/lib/thwx/push/vapid.json` (volume `thwx-data`, mode 0600), so restarts keep subscriptions valid. To pin your own:
   ```bash
   docker compose exec api python -c "from app.push.vapid import generate; p,u=generate(); print('THWX_VAPID_PRIVATE_KEY='+p); print('THWX_VAPID_PUBLIC_KEY='+u)"
   ```
   Keys are the raw P-256 values, base64url. Changing keys invalidates all existing subscriptions.
4. Back up the `thwx-data` volume (`push/subscriptions.sqlite`, `push/vapid.json`).
5. Disable with `THWX_PUSH_ENABLED=false`.
6. Check: `curl -H "Authorization: Bearer $THWX_ADMIN_TOKEN" https://<domain>/api/v1/push/status`.

### iOS / iPadOS

Web Push only works for sites **added to the Home Screen** (iOS/iPadOS **16.4+**): Share -> "Add to Home Screen" -> open from the icon -> then enable alerts. The UI shows this hint on iOS when the site is not installed.

### Privacy and limits

- No accounts, names, e-mail or IP addresses are stored. Stored: a random id, the push service endpoint and keys, coordinates **rounded to 0.01 deg (~1 km)**, the user's place label, preferences and last-sent times. Keys are never logged.
- Only https endpoints on known push services are accepted (FCM, Mozilla autopush, WNS, Apple), so the server never makes requests to arbitrary hosts.
- At most 5,000 subscriptions, 4 KB request bodies, locations inside the service domain, one test notification per minute per subscription.
- Updating/unsubscribing requires the subscription's own endpoint + auth secret; subscriptions answered with 404/410 by the push service are deleted automatically.
- One device/browser = one location ("Move to this spot" changes it).

### Testing on localhost

`localhost` counts as a secure context, so push works without HTTPS in Chrome/Edge/Firefox (iOS needs an installed app on HTTPS).

```bash
docker compose up --build            # web http://localhost:3000, API http://localhost:8000
# open http://localhost:3000, tap a point, use "Get alerts for this spot" in the radar card,
# allow notifications, then "Send test".
```

Inspect DevTools -> Application -> Service Workers / Manifest. Alert decisions are covered offline by `pytest backend/tests/test_push.py` (synthetic radar snapshot, mocked push service, no network).
