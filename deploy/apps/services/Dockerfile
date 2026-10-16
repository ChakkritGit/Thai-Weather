# Bun + Elysia services: rooms (whiteboard), sync (drive-music), status, analytics, dock-metrics.
# One image, several commands (see ../docker-compose.yml). Drive Music's room logic comes from its repo:
#   docker build --build-context drivemusic=<drive-music checkout> .
FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src/*.ts ./src/
COPY src/status/*.ts src/status/og.png ./src/status/
COPY --from=drivemusic party/index.ts ./src/vendor/drive-music/party/index.ts
COPY --from=drivemusic src/lib/party.ts ./src/vendor/drive-music/src/lib/party.ts
# readable whatever mode the checkouts had on the host (vendored files come from other repos)
RUN rm -f src/*.test.ts src/status/*.test.ts && chmod -R a+rX /app && mkdir -p /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production
VOLUME /data
