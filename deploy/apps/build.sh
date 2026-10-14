#!/bin/sh
# Build one app image (or the Bun services image) from the repos in $REPOS.
#   ./build.sh portfolio|expenses|whiteboard|drive-music|services
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
      --build-context drivemusic="$REPOS/drive-music" --build-context portfolio="$REPOS/portfolio" services ;;
  portfolio|expenses|whiteboard|drive-music)
    docker buildx build --load -t "apps-$name:local" -f next.Dockerfile \
      --build-context app="$REPOS/$name" --secret id=env,src="$ENVS/$name.env" . ;;
  *) echo "unknown app: $name" >&2; exit 2 ;;
esac
