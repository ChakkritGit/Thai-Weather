#!/bin/sh
# Nightly dump of each app database (apps-db-backup.timer). Custom format, 14 days kept.
#   restore: docker exec -i apps-db pg_restore -U postgres -d <db> --clean --if-exists < file.dump
#   (symos-accounts: docker exec -i symos-accounts-db pg_restore -U accounts -d accounts --clean --if-exists)
set -eu
dir=/opt/apps/backups
mkdir -p "$dir" && chmod 700 "$dir"
day=$(date +%F)
for db in expenses portfolio calorieflow; do
  docker exec apps-db pg_dump -U postgres -Fc "$db" > "$dir/$db-$day.dump.tmp"
  mv "$dir/$db-$day.dump.tmp" "$dir/$db-$day.dump"
done
# SymOS accounts have their own database container (docker-compose.yml, symos-accounts-db)
if docker inspect symos-accounts-db >/dev/null 2>&1; then
  docker exec symos-accounts-db pg_dump -U accounts -Fc accounts > "$dir/symos-accounts-$day.dump.tmp"
  mv "$dir/symos-accounts-$day.dump.tmp" "$dir/symos-accounts-$day.dump"
fi
find "$dir" -name '*.dump' -mtime +14 -delete
echo "backed up: $(ls "$dir" | tr '\n' ' ')"
