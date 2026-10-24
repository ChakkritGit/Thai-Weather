# syntax=docker/dockerfile:1
# Any of the four Next.js apps, built from its own repo without changing it:
#   docker build -f next.Dockerfile --build-context app=<repo checkout> --secret id=env,src=<app>.env .
# The env file is mounted only while `next build` runs (NEXT_PUBLIC_* values are inlined into the bundle);
# it is never copied into an image layer. At runtime the same file comes in through env_file.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY --from=app . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
# standalone output (a self-contained server.js + traced node_modules) without editing the repo's config
RUN mv next.config.ts next.config.base.ts \
 && printf "import base from './next.config.base'\nexport default { ...base, output: 'standalone' as const }\n" > next.config.ts
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=env,target=/app/.env.production \
    npm run build \
 && rm -f .next/standalone/.env* \
 && mkdir -p public

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS bun
LABEL com.chakkrit.stack="next-bun-rust"
# Alpine's stable branch only takes security and bug fixes; apply them at build time so OpenSSL, zlib and
# musl do not wait for the next base image (owner, 2026-10-25, after the first image scan)
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=bun:bun /app/.next/standalone ./
COPY --from=build --chown=bun:bun /app/.next/static ./.next/static
COPY --from=build --chown=bun:bun /app/public ./public
# Docker seeds an empty named volume from this directory, including its ownership.
# Without it a newly mounted cache is root-owned and next/image fails with EACCES.
RUN mkdir -p .next/cache/images && chown -R bun:bun .next/cache
USER bun
EXPOSE 3000
CMD ["bun", "server.js"]

# Retain an explicit Node target for runtime comparisons and recovery.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS node
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p .next/cache/images && chown -R node:node .next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
