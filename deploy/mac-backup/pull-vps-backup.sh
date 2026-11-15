#!/bin/bash
# Pulls a whole-server backup bundle from the VPS onto the Mac's SSD once a day and keeps the newest three.
# Run hourly by launchd (install.sh); it does nothing once today's bundle exists. The VPS has no way into the Mac,
# so a server taken over cannot delete these copies.
set -euo pipefail
SSD=/Volumes/SSD256GB
DEST=$SSD/Backups/vps
KEEP=3
LOG=$HOME/Library/Logs/vps-backup.log
FAILED_MARK=$HOME/Library/Caches/vps-backup.failed

log() { echo "$(date '+%F %T') $1" >>"$LOG"; }
# one notification a day for failures: the job retries hourly
fail() {
  log "FAILED: $1"
  if [ "$(cat "$FAILED_MARK" 2>/dev/null)" != "$(date +%F)" ]; then
    date +%F >"$FAILED_MARK"
    osascript -e "display notification \"$1\" with title \"สำรองข้อมูล VPS ไม่สำเร็จ\"" >/dev/null 2>&1 || true
  fi
  exit 1
}

[ -d "$SSD" ] || fail "ไม่พบ SSD (${SSD##*/}) ต่ออยู่"
mkdir -p "$DEST"
today=$(date +%Y%m%d)
compgen -G "$DEST/chakkritton-server-backup-$today-*.zip" >/dev/null && exit 0

pass=$(security find-generic-password -s "VPS backup passphrase" -a vps-backup -w 2>/dev/null) ||
  fail "อ่านรหัสผ่านจาก Keychain ไม่ได้"
part=$DEST/.incoming.zip.part
trap 'rm -f "$part"' EXIT

log "start"
printf '%s\n' "$pass" | ssh -o BatchMode=yes -o ServerAliveInterval=30 vps-backup >"$part" 2>>"$LOG" ||
  fail "ดาวน์โหลดจาก VPS ไม่สำเร็จ"

# the zip is whole, the payload matches its checksum, and the passphrase opens it into a readable archive
unzip -tq "$part" >/dev/null || fail "ไฟล์ zip เสีย"
want=$(unzip -p "$part" payload.enc.sha256 | awk '{print $1}')
got=$(unzip -p "$part" payload.enc | shasum -a 256 | awk '{print $1}')
[ -n "$want" ] && [ "$want" = "$got" ] || fail "checksum ไม่ตรง"
unzip -p "$part" payload.enc |
  BUNDLE_PASS=$pass openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BUNDLE_PASS |
  tar -tf - >/dev/null || fail "ถอดรหัสไม่ได้"

name=chakkritton-server-backup-$(date +%Y%m%d-%H%M).zip
mv "$part" "$DEST/$name"
rm -f "$FAILED_MARK"

# only after a good new one: the newest three stay
ls -1t "$DEST"/chakkritton-server-backup-*.zip | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
  rm -f "$old"
  log "removed ${old##*/}"
done
log "ok $name $(du -h "$DEST/$name" | cut -f1)"
