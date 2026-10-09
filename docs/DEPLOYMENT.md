# Deployment / การ deploy

ระบบมี 2 ส่วน:

| ส่วน | ลักษณะ | ที่ deploy ที่เหมาะ |
|---|---|---|
| **Web** (`frontend/`, Next.js 15) | SSR หน้าจังหวัด/เตือนภัย + proxy `/api/v1/*` ไปหา backend | **Vercel**, หรือ Docker (`frontend/Dockerfile`, standalone) |
| **Backend** (`backend/`, FastAPI) | process ที่ทำงานตลอด: scheduler เบื้องหลัง, คำนวณ ~30 วินาที/รอบ, เขียนผล ~150 MB ลงดิสก์ | Docker บน Cloud Run (min-instances=1), Fly.io, Railway, Render, VPS |

```
browser ──► Next.js (Vercel) ──rewrite /api/v1/*──► FastAPI (container + volume)
```

เบราว์เซอร์คุยกับโดเมนของเว็บเท่านั้น → **ไม่ต้องตั้ง CORS**

## ทางเลือก A — Docker Compose (เครื่องเดียว / VPS)

```bash
THWX_SOURCE=open-meteo SITE_URL=https://your-domain.th docker compose up --build -d
```

- เว็บ: port 3000 · API: port 8000 (`/docs`) — ตั้ง reverse proxy (Caddy/Nginx) ให้ HTTPS ชี้ไปที่ 3000
- ข้อมูลพยากรณ์เก็บใน volume `thwx-data`

## ทางเลือก B — Web บน Vercel + Backend ที่อื่น

### ทำไม backend ไม่อยู่บน Vercel

Vercel Functions เป็น serverless: ไม่มีดิสก์ถาวร, ไม่มี background job ที่รันค้าง,
จำกัดเวลาทำงานต่อ request — แต่ backend ต้องรันรอบพยากรณ์ตามเวลาและเก็บผลไว้

### 1. Deploy backend (ตัวอย่าง Cloud Run)

```bash
cd backend
gcloud run deploy thwx-api --source . --region asia-southeast1 \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --memory 2Gi \
  --set-env-vars THWX_SOURCE=open-meteo,THWX_REFRESH_MINUTES=360,THWX_FALLBACK_TO_DEMO=false,THWX_ADMIN_TOKEN=<random>
```

- ต้องมี **1 instance ทำงานตลอด** เพราะ scheduler อยู่ใน process (อย่าเกิน 1 instance จนกว่าจะแยก worker — ดู HANDOFF)
- ข้อมูลรอบพยากรณ์อยู่บนดิสก์ instance; ถ้า restart จะคำนวณรอบใหม่เองภายใน ~1 นาที (หรือ mount volume ที่ `THWX_DATA_DIR`)
- ใช้ `backend/Dockerfile` ได้กับทุกผู้ให้บริการที่รันคอนเทนเนอร์

### 2. ตั้งค่า Vercel project

| การตั้งค่า | ค่า |
|---|---|
| Root Directory | `frontend` |
| Framework Preset | **Next.js** (ตรวจจับอัตโนมัติ, มี `frontend/vercel.json`) |
| Build / Output | ค่าเริ่มต้นของ Next.js (ไม่ต้องแก้) |
| Node.js Version | 20.x หรือ 22.x |
| Region (Functions) | `sin1` (สิงคโปร์) — ใกล้ไทยและใกล้ backend ที่ `asia-southeast1` |

**Environment Variables** (ตั้งทั้ง Production และ Preview):

| ชื่อ | ตัวอย่าง | หมายเหตุ |
|---|---|---|
| `THWX_API_URL` | `https://thwx-api-xxxx.a.run.app` | **จำเป็น** — ใช้ทั้งตอน build (rewrites) และตอน run (SSR fetch) ไม่ต้องมี `/` ท้าย |
| `SITE_URL` | `https://fah.example.th` | canonical URL, sitemap, Open Graph |

ผ่าน CLI:

```bash
cd frontend
vercel link
vercel env add THWX_API_URL production
vercel env add SITE_URL production
vercel --prod
```

หมายเหตุ
- เปลี่ยน `THWX_API_URL` แล้วต้อง **redeploy** (rewrites ถูกคอมไพล์ตอน build)
- ไม่ต้องตั้ง `THWX_CORS_ORIGINS` เพราะ Vercel proxy `/api/v1/*` ให้ — preview deployment ทุกตัวใช้ได้ทันที
- `NEXT_PUBLIC_API_BASE` (ไม่บังคับ) ใช้เมื่ออยากให้เบราว์เซอร์เรียก backend ตรงๆ (ต้องตั้ง CORS ที่ backend)
- ไฟล์ token ที่ generate แล้ว commit อยู่ใน `frontend/src/design/generated/` จึง build ได้โดยไม่ต้องใช้โฟลเดอร์อื่น
- ข้อมูลชั้นแผนที่ (~80 KB/เฟรม) ผ่าน rewrite ของ Vercel ซึ่งนับเป็น bandwidth ของ Vercel; ถ้าคนใช้เยอะ ให้ตั้ง `NEXT_PUBLIC_API_BASE` ชี้ backend ตรงหรือวาง CDN หน้า backend

## ตรวจสอบหลัง deploy

```bash
curl https://<backend>/api/v1/health                  # "run" ต้องไม่เป็น null หลังรอบแรก
curl https://<site>/api/v1/meta | jq '.run.demo'      # false = ข้อมูลจริง (ผ่าน rewrite ของ Next.js)
curl -s https://<site>/provinces/chiang-mai | grep '<title>'
curl https://<site>/sitemap.xml | grep -c '<loc>'     # 81
```
