#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu/Debian VPS for Thai Weather HD.
# Run as root from the repository checkout:  sudo bash deploy/setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Firewall (SSH, HTTP, HTTPS only)"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

echo "==> Swap (helps 2 GB machines during forecast runs)"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 3500000 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Configuration"
if [ ! -f .env ]; then
  cp .env.example .env
  token=$(openssl rand -hex 32)
  sed -i "s/^THWX_ADMIN_TOKEN=.*/THWX_ADMIN_TOKEN=${token}/" .env
  echo "    created deploy/.env (admin token generated) – review it: nano $(pwd)/.env"
fi

echo "==> Starting the stack"
docker compose pull
docker compose up -d
docker compose ps

cat <<'MSG'

Done. Next steps (see deploy/README.md):
  1. From your computer:  ssh -L 8181:127.0.0.1:81 <user>@<vps-ip>
     then open http://localhost:8181 to set up Nginx Proxy Manager.
  2. Add the three proxy hosts with Let's Encrypt SSL.
  3. Open https://portainer.chakkritton.com within 5 minutes to create the
     admin user (otherwise: docker restart portainer).
  4. The first forecast run takes ~6 minutes after start.
MSG
