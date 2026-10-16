#!/usr/bin/env bash
# Restore a server bundle made in Dock → สำรองข้อมูล (thai-weather-backup-YYYYMMDD-HHMM.zip).
#
#   unzip thai-weather-backup-*.zip -d restore && cd restore
#   sudo bash restore.sh --check      # decrypt and verify everything, change nothing
#   sudo bash restore.sh              # put everything back (asks for confirmation)
#
# Works on this server (rolls code, settings, volumes and databases back to the bundle) or on a fresh
# Ubuntu 24.04 server (installs Docker, clones the repos, builds and starts everything).
# Options: --yes (no confirmation)  --no-build (reuse existing images; only when the code did not change)
# The passphrase is asked for, or read from $BUNDLE_PASS.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CHECK=0; YES=0; BUILD=1
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;; --yes) YES=1 ;; --no-build) BUILD=0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root: sudo bash restore.sh"
for t in openssl tar python3 sha256sum; do command -v $t >/dev/null || { apt-get update -qq && apt-get install -y -qq openssl tar python3 coreutils >/dev/null; break; }; done

say "Checking the bundle"
(cd "$HERE" && sha256sum -c payload.enc.sha256) || die "payload.enc is damaged (checksum mismatch)"

if [ -z "${BUNDLE_PASS:-}" ]; then read -r -s -p "Passphrase: " BUNDLE_PASS; echo; fi
export BUNDLE_PASS
WORK=/root/restore-$(date +%Y%m%d-%H%M%S)
mkdir -p "$WORK/payload" && chmod 700 "$WORK"
# the decrypted copy holds every secret: removed whatever happens (success, error, wrong passphrase)
trap 'rm -rf "$WORK"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$HERE/payload.enc" -pass env:BUNDLE_PASS \
  | tar -x -C "$WORK/payload" 2>/dev/null || die "wrong passphrase (or a damaged bundle)"
P=$WORK/payload
[ -f "$P/meta.json" ] || die "no meta.json in the bundle"

meta() { python3 -c "import json,sys; d=json.load(open('$P/meta.json')); print(eval(sys.argv[1]))" "$1"; }
echo "made: $(meta 'd["created"]')"
for v in "$P"/volumes/*.tar.gz; do tar -tzf "$v" >/dev/null || die "volume archive damaged: $(basename "$v")"; done
for d in "$P"/db/*.dump; do [ -s "$d" ] || die "empty database dump: $(basename "$d")"; done
echo "volumes:   $(ls "$P/volumes" | sed 's/\.tar\.gz$//' | tr '\n' ' ')"
echo "databases: $(ls "$P/db" | sed 's/\.dump$//' | tr '\n' ' ')"
echo "settings:  $(ls "$P/env" | tr '\n' ' ')"
python3 - "$P/meta.json" <<'PY'
import json, sys
for name, r in json.load(open(sys.argv[1]))["repos"].items():
    print(f"repo {name:12} {r['commit'][:10] if r else '(missing)'} {r.get('branch') or '' if r else ''}")
PY
if [ $CHECK = 1 ]; then say "Bundle OK — nothing was changed"; exit 0; fi

if [ $YES = 0 ]; then
  echo
  echo "This REPLACES on this server: the code checkouts, /opt/apps/env, the Origin certificate,"
  echo "every Docker volume in the bundle and both app databases — with the bundle's copy."
  read -r -p "Type RESTORE to continue: " ok; [ "$ok" = RESTORE ] || die "cancelled"
fi

say "Base packages and Docker"
apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker >/dev/null

say "Code (each repo at the bundle's commit)"
checkout() { # <dir> <url> <commit> <branch|empty>
  local dir=$1 url=$2 commit=$3 branch=$4
  [ -d "$dir/.git" ] || git clone -q "$url" "$dir"
  git -C "$dir" fetch -q origin
  if [ -n "$branch" ]; then git -C "$dir" checkout -q -B "$branch" "$commit"; else git -C "$dir" checkout -q --detach "$commit"; fi
  git -C "$dir" reset -q --hard "$commit"
  echo "$(basename "$dir") → ${commit:0:10}"
}
eval "$(python3 - "$P/meta.json" <<'PY'
import json, shlex, sys
repos = json.load(open(sys.argv[1]))["repos"]
for name, r in repos.items():
    if not r: continue
    d = "/opt/thai-weather" if name == "thai-weather" else f"/opt/apps/repos/{name}"
    print("checkout", shlex.quote(d), shlex.quote(r["url"]), r["commit"], shlex.quote(r["branch"] or ""))
PY
)"
chmod -R go+rX /opt/apps/repos /opt/thai-weather

say "Settings and certificate"
install -d -m 700 /opt/apps/env /root/origin-ca
for f in "$P"/env/*.env; do
  case "$(basename "$f")" in
    thai-weather.deploy.env) install -m 600 "$f" /opt/thai-weather/deploy/.env ;;
    *) install -m 600 "$f" "/opt/apps/env/$(basename "$f")" ;;
  esac
done
for f in "$P"/origin-ca/*; do [ -e "$f" ] && install -m 600 "$f" /root/origin-ca/; done

say "Stopping the stacks (volumes are kept until replaced)"
APPS=/opt/thai-weather/deploy/apps
WX=/opt/thai-weather/deploy
(cd "$APPS" && docker compose down --remove-orphans 2>/dev/null) || true
(cd "$WX" && docker compose -f docker-compose.yml -f docker-compose.build.yml down --remove-orphans 2>/dev/null) || true

say "Volumes"
docker pull -q alpine:3.22.2 >/dev/null
for v in "$P"/volumes/*.tar.gz; do
  name=$(basename "$v" .tar.gz)
  docker volume rm -f "$name" >/dev/null 2>&1 || true
  docker volume create --label "com.docker.compose.project=${name%%_*}" --label "com.docker.compose.volume=${name#*_}" "$name" >/dev/null
  docker run --rm -v "$name:/v" -v "$P/volumes:/b:ro" alpine:3.22.2 tar --numeric-owner -xzf "/b/$name.tar.gz" -C /v
  echo "restored $name"
done
# the databases come back from their dumps into a fresh cluster (roles and passwords from db.env)
docker volume rm -f apps_db-data >/dev/null 2>&1 || true

if [ $BUILD = 1 ]; then
  say "Building the images (takes a while on a small server)"
  (cd "$WX" && docker compose -f docker-compose.yml -f docker-compose.build.yml build)
  (cd "$WX" && docker compose pull --ignore-buildable -q 2>/dev/null || docker compose pull -q nginx-proxy-manager portainer dock)
  for img in services reminders portfolio expenses whiteboard drive-music; do (cd "$APPS" && ./build.sh "$img"); done
fi

say "Starting the weather stack and the proxy"
(cd "$WX" && docker compose -f docker-compose.yml -f docker-compose.build.yml up -d)

say "Databases"
(cd "$APPS" && docker compose up -d db)
for i in $(seq 1 60); do docker exec apps-db pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done
sleep 3
for d in "$P"/db/*.dump; do
  db=$(basename "$d" .dump)
  docker exec -i apps-db pg_restore -U postgres -d "$db" --exit-on-error < "$d"
  echo "restored database $db"
done

say "Starting the apps"
# the health service reads this snapshot of the containers (the status Worker checks the server through it)
install -m 755 -d /run/apps-health
"$APPS"/container-health.sh || true
(cd "$APPS" && docker compose up -d)

say "Timers"
cp "$APPS"/apps-autodeploy.service "$APPS"/apps-autodeploy.timer "$APPS"/apps-db-backup.service "$APPS"/apps-db-backup.timer \
  "$APPS"/apps-container-health.service "$APPS"/apps-container-health.timer /etc/systemd/system/
cp "$WX"/hardening/cf-origin-lock.service "$WX"/hardening/cf-origin-lock.timer /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now apps-db-backup.timer apps-container-health.timer cf-origin-lock.timer >/dev/null 2>&1 || true
# 6 GB RAM: drop file cache before pushing idle apps into swap (they answered slowly after being paged out)
echo "vm.swappiness = 10" > /etc/sysctl.d/60-swappiness.conf && sysctl -q -p /etc/sysctl.d/60-swappiness.conf || true
# Left off on purpose: it would immediately deploy the newest commits on main over the restored code.
systemctl disable --now apps-autodeploy.timer >/dev/null 2>&1 || true

say "Checking"
sleep 20
docker ps --format '{{.Names}}\t{{.Status}}' | sort
for h in thai-weather.chakkritton.com chakkritton.com expenses.chakkritton.com whiteboard.chakkritton.com drive-music.chakkritton.com docker.chakkritton.com; do
  printf '%-32s %s\n' "$h" "$(curl -sk -o /dev/null -m 15 -w '%{http_code}' --resolve "$h:443:127.0.0.1" "https://$h/")"
done
printf '%-32s %s\n' "health.chakkritton.com/ping" "$(curl -sk -o /dev/null -m 15 -w '%{http_code}' --resolve "health.chakkritton.com:443:127.0.0.1" "https://health.chakkritton.com/ping")"

cat <<MSG

Done. Notes:
  * Auto-deploy is OFF so the restored code stays. Turn it back on when you want the newest commits:
      systemctl enable --now apps-autodeploy.timer
  * A different server? Point the Cloudflare DNS records (chakkritton.com, www, thai-weather, expenses,
    whiteboard, drive-music, health, docker, nginx, portainer) at this server's IP, proxied.
    status.chakkritton.com is a Cloudflare Worker (deploy/status-worker): leave its DNS alone; it reads
    health.chakkritton.com with PROBE_SECRET from the restored health.env, so nothing to change there.
  * Logins (Nginx Proxy Manager, Portainer) are the same as when the bundle was made.
MSG
