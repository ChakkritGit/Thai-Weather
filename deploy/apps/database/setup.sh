#!/bin/sh
# Refresh the manager's minimal credentials after creating or rotating db.env.
# This script runs on the server; no credential is written to the repository.
set -eu
env_dir=${ENVS:-/opt/apps/env}
umask 077
tmp=$(mktemp "$env_dir/.database-env.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
awk '
  /^POSTGRES_PASSWORD=.+$/ { line=$0; count++ }
  END { if (count != 1) exit 1; print line }
' "$env_dir/db.env" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$env_dir/database.env"
