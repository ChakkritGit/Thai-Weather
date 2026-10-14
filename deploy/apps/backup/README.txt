Thai-Weather server backup
==========================

ไฟล์นี้คือสำเนาของทั้งเซิร์ฟเวอร์ ณ เวลาที่สร้าง: ฐานข้อมูลของแอป, ข้อมูลใน Docker volume ทุกตัว
(Nginx Proxy Manager + cert, Portainer, ข้อมูลพยากรณ์, รูปของ portfolio, สถิติเว็บ, ฯลฯ), ไฟล์ตั้งค่า (.env)
และ commit ของทุก repo  ทั้งหมดอยู่ใน payload.enc ซึ่งเข้ารหัสด้วยรหัสผ่านที่ตั้งตอนสร้าง (AES-256)
ไม่มีรหัสผ่านนี้ = เปิดไม่ได้ — เก็บไว้ให้ดี

กู้คืน (บนเซิร์ฟเวอร์เดิมเพื่อย้อนกลับ หรือบน Ubuntu 24.04 เครื่องใหม่):

  scp thai-weather-backup-*.zip root@SERVER:/root/
  ssh root@SERVER
  apt-get install -y unzip && unzip thai-weather-backup-*.zip -d restore && cd restore
  bash restore.sh --check     # ตรวจไฟล์และรหัสผ่านก่อน ยังไม่เปลี่ยนอะไร
  bash restore.sh             # กู้คืนทั้งหมด (พิมพ์ RESTORE เพื่อยืนยัน)

The bundle holds the app databases, every Docker volume, the settings (.env) and each repo's commit,
encrypted with the passphrase chosen when it was made. restore.sh --check verifies it without changing
anything; restore.sh puts the whole server back (this one, or a fresh Ubuntu 24.04 one).
