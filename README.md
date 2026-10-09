# ฟ้าละเอียด · Thai Weather HD

**พยากรณ์อากาศความละเอียด 2 กม. สำหรับประเทศไทยและประเทศเขตร้อน** — โอเพนซอร์ส
ทั้ง backend (ลดย่อส่วนโมเดลโลก), web app และ design system

> *High-resolution (2 km) weather forecasts for Thailand, downscaled from ~22 km
> global models with tropical physics. Open source: backend, web app and design
> system. [English summary below](#english).*

![compare](docs/img/compare.png)

## ปัญหา

ระบบพยากรณ์ที่ใช้ในประเทศไทยพึ่งพาโมเดลระดับโลก (GFS, ECMWF ฯลฯ) ซึ่งมีระยะกริด
ราว **22 กม.** — หนึ่งช่องกริดกว้าง ~500 ตร.กม. ใหญ่กว่าเมืองและใหญ่กว่าพายุฝนฟ้าคะนอง
เขตร้อนส่วนใหญ่ ผลคือ

- ฝนพาความร้อน (เซลล์กว้าง 5–20 กม.) ถูกเกลี่ยเป็น “ฝนเล็กน้อยทั้งจังหวัด”
- ภูเขาถูกทำให้เตี้ยลง อุณหภูมิบนดอยคลาดเคลื่อนเกิน 5 °C
- ฝนภูเขาด้านรับลมมรสุมและเงาฝนหายไป
- จังหวัดชายฝั่งถูกผสมกับทะเล ลมบก–ลมทะเลผิดตำแหน่ง
- ไม่มีเกาะความร้อนเมือง (กรุงเทพฯ กลางคืนอุ่นกว่า 2–4 °C) → ประเมินดัชนีความร้อนต่ำไป

## สิ่งที่ระบบนี้ทำ

| | |
|---|---|
| **Downscaling 22 → 2.2 กม.** | กริด 751×421 (≈316,000 จุด) ครอบคลุม 5.5–20.5°N, 97.3–105.7°E |
| **ฟิสิกส์เขตร้อน** | lapse rate ตามภูมิประเทศจริง · อากาศเย็นสะสมในแอ่ง · ความต่างบก/ทะเล · เกาะความร้อนเมือง · ลมตามภูมิประเทศ · ฝนภูเขา · ลมบก-ลมทะเล |
| **Ensemble ฝนพาความร้อน** | 8 สมาชิก → โอกาสฝน, โอกาสฝนหนัก, พายุฝนฟ้าคะนอง, **ร้อยละของพื้นที่ฝนตก** |
| **รายจังหวัด 77 จังหวัด** | สรุปรายวัน + ข้อความพยากรณ์อัตโนมัติแบบกรมอุตุฯ |
| **การเตือนภัย** | ดัชนีความร้อน (กรมอนามัย) · ฝน/อุณหภูมิ (กรมอุตุฯ) · ลม (โบฟอร์ต) |
| **แก้ไขด้วยสถานี** | `POST /api/v1/observations` → residual analysis ตามระยะทาง/ความสูง |
| **เปรียบเทียบได้ทุกจุด** | โหมดเลื่อนเทียบ 22 กม. ↔ 2 กม. และกราฟ “ทำไมต่างจากโมเดล” |
| **Design system** | DTCG tokens → CSS / TypeScript / เกณฑ์ที่ backend ใช้ร่วม |

## เริ่มใช้งาน

### Docker (ง่ายที่สุด)

```bash
docker compose up --build          # โหมดสาธิต ทำงานได้แบบออฟไลน์
THWX_SOURCE=open-meteo docker compose up --build   # ข้อมูลโมเดลจริง
```

เปิด <http://localhost:8000> · API docs ที่ <http://localhost:8000/docs>

### พัฒนาในเครื่อง

```bash
# backend (Python ≥ 3.11)
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload          # http://localhost:8000

# frontend (Node ≥ 20)
cd frontend
npm install
npm run dev                            # http://localhost:5173 (proxy /api → :8000)
```

รอบพยากรณ์แรกใช้เวลา ~30 วินาที (คำนวณ 48 ชม. × 316k จุด × 8 สมาชิก)

### การตั้งค่า (environment variables)

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `THWX_SOURCE` | `demo` | `demo` (จำลอง, ออฟไลน์) หรือ `open-meteo` |
| `THWX_OPENMETEO_MODEL` | `gfs_seamless` | เช่น `ecmwf_ifs025`, `icon_seamless` |
| `THWX_OPENMETEO_SPACING` | `0.25` | ระยะกริดที่ดึงจากโมเดล (องศา) |
| `THWX_OPENMETEO_API_KEY` | – | ใช้ customer API ของ Open-Meteo (สำหรับเชิงพาณิชย์) |
| `THWX_HORIZON_HOURS` | `48` | ช่วงพยากรณ์ |
| `THWX_ENSEMBLE_MEMBERS` | `8` | จำนวนสมาชิก ensemble ฝน |
| `THWX_REFRESH_MINUTES` | `180` | รอบการอัปเดต |
| `THWX_DATA_DIR` | `var` | ที่เก็บผลพยากรณ์ |
| `THWX_ADMIN_TOKEN` | – | Bearer token สำหรับ `POST` endpoints |
| `THWX_FALLBACK_TO_DEMO` | `true` | ใช้ข้อมูลสาธิตเมื่อแหล่งข้อมูลจริงล่ม (แสดงป้ายชัดเจน) |

> **หมายเหตุ Open-Meteo free tier:** กริด 0.25° มี ~2,100 จุด ต่อการดึง 1 ครั้ง
> รอบละ 3 ชม. ≈ 17,000 calls/วัน ซึ่งเกินโควต้าฟรี (10,000/วัน) — ใช้
> `THWX_REFRESH_MINUTES=360` หรือ API key

## โครงสร้างโปรเจค

```
backend/         FastAPI + NumPy/SciPy — แหล่งข้อมูล, downscaling, ผลิตภัณฑ์, API
  app/sources/     Open-Meteo, demo
  app/downscale/   physics.py, precip.py (ensemble), observations.py, pipeline.py
  app/products/    สถิติรายจังหวัด, การเตือนภัย
  app/data/        DEM 2 กม., ขอบเขตจังหวัด, weather_scales.json (generated)
  scripts/         build_static.py — สร้างข้อมูลภูมิประเทศ/ขอบเขตใหม่
frontend/        React + TypeScript + MapLibre (ไม่พึ่ง tile server ภายนอก)
design-system/   tokens/*.json (DTCG) → dist/ (CSS, TS, JSON)
infra/wrf/       namelist WRF 3 กม. (ทางเลือก physics เต็มรูปแบบ)
docs/            เอกสารเทคนิค
```

## เอกสาร

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — สถาปัตยกรรมระบบและการไหลของข้อมูล
- [docs/DOWNSCALING.md](docs/DOWNSCALING.md) — วิธีการทางวิทยาศาสตร์และข้อจำกัด
- [docs/API.md](docs/API.md) — REST API
- [docs/DESIGN.md](docs/DESIGN.md) — design system และหลักการ UX
- [docs/HANDOFF.md](docs/HANDOFF.md) — สถานะงาน สิ่งที่ต้องทำต่อ
- [CONTRIBUTING.md](CONTRIBUTING.md) — วิธีร่วมพัฒนา

## ⚠️ ข้อจำกัดความรับผิดชอบ

ระบบนี้เป็นเครื่องมือวิจัย/ประกอบการตัดสินใจ **ไม่ใช่ประกาศเตือนภัยทางการ** —
ติดตามประกาศจาก [กรมอุตุนิยมวิทยา](https://www.tmd.go.th) และหน่วยงานที่เกี่ยวข้องเสมอ
โหมดสาธิต (`demo`) ใช้ข้อมูลจำลอง ไม่ใช่การพยากรณ์จริง และแสดงป้ายกำกับไว้ทุกหน้า

---

## English

**Thai Weather HD** turns ~22 km global-model output into a 2.2 km forecast for
Thailand in about 30 seconds on one CPU, using tropical-specific physics:
terrain lapse rates, basin cold-air pools, land–sea contrast, urban heat
islands, terrain-modified wind, upslope orographic rain, sea/land-breeze
convergence and a stochastic convective-rain ensemble that yields chance of
rain and **% of area with rain** per province. A React/MapLibre web app shows
it with a swipe comparison against the raw model, point forecasts that explain
*why* each value differs, province summaries with auto-generated TMD-style
text, and alerts based on Thai Department of Health and TMD thresholds.

Quick start: `docker compose up --build`, then open http://localhost:8000.
See the docs above (mostly bilingual) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License & data attribution

Code: [MIT](LICENSE). Data used at run/build time keeps its own terms:

- Forecast data: [Open-Meteo](https://open-meteo.com) (CC BY 4.0) and the underlying NOAA / ECMWF / DWD models
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, GMTED2010, ETOPO1 — see their attribution requirements)
- Boundaries: [Natural Earth](https://www.naturalearthdata.com) (public domain)
