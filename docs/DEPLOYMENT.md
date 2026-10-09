# Deployment / การ deploy

ระบบมี 2 ส่วนที่มีลักษณะต่างกัน:

| ส่วน | ลักษณะ | ที่ deploy ที่เหมาะ |
|---|---|---|
| **Web app** (`frontend/`) | static files (Vite build) | Vercel, Netlify, Cloudflare Pages, หรือให้ backend เสิร์ฟเอง |
| **Backend** (`backend/`) | process ทำงานตลอดเวลา: scheduler เบื้องหลัง, คำนวณ ~30 วินาที/รอบ, เขียนผล ~150 MB ลงดิสก์ | Docker บน Cloud Run (min-instances=1), Fly.io, Railway, Render, VPS |

## ทางเลือก A — คอนเทนเนอร์เดียว (ง่ายที่สุด)

```bash
docker build -t thai-weather-hd .
docker run -p 8000:8000 -v thwx:/var/lib/thwx -e THWX_SOURCE=open-meteo thai-weather-hd
```

Backend เสิร์ฟทั้ง API และ web app ที่ origin เดียวกัน ไม่ต้องตั้ง CORS

## ทางเลือก B — Web บน Vercel + Backend ที่อื่น

### ทำไม backend ไม่ควรอยู่บน Vercel

Vercel Functions เป็น serverless: ไม่มีดิสก์ถาวร (มีแค่ `/tmp` ชั่วคราว), ไม่มี
background thread ที่รันต่อเนื่อง, จำกัดเวลาทำงานต่อ request และขนาด bundle
ขณะที่ backend นี้ต้องรันรอบพยากรณ์ตามเวลาและเก็บผลไว้ให้ทุก request อ่าน
→ วาง backend บนบริการที่รันคอนเทนเนอร์ค้างไว้ได้ แล้วให้ Vercel เสิร์ฟเฉพาะหน้าเว็บ

### 1. Deploy backend (ตัวอย่าง Fly.io / Cloud Run / Railway)

ใช้ `Dockerfile` ที่ root ได้เลย ตั้ง env:

```
THWX_SOURCE=open-meteo
THWX_ADMIN_TOKEN=<สุ่มค่ายาวๆ>
THWX_CORS_ORIGINS=["https://<your-app>.vercel.app","https://your-domain.th"]
THWX_DATA_DIR=/var/lib/thwx          # mount volume ถาวรไว้ที่นี่
```

- ต้องมี **อย่างน้อย 1 instance ทำงานตลอด** (Cloud Run: `--min-instances=1 --no-cpu-throttling`) เพราะ scheduler อยู่ใน process
- RAM แนะนำ ≥ 1 GB, CPU 1–2 vCPU
- `THWX_CORS_ORIGINS` เป็น JSON list (pydantic-settings)

### 2. ตั้งค่า Vercel project

| การตั้งค่า | ค่า |
|---|---|
| Root Directory | `frontend` |
| Framework Preset | Vite (มี `frontend/vercel.json` กำหนดให้แล้ว) |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 20.x หรือ 22.x |
| Environment Variable | `VITE_API_BASE` = `https://<backend-host>` (ไม่ต้องมี `/` ท้าย) — ตั้งทั้ง Production และ Preview |

ผ่าน CLI:

```bash
cd frontend
vercel link
vercel env add VITE_API_BASE production   # ใส่ URL ของ backend
vercel --prod
```

หมายเหตุ
- `VITE_*` ถูกฝังตอน build → เปลี่ยนค่าแล้วต้อง redeploy
- เว็บใช้ hash routing (`#/provinces`) จึงไม่ต้องตั้ง SPA rewrite
- ไฟล์ token ที่ generate แล้ว commit อยู่ใน `frontend/src/design/generated/` จึง build ได้โดยไม่ต้องใช้โฟลเดอร์อื่น
- Preview deployments ของ Vercel ใช้โดเมนสุ่ม — ถ้าต้องการให้ใช้งานได้ ให้เพิ่มโดเมนนั้นใน `THWX_CORS_ORIGINS` หรือใช้ทางเลือก C

### ทางเลือก C — ใช้ Vercel rewrite แทน CORS

ไม่ตั้ง `VITE_API_BASE` แล้วเพิ่มใน `frontend/vercel.json`:

```json
"rewrites": [{ "source": "/api/:path*", "destination": "https://<backend-host>/api/:path*" }]
```

เบราว์เซอร์จะเรียก `/api` บนโดเมนเดียวกัน (Vercel proxy ให้) — ใช้ได้กับ preview ทุกตัวโดยไม่ต้องแก้ CORS

## ตรวจสอบหลัง deploy

```bash
curl https://<backend-host>/api/v1/health      # "run" ต้องไม่เป็น null หลังรอบแรก (~30–60 วินาที)
curl -I https://<backend-host>/api/v1/layers/temp?step=0   # ต้องมี X-Grid-NY / X-Grid-NX
```
