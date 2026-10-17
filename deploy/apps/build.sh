#!/bin/sh
# Build one app image (or the Bun services image) from the repos in $REPOS.
#   ./build.sh portfolio|expenses|whiteboard|drive-music|services|reminders|backup
# Not `docker compose build`: Compose's bake path refuses to read the secret file without an extra grant.
# The app's env file is mounted only during `next build` (NEXT_PUBLIC_* are inlined) and never lands in a layer.
set -eu
cd "$(dirname "$0")"
REPOS=${REPOS:-/opt/apps/repos}
ENVS=${ENVS:-/opt/apps/env}
name=${1:?app name}
case "$name" in
  services)
    docker buildx build --load -t apps-services:local \
      --build-context drivemusic="$REPOS/drive-music" services ;;
  backup)
    docker buildx build --load -t apps-backup:local -f backup.Dockerfile . ;;
  reminders)
    docker buildx build --load -t apps-reminders:local -f reminders.Dockerfile --build-context app="$REPOS/expenses" . ;;
  portfolio|expenses|whiteboard|drive-music)
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
