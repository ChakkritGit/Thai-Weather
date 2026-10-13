# Deploy บน VPS (Docker + Portainer + Nginx Proxy Manager)

ทุกอย่างอยู่ใน **compose ไฟล์เดียว** (`deploy/docker-compose.yml`)

```
อินเทอร์เน็ต ──443/80──► nginx-proxy-manager (SSL Let's Encrypt)
                            │  เครือข่าย "proxy"
          ┌─────────────────┼──────────────────────────┐
          ▼                 ▼                          ▼
 nginx.chakkritton.com  portainer.chakkritton.com  thai-weather.chakkritton.com
 (UI ของ NPM :81)        portainer:9000            thai-weather-web:3000
                                                        │ เครือข่าย "internal"
                                                        ▼
                                                 thai-weather-api:8000  (ไม่เปิดออกนอก)
```

- เปิดออกอินเทอร์เน็ตแค่ **port 80 และ 443** ของ Nginx Proxy Manager (NPM)
- container อื่นคุยกันผ่าน docker network เท่านั้น API อยู่ใน network ส่วนตัวที่มีแค่ `web` เข้าถึงได้
- เว็บเรียก API ผ่าน `/api/v1/*` ของตัวเอง (Next.js proxy ให้) จึงไม่ต้องเปิด API ออกนอก

## 0. เตรียม

| สิ่งที่ต้องมี | รายละเอียด |
|---|---|
| VPS | Ubuntu 22.04/24.04, แนะนำ 2 vCPU / 4 GB RAM (2 GB ได้ สคริปต์จะเพิ่ม swap ให้) |
| DNS | A record 3 ตัวชี้ไปที่ IP ของ VPS: `nginx`, `portainer`, `thai-weather` (`.chakkritton.com`) |
| Image | GitHub Actions สร้าง image ให้อัตโนมัติเมื่อ push เข้า `main` (ดูข้อ 5) |

> ถ้าใช้ DNS ของ Cloudflare: ตอนขอ SSL ครั้งแรกให้ตั้งเมฆเป็น **DNS only (สีเทา)** ก่อน
> ได้ใบรับรองแล้วค่อยเปิด Proxied (สีส้ม) ได้ โดยตั้ง SSL/TLS mode เป็น **Full (strict)** — ระบบปัจจุบันเปิดเมฆส้มแล้ว (ดู §4b)

## 1. ติดตั้งบน VPS (ครั้งเดียว)

```bash
ssh root@<VPS_IP>
git clone https://github.com/ChakkritGit/Thai-Weather.git /opt/thai-weather
cd /opt/thai-weather
sudo bash deploy/setup-vps.sh
```

สคริปต์จะ: ติดตั้ง Docker → เปิด firewall เฉพาะ 22/80/443 → เพิ่ม swap (ถ้า RAM < 3.5 GB)
→ สร้าง `deploy/.env` พร้อมสุ่ม `THWX_ADMIN_TOKEN` → `docker compose up -d`

ตรวจ/แก้ค่าได้ที่ `nano /opt/thai-weather/deploy/.env` แล้ว `cd deploy && docker compose up -d`

## 2. ตั้งค่า Nginx Proxy Manager (ครั้งแรก)

UI ของ NPM (port 81) ผูกไว้กับ localhost ของ VPS เท่านั้น ครั้งแรกให้เปิดผ่าน SSH tunnel:

```bash
# บนเครื่องของคุณ
ssh -L 8181:127.0.0.1:81 root@<VPS_IP>
# แล้วเปิด http://localhost:8181
```

สร้างบัญชีผู้ดูแล (เวอร์ชันเก่าจะให้ล็อกอินด้วย `admin@example.com` / `changeme` แล้วบังคับเปลี่ยน)

จากนั้น **Hosts → Proxy Hosts → Add Proxy Host** ทีละตัว:

| Domain Names | Scheme | Forward Hostname | Port | Websockets | หมายเหตุ |
|---|---|---|---|---|---|
| `nginx.chakkritton.com` | http | `nginx-proxy-manager` | `81` | – | UI ของ NPM เอง |
| `portainer.chakkritton.com` | http | `portainer` | `9000` | ✅ เปิด | console ของ Portainer ต้องใช้ websocket |
| `thai-weather.chakkritton.com` | http | `thai-weather-web` | `3000` | – | เว็บหลัก |

ทุกตัว: เปิด **Block Common Exploits** และที่แท็บ **SSL** → *Request a new SSL Certificate*
→ เปิด **Force SSL**, **HTTP/2 Support**, **HSTS Enabled** → Save

ใช้ชื่อ container (คอลัมน์ Forward Hostname) ได้เลยเพราะทุกตัวอยู่ใน network `proxy` เดียวกัน

หลังจากนี้เข้า NPM ที่ `https://nginx.chakkritton.com` ได้ ไม่ต้องใช้ SSH tunnel แล้ว

## 3. ตั้งค่า Portainer

เปิด `https://portainer.chakkritton.com` แล้วสร้าง admin **ภายใน 5 นาทีหลัง container เริ่ม**
(ถ้าเลยเวลา: `docker restart portainer`) → เลือก environment แบบ **Local / Docker**

## 3b. Dock — หน้าจัดการ Docker แบบมินิมอล (มือถือ)

`https://docker.chakkritton.com` — หน้าเว็บเล็ก ๆ (`deploy/dock/www`, ไม่มี dependency, CSP เข้ม) ที่ใช้ API ของ Portainer:
ล็อกอินด้วยบัญชี Portainer, ดูคอนเทนเนอร์ตามโปรเจกต์พร้อม CPU/RAM, เริ่ม/หยุด/รีสตาร์ท (แตะยืนยันสองครั้ง), log, อิมเมจ, วอลุ่ม
- คอนเทนเนอร์ `dock` (nginx อ่านอย่างเดียว) ไม่มี Docker socket — ส่งต่อเฉพาะ path ของ Portainer API ที่หน้าใช้ (`deploy/dock/nginx.conf`)
- หยุด `portainer`, `nginx-proxy-manager`, `dock` จากหน้านี้ไม่ได้ (จะเข้าหน้าไม่ได้) แต่รีสตาร์ทได้
- Proxy host ใน NPM: `docker.chakkritton.com` → `dock:80` (SSL, Force SSL, HSTS) · แก้ไฟล์แล้วแค่ `git pull` (เมานต์ไว้)
- งานที่ไม่มีในหน้านี้ใช้ Portainer เต็มที่ `portainer.chakkritton.com` (NPM แทรก viewport ให้แสดงบนมือถือได้)

## 4. ป้องกันหน้าแอดมิน (แนะนำ)

ใน NPM → **Access Lists** → สร้างรายการ (Basic Auth และ/หรืออนุญาตเฉพาะ IP ของคุณ)
แล้วผูกกับ proxy host `nginx.`, `portainer.` และ `docker.` — เว็บหลักไม่ต้องผูก

## 4b. Hardening ที่ใช้อยู่ (จากรายงานทดสอบความปลอดภัย 14 ต.ค. 2026)

| ส่วน | ตั้งค่าอย่างไร |
|---|---|
| Cloudflare | ทั้ง 4 โดเมน **Proxied (เมฆส้ม)**, SSL/TLS = **Full (strict)** |
| Origin lock | `deploy/hardening/cf-origin-lock.sh` (+ `.service`, `.timer` ใน `/etc/systemd/system/`) — chain `DOCKER-USER` ให้ 80/443 รับเฉพาะช่วง IP ของ Cloudflare (อัปเดตรายสัปดาห์) — ถ้าปิดเมฆส้มต้อง `systemctl stop cf-origin-lock` ก่อน ไม่งั้นเว็บเข้าไม่ได้ |
| Rate limit ล็อกอิน | `deploy/hardening/npm-http_top.conf` → `/data/nginx/custom/http_top.conf` ของ NPM; Advanced ของ proxy host `portainer.`/`docker.` = `location = /api/auth { limit_req zone=login burst=5 nodelay; … include conf.d/include/proxy.conf; }`, `nginx.` = เดียวกันที่ `/api/tokens` |
| IP จริงหลัง Cloudflare | Advanced ทุก host: `real_ip_header CF-Connecting-IP;` (ช่วง IP ของ CF อยู่ใน `ip_ranges.conf` ของ NPM แล้ว) |
| Header หน้าแอดมิน | `nginx.`: `more_set_headers` X-Frame-Options DENY, nosniff, Referrer-Policy, CSP frame-ancestors · `portainer.`: Referrer-Policy (+ viewport สำหรับมือถือ) |
| Default site | NPM Settings → Default Site = **No Response (444)** |
| SSH | `/etc/ssh/sshd_config.d/00-hardening.conf`: key-only, Kex/Ciphers/MACs สมัยใหม่, `AllowTcpForwarding local` (tunnel `-L` ไป NPM :81 ยังใช้ได้) |
| เว็บหลัก | security headers + CSP ใน `frontend/next.config.mjs`; `/docs` ไม่เปิดสาธารณะ |

## 5. Image ของแอป

ทุกครั้งที่ push เข้า `main` → GitHub Actions (`.github/workflows/images.yml`) สร้างและอัปโหลด

- `ghcr.io/chakkritgit/thai-weather-api:latest`
- `ghcr.io/chakkritgit/thai-weather-web:latest`

ครั้งแรกให้ไปที่ GitHub → โปรไฟล์ → **Packages** → แต่ละ package → *Package settings*
→ **Change visibility → Public** (ไม่งั้น VPS จะ pull ไม่ได้)
หรือถ้าอยากให้เป็น private: Portainer → Registries → เพิ่ม GitHub (ghcr.io) ด้วย Personal Access Token ที่มีสิทธิ์ `read:packages`
และบน VPS รัน `docker login ghcr.io`

ไม่อยากใช้ GHCR? build บน VPS ได้ (ต้องมี RAM ว่าง ~2 GB):

```bash
cd /opt/thai-weather && git pull && cd deploy
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 6. อัปเดตเวอร์ชัน

**ทาง Portainer:** Containers → `thai-weather-web` (และ `thai-weather-api`) → **Recreate** → เปิด **Re-pull image** → Recreate

**ทาง SSH:**

```bash
cd /opt/thai-weather && git pull && cd deploy
docker compose pull api web && docker compose up -d api web
```

> stack นี้สร้างจาก command line จึงขึ้นใน Portainer เป็น *Limited* — จัดการ container (logs, restart,
> recreate, console, ดูสถิติ) ได้ครบ แต่อย่า redeploy ทั้ง stack จากใน Portainer เพราะ Portainer อยู่ใน stack เดียวกัน
> และจะปิดตัวเองกลางทาง ให้ใช้ `docker compose` ผ่าน SSH แทน

## 7. ตรวจสอบ

```bash
cd /opt/thai-weather/deploy
docker compose ps                           # ทุกตัวต้อง Up (web = healthy)
docker compose logs -f api                  # ดูรอบพยากรณ์แรก (~6 นาที)
curl -s https://thai-weather.chakkritton.com/api/v1/meta | grep -o '"demo":[a-z]*'   # "demo":false = ข้อมูลจริง
```

## ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| NPM ขึ้น **502 Bad Gateway** | ชื่อ/port ใน Forward Hostname ผิด หรือ container ยังไม่ขึ้น — `docker compose ps` |
| ขอ SSL ไม่ผ่าน | DNS ยังไม่ชี้มาที่ VPS, port 80 ถูกบล็อก, หรือ Cloudflare เปิด Proxied อยู่ |
| เว็บขึ้น "กำลังคำนวณ" นาน | รอบแรกใช้ ~6 นาที (ดึงข้อมูลแบบเว้นจังหวะตามโควตา Open-Meteo) |
| `docker compose up` แจ้ง `set THWX_ADMIN_TOKEN` | ยังไม่ได้ใส่ค่าใน `deploy/.env` |
| pull image ไม่ได้ (denied) | package บน GHCR ยังเป็น private — ดูข้อ 5 |
| เข้า Portainer แล้วขึ้น timeout ให้สร้าง admin | `docker restart portainer` แล้วเข้าใหม่ภายใน 5 นาที |

## สำรองข้อมูล

ข้อมูลสำคัญอยู่ใน docker volume: `thai-weather_npm-data`, `thai-weather_npm-letsencrypt`,
`thai-weather_portainer-data` (ผลพยากรณ์ `thwx-data` สร้างใหม่ได้เอง ไม่ต้องสำรอง)

```bash
docker run --rm -v thai-weather_npm-data:/v -v $PWD:/b alpine tar czf /b/npm-data.tgz -C /v .
```
