# coturn pinned by digest, with Alpine's security fixes applied: the 4.18.0 image (newest release) carries fixed
# CVEs in brotli, bind (dig, used by detect-external-ip) and mongo-c-driver (2026-10-30 image scan).
# Build: deploy/apps/build.sh turn
FROM coturn/coturn:4.18.0-alpine@sha256:c29135c08565810d37053f384584392b7c24b69570fc81a721b878d6fe63e04e
USER root
RUN apk upgrade --no-cache
USER nobody:nogroup
