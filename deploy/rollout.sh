#!/bin/sh
# Swap one compose service to its freshly built image without a gap: start a second container next to the
# running one, wait until Docker reports it healthy, give nginx time to see it, then stop the old one.
#
# Why no request is lost: NPM proxies to the service by a network alias that both containers carry, re-resolves
# it every 10 s (resolver valid=10s) and, when one address refuses, retries the other (proxy_next_upstream).
# A new container that never turns healthy is removed and the old one keeps serving.
#
# The service must have no container_name (Compose can't run two) and a healthcheck.
#   cd <compose dir> && ../rollout.sh <service>     (COMPOSE_FILE / -p come from the environment as usual)
set -eu
svc=${1:?service}
TIMEOUT=${ROLLOUT_TIMEOUT:-180}   # seconds for the new container to become healthy
DNS_TTL=12                        # NPM's resolver caches names for 10 s

old=$(docker compose ps -q "$svc")
count=$(printf '%s\n' "$old" | grep -c . || true)
if [ "$count" -eq 0 ]; then
  docker compose up -d --no-deps "$svc"
  exit 0
fi

docker compose up -d --no-deps --no-recreate --scale "$svc=$((count + 1))" "$svc"
new=""
for id in $(docker compose ps -q "$svc"); do
  printf '%s\n' "$old" | grep -qx "$id" || new=$id
done
[ -n "$new" ] || { echo "rollout $svc: no new container started" >&2; exit 1; }

waited=0
while :; do
  state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$new")
  case "$state" in
    "running healthy") break ;;
    "running unhealthy"|exited*|dead*) reason=$state ;;
    *) reason="" ;;
  esac
  if [ -n "$reason" ] || [ "$waited" -ge "$TIMEOUT" ]; then
    echo "rollout $svc: new container not healthy (${reason:-timeout}); keeping the old one" >&2
    docker logs --tail 30 "$new" >&2 || true
    docker rm -f "$new" >/dev/null
    exit 1
  fi
  sleep 2; waited=$((waited + 2))
done
echo "rollout $svc: new container healthy after ${waited}s"

sleep "$DNS_TTL"
for id in $old; do
  docker stop -t 20 "$id" >/dev/null
  docker rm "$id" >/dev/null
done
echo "rollout $svc: done"
