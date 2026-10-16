#!/bin/sh
# Every Compose container's state and Docker health check, for the health service (apps-health), which
# has no Docker socket. First line: when it was written (epoch s); then name<TAB>state<TAB>status.
# Run every 30 s by apps-container-health.timer; written atomically into /run/apps-health.
set -eu
dir=/run/apps-health
mkdir -p "$dir"
tmp="$dir/.containers.tsv"
{
  date +%s
  docker ps -a --filter label=com.docker.compose.project --format '{{.Names}}\t{{.State}}\t{{.Status}}'
} > "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$dir/containers.tsv"
