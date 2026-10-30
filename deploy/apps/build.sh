#!/bin/sh
# Build one Next app or the native Rust service images.
#   ./build.sh portfolio|expenses|whiteboard|drive-music|calorieflow|calorieflow-api|rust|backup|db|turn
# Not `docker compose build`: Compose's bake path refuses to read the secret file without an extra grant.
# The app's env file is mounted only during `next build` (NEXT_PUBLIC_* are inlined) and never lands in a layer.
set -eu
cd "$(dirname "$0")"
REPOS=${REPOS:-/opt/apps/repos}
ENVS=${ENVS:-/opt/apps/env}
name=${1:?app name}
case "$name" in
  rust)
    docker buildx build --load -t apps-rust:local rust-services/runtime ;;
  backup)
    docker buildx build --load -t apps-backup:local -f backup.Dockerfile \
      --build-context runtime=docker-image://apps-rust:local . ;;
  calorieflow-api)
    # CalorieFlow's Rust API lives in the CalorieFlowWeb repo (api/), next to the web app that uses it
    docker buildx build --load -t apps-calorieflow-api:local "$REPOS/calorieflow/api" ;;
  db)
    docker buildx build --load -t apps-db:local db ;;
  turn)
    docker buildx build --load -t apps-turn:local turn ;;
  portfolio|expenses|whiteboard|drive-music|calorieflow)
    # `next build` pre-renders the ISR pages (portfolio: home, blog, projects, topics, sitemap, feed) and needs
    # the database for that, so the build runs on the host network with the internal names pointed at the
    # running containers. Without it the pages were built empty and served that way for a day.
    hosts=""
    for c in apps-db apps-dbgw apps-media; do
      ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$c" 2>/dev/null | awk '{print $1}')
      [ -n "$ip" ] && hosts="$hosts --add-host $c:$ip"
    done
    # shellcheck disable=SC2086 # $hosts is a list of flags
    docker buildx build --load -t "apps-$name:local" -f next.Dockerfile --target bun --network host $hosts \
      --build-context app="$REPOS/$name" --secret id=env,src="$ENVS/$name.env" . ;;
  *) echo "unknown app: $name" >&2; exit 2 ;;
esac
