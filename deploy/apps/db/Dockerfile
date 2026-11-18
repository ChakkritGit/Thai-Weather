# The apps' Postgres, pinned by digest, without gosu: the entrypoint only uses it to drop from root to
# postgres, and the bundled build (Go 1.24.6) carries ~60 standard-library CVEs (2026-10-25 image scan).
# Alpine's su-exec (C, same `user command…` syntax) takes its place. Build: deploy/apps/build.sh db
# The wrapper lives in /usr/local/sbin (earlier in PATH) so the old path is a deletion: image scanners drop a
# lower layer's binary only on a whiteout, not when a later layer overwrites or symlinks the same path.
FROM postgres:17.12-alpine3.24@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7
RUN apk upgrade --no-cache \
 && apk add --no-cache su-exec \
 && rm /usr/local/bin/gosu && mkdir -p /usr/local/sbin \
 && printf '#!/bin/sh\nexec /sbin/su-exec "$@"\n' > /usr/local/sbin/gosu \
 && chmod 755 /usr/local/sbin/gosu \
 && [ "$(command -v gosu)" = /usr/local/sbin/gosu ] \
 && [ "$(gosu nobody id -un)" = nobody ]
