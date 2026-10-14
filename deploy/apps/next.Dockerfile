# syntax=docker/dockerfile:1
# Any of the four Next.js apps, built from its own repo without changing it:
#   docker build -f next.Dockerfile --build-context app=<repo checkout> --secret id=env,src=<app>.env .
# The env file is mounted only while `next build` runs (NEXT_PUBLIC_* values are inlined into the bundle);
# it is never copied into an image layer. At runtime the same file comes in through env_file.
FROM node:24.21.0-alpine3.24 AS build
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

FROM node:24.21.0-alpine3.24
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
