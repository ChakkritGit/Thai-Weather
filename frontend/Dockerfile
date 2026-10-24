# Next.js web app (standalone output)
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# rewrites are compiled at build time – point them at the API service
ARG THWX_API_URL=http://api:8000
ENV THWX_API_URL=$THWX_API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Thai Weather HD – Next.js web app" \
      com.chakkrit.stack="next-bun-rust"
# Alpine's stable branch only takes security and bug fixes; apply them at build time so OpenSSL, zlib and
# musl do not wait for the next base image (owner, 2026-10-25, after the first image scan)
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=bun:bun /app/.next/standalone ./
COPY --from=build --chown=bun:bun /app/.next/static ./.next/static
COPY --from=build --chown=bun:bun /app/public ./public
RUN mkdir -p .next/cache/images && chown -R bun:bun .next/cache
USER bun
EXPOSE 3000
CMD ["bun", "server.js"]
