#!/bin/sh
# Copy Drive Music's party room logic (party/index.ts + src/lib/party.ts) into src/vendor/drive-music,
# so the sync service runs the repo's own SyncServer class. Usage: scripts/vendor-drive-music.sh <drive-music checkout>
set -eu
src=${1:?drive-music checkout}
dst=$(dirname "$0")/../src/vendor/drive-music
mkdir -p "$dst/party" "$dst/src/lib"
cp "$src/party/index.ts" "$dst/party/index.ts"
cp "$src/src/lib/party.ts" "$dst/src/lib/party.ts"
echo "vendored drive-music party from $src"
