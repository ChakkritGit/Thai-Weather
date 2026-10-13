#!/bin/sh
# Only Cloudflare may reach the published web ports (80/443) of the Docker stack.
# Docker-published ports bypass ufw's INPUT chain, so the rule lives in DOCKER-USER.
# The range list is refreshed from Cloudflare; the last good copy is kept if that fails.
set -eu
LIST=/etc/cloudflare-ips-v4.txt
IFACE=eth0
tmp=$(mktemp)
if curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 -o "$tmp" && grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' "$tmp" && [ "$(wc -l < "$tmp")" -ge 10 ]; then
  mv "$tmp" "$LIST"
else
  rm -f "$tmp"
fi
[ -s "$LIST" ] || { echo "no Cloudflare range list – leaving DOCKER-USER untouched" >&2; exit 1; }

iptables -N DOCKER-USER 2>/dev/null || true
iptables -F DOCKER-USER
iptables -A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
while read -r range; do
  [ -n "$range" ] && iptables -A DOCKER-USER -i "$IFACE" -p tcp -m multiport --dports 80,443 -s "$range" -j RETURN
done < "$LIST"
iptables -A DOCKER-USER -i "$IFACE" -p tcp -m multiport --dports 80,443 -j DROP
iptables -A DOCKER-USER -j RETURN
echo "DOCKER-USER: 80/443 open to $(grep -c . "$LIST") Cloudflare ranges only"
