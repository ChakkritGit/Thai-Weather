# Backup bundles (src/backup.ts on the services image) + the tools it calls: pg_dump, tar, openssl, zip.
#   docker buildx build -f backup.Dockerfile .        (after ./build.sh services)
FROM apps-services:local
USER root
RUN apk add --no-cache postgresql17-client zip openssl tar
COPY backup/restore.sh backup/README.txt /app/backup/
RUN chmod -R a+rX /app/backup
CMD ["bun", "src/backup.ts"]
