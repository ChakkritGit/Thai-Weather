# Nginx Proxy Manager, built on the VPS (deploy/docker-compose.build.yml): jc21's 2.16.0 image (pinned by
# digest) plus the security fixes it does not ship yet. Drop each part once a jc21 release contains it.
# - Node 22.23.4: the image ships 22.23.2, missing the Oct 21, 2026 security fixes (CVE-2026-111497 Brotli
#   RCE, TLS hostname bypasses), and the admin API runs on it.
# - Debian's security updates, newer copies of vulnerable npm packages in the API's tree and of certbot's
#   Python packages, and no npm CLI (unused at runtime): the 2026-10-25 image scan, owner's request.
FROM node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS node

# the published tarballs, unchanged; patch-node-modules.mjs puts them in place and checks their dependencies
FROM node AS packages
WORKDIR /pkgs
RUN npm pack --silent proxy-addr@2.0.8 body-parser@2.4.0 qs@6.16.1 fast-uri@3.1.9 ip-address@10.7.4 \
    brace-expansion@5.0.12 undici@8.12.2 basic-ftp@6.2.1 >/dev/null

FROM jc21/nginx-proxy-manager@sha256:4393e642e233e5efd5adeb7f10918d4aaea71c9ed875b94190273fc8e87f9594
# nodejs is held: NodeSource's package would replace the patched binary copied below
RUN apt-mark hold nodejs >/dev/null \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/bin/node
RUN node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a!==22||b<23||(b===23&&c<4)) process.exit(1)'
COPY --from=packages /pkgs /tmp/pkgs
COPY patch-node-modules.mjs /tmp/
# the API runs `node index.js` (yarn only in development mode); node-gyp only built bcrypt/better-sqlite3
RUN node /tmp/patch-node-modules.mjs /tmp/pkgs \
 && rm -rf /tmp/pkgs /tmp/patch-node-modules.mjs /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx \
    /app/node_modules/node-gyp /app/node_modules/.bin/node-gyp \
 && /opt/certbot/bin/pip install --no-cache-dir --disable-pip-version-check \
    certifi==2026.10.19 cryptography==50.0.2 pyopenssl==26.4.0 filelock==4.2.1 setuptools==84.1.0 \
 && /opt/certbot/bin/pip check \
 && /opt/certbot/bin/certbot --version
