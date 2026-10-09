# Next.js web app (standalone output)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# rewrites are compiled at build time – point them at the API service
ARG THWX_API_URL=http://api:8000
ENV THWX_API_URL=$THWX_API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Thai Weather HD – Next.js web app"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
