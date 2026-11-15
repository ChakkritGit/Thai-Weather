#!/bin/sh
# Forced command of the Mac's backup key (root's authorized_keys: restrict,command="/usr/local/sbin/backup-export"):
# has apps-backup make a whole-server bundle, streams the zip to stdout and deletes it here.
# stdin: the bundle passphrase. Only the one whose SHA-256 is in /etc/backup-export.sha256 is taken, so the key
# cannot fetch a bundle under a passphrase of the caller's choosing.
# Install: install -m 755 deploy/apps/backup-export.sh /usr/local/sbin/backup-export (a copy: a pull must not change
# what the key runs). Mac side: deploy/mac-backup/.
set -eu
umask 077
api=http://apps-backup:8794/backups
dir=/opt/apps/backups/bundles

IFS= read -r pass
# base64url only: it goes into the JSON body as is
case $pass in '' | *[!A-Za-z0-9_-]*) echo "backup-export: bad passphrase" >&2; exit 2 ;; esac
[ "$(printf '%s' "$pass" | sha256sum | cut -d' ' -f1)" = "$(cat /etc/backup-export.sha256)" ] || {
  echo "backup-export: wrong passphrase" >&2
  exit 2
}

# apps-backup is reachable only on Dock's network; the body goes over stdin, never into a process's arguments
name=$(printf '{"passphrase":"%s"}' "$pass" |
  docker exec -i dock wget -qO- --header 'Content-Type: application/json' --post-file=/dev/stdin "$api" |
  python3 -I -c 'import json,sys; print(json.load(sys.stdin)["started"])') || {
  echo "backup-export: could not start (another backup running?)" >&2
  exit 3
}
case $name in chakkritton-server-backup-*.zip) ;; *) echo "backup-export: unexpected name" >&2; exit 3 ;; esac

i=0
while :; do
  sleep 5
  i=$((i + 1))
  state=$(docker exec dock wget -qO- "$api" | python3 -I -c '
import json, sys
j = json.load(sys.stdin)["job"] or {}
print("error" if j.get("error") else "done" if j.get("done") else "run")') || state=run
  [ "$state" = done ] && break
  [ "$state" = error ] && { echo "backup-export: bundle failed" >&2; exit 4; }
  [ $i -lt 720 ] || { echo "backup-export: timed out" >&2; exit 5; }
done

trap 'rm -f "$dir/$name"' EXIT
cat "$dir/$name"
