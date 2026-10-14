# Spent/Cost reminders (Bun + Elysia), built from the expenses repo's reminders/ folder:
#   docker buildx build -f reminders.Dockerfile --build-context app=<expenses checkout> .
FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY --from=app reminders/package.json reminders/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=app reminders/server.ts ./
COPY --from=app reminders/lib/ ./lib/
RUN rm -f lib/*.test.ts && chmod -R a+rX /app
USER bun
ENV NODE_ENV=production
CMD ["bun", "server.ts"]
