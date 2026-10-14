#!/bin/sh
# Copy the status page's logic (checks, state, page, types) from the portfolio repo's status/ Worker into
# src/vendor/status, so the Bun service renders and judges exactly like the Worker did.
# Usage: scripts/vendor-status.sh <portfolio checkout>
set -eu
src=${1:?portfolio checkout}
dst=$(dirname "$0")/../src/vendor/status
mkdir -p "$dst"
cp "$src/status/src/checks.ts" "$src/status/src/state.ts" "$src/status/src/page.ts" "$src/status/src/types.ts" "$dst/"
echo "vendored status from $src"
