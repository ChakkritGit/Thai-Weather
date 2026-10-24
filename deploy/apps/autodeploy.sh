#!/bin/sh
# Auto-deploy on push: every 2 minutes (apps-autodeploy.timer) fetch each app repo's main branch and,
# when it moved, rebuild that app's image and restart it. Native services are owned by this repository.
# Log: journalctl -u apps-autodeploy   ·   by hand: /opt/thai-weather/deploy/apps/autodeploy.sh [--force <app>]
set -eu
cd "$(dirname "$0")"
REPOS=${REPOS:-/opt/apps/repos}
exec 9>/run/apps-autodeploy.lock
flock -n 9 || { echo "another deploy is running"; exit 0; }

deploy() { # <image to build> <compose services to restart...>
  img=$1; shift
  echo "== build $img"
  ./build.sh "$img"
  case "$img" in
    # the web apps switch with no gap (new container healthy before the old one stops)
    portfolio|expenses|whiteboard|drive-music) ../rollout.sh "$img" ;;
    *) docker compose up -d --no-deps "$@" ;;
  esac
}

force=${2:-}
[ "${1:-}" = "--force" ] || force=""
for app in portfolio expenses whiteboard drive-music; do
  dir="$REPOS/$app"
  git -C "$dir" fetch -q origin main
  old=$(git -C "$dir" rev-parse HEAD)
  new=$(git -C "$dir" rev-parse origin/main)
  if [ "$old" = "$new" ] && [ "$force" != "$app" ]; then continue; fi
  echo "== $app ${old%"${old#???????}"} → ${new%"${new#???????}"}"
  git -C "$dir" reset -q --hard origin/main
  if deploy "$app" "$app"; then
    echo "== $app deployed"
  else
    echo "!! $app build failed; rolling the checkout back to ${old%"${old#???????}"} (the running container is untouched)"
    git -C "$dir" reset -q --hard "$old"
    continue
  fi
done
# keep the disk tidy: dangling images from the previous builds, and at most 3 GB of build cache.
# Not `docker image prune`: with Docker's containerd image store it also removed images that containers
# still run, taking the rollback image (and the nightly image scan's target) with it.
used=$(docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | sort -u)
for id in $(docker images -q --no-trunc --filter dangling=true | sort -u); do
  echo "$used" | grep -qx "$id" || docker rmi "$id" >/dev/null 2>&1 || true
done
docker builder prune -f --keep-storage 3gb >/dev/null 2>&1 || true
