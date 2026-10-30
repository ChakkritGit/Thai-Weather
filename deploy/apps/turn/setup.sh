#!/bin/sh
# Provision coturn for CalorieFlow calls (run as root on the VPS, from deploy/apps): makes the shared secret once,
# writes $ENVS/turnserver.conf from the template, gives CalorieFlow TURN_SECRET and TURN_URLS, and opens the
# ports in ufw. Prints no secret. Then: ./build.sh turn && docker compose up -d turn && ../rollout.sh calorieflow-api
set -eu
ENVS=${ENVS:-/opt/apps/env}
here=$(cd "$(dirname "$0")" && pwd)
ip=$(ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$ip" ] || { echo "no public IPv4 on eth0" >&2; exit 1; }
umask 077
env="$ENVS/calorieflow.env"
if ! grep -q '^TURN_SECRET=' "$env"; then
  printf 'TURN_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$env"
fi
grep -q '^TURN_URLS=' "$env" || printf 'TURN_URLS=turn:%s:3478?transport=udp,turn:%s:3478?transport=tcp\n' "$ip" "$ip" >> "$env"
secret=$(grep '^TURN_SECRET=' "$env" | tail -1 | cut -d= -f2-)
sed -e "s/@PUBLIC_IP@/$ip/g" -e "s/@SECRET@/$secret/" "$here/turnserver.conf.in" > "$ENVS/turnserver.conf.new"
chown 65534:65533 "$ENVS/turnserver.conf.new"
chmod 0400 "$ENVS/turnserver.conf.new"
mv "$ENVS/turnserver.conf.new" "$ENVS/turnserver.conf"
ufw allow 3478/udp comment 'TURN (CalorieFlow calls)' >/dev/null
ufw allow 3478/tcp comment 'TURN (CalorieFlow calls)' >/dev/null
ufw allow 49160:49250/udp comment 'TURN relays (CalorieFlow calls)' >/dev/null
echo "turn: config written for $ip, ufw open"
