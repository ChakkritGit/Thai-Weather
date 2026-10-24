# The apps' Postgres, pinned by digest, without gosu: the entrypoint only uses it to drop from root to
# postgres, and the bundled build (Go 1.24.6) carries ~60 standard-library CVEs (2026-10-25 image scan).
# Alpine's su-exec (C, same `user command…` syntax) takes its place. Build: deploy/apps/build.sh db
# A regular file, not a symlink: image scanners keep reporting a lower layer's binary behind a symlink.
FROM postgres:17.11-alpine3.24@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
RUN apk upgrade --no-cache \
 && apk add --no-cache su-exec \
 && rm /usr/local/bin/gosu \
 && printf '#!/bin/sh\nexec /sbin/su-exec "$@"\n' > /usr/local/bin/gosu \
 && chmod 755 /usr/local/bin/gosu \
 && [ "$(gosu nobody id -un)" = nobody ]
