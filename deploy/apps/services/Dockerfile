# Legacy chat image retained until its native Rust cutover.
FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src/*.ts ./src/
COPY src/status/*.ts src/status/og.png ./src/status/
# readable whatever mode the checkouts had on the host (vendored files come from other repos)
RUN rm -f src/*.test.ts src/status/*.test.ts && chmod -R a+rX /app && mkdir -p /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production
VOLUME /data
