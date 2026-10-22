# Nginx Proxy Manager with a patched Node.js, built on the VPS (deploy/docker-compose.build.yml).
# jc21's image (pinned by digest) ships Node 22.23.2, which has the Oct 21, 2026 security fixes missing
# (CVE-2026-111497 Brotli RCE, TLS hostname bypasses). Its admin API runs on that Node, so the binary is
# replaced with the official 22.23.4 build. Drop this file once jc21 ships Node >= 22.23.4.
FROM node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS node

FROM jc21/nginx-proxy-manager@sha256:4393e642e233e5efd5adeb7f10918d4aaea71c9ed875b94190273fc8e87f9594
COPY --from=node /usr/local/bin/node /usr/bin/node
RUN node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a!==22||b<23||(b===23&&c<4)) process.exit(1)'
