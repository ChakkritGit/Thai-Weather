# Bun + Elysia services that replaced the Cloudflare Workers: rooms (whiteboard), sync (drive-music), status.
# One image, three commands (see ../docker-compose.yml). The vendored app logic comes from the app repos:
#   docker build --build-context drivemusic=<drive-music checkout> --build-context portfolio=<portfolio checkout> .
FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src/*.ts ./src/
COPY --from=drivemusic party/index.ts ./src/vendor/drive-music/party/index.ts
COPY --from=drivemusic src/lib/party.ts ./src/vendor/drive-music/src/lib/party.ts
COPY --from=portfolio status/src/checks.ts status/src/state.ts status/src/page.ts status/src/types.ts ./src/vendor/status/
RUN rm -f src/*.test.ts && mkdir -p /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production
VOLUME /data
