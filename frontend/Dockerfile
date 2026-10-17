# Next.js web app (standalone output)
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# rewrites are compiled at build time – point them at the API service
ARG THWX_API_URL=http://api:8000
ENV THWX_API_URL=$THWX_API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM oven/bun:1.4.2-alpine
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Thai Weather HD – Next.js web app" \
      com.chakkrit.stack="next-bun-elysia"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=bun:bun /app/.next/standalone ./
COPY --from=build --chown=bun:bun /app/.next/static ./.next/static
COPY --from=build --chown=bun:bun /app/public ./public
RUN mkdir -p .next/cache/images && chown -R bun:bun .next/cache
USER bun
EXPOSE 3000
CMD ["bun", "server.js"]
