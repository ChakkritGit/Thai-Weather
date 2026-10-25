#!/bin/sh
# Nightly dump of each app database (apps-db-backup.timer). Custom format, 14 days kept.
#   restore: docker exec -i apps-db pg_restore -U postgres -d <db> --clean --if-exists < file.dump
set -eu
dir=/opt/apps/backups
mkdir -p "$dir" && chmod 700 "$dir"
day=$(date +%F)
for db in expenses portfolio calorieflow; do
  docker exec apps-db pg_dump -U postgres -Fc "$db" > "$dir/$db-$day.dump.tmp"
  mv "$dir/$db-$day.dump.tmp" "$dir/$db-$day.dump"
done
find "$dir" -name '*.dump' -mtime +14 -delete
echo "backed up: $(ls "$dir" | tr '\n' ' ')"
