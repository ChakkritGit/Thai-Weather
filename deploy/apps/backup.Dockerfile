# Native backup service, retaining the existing pg_dump/tar/OpenSSL/zip restore format.
# Alpine digest published 2026-06-22; every installed package is pinned to the
# existing production toolset (all built before 2026-10-05).
FROM alpine:3.22.5@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
RUN apk add --no-cache \
    acl-libs=2.3.2-r1 \
    alpine-baselayout=3.7.0-r0 \
    alpine-baselayout-data=3.7.0-r0 \
    alpine-keys=2.5-r0 \
    alpine-release=3.22.5-r0 \
    apk-tools=2.14.10-r0 \
    busybox=1.37.0-r20 \
    busybox-binsh=1.37.0-r20 \
    ca-certificates-bundle=20260611-r0 \
    libapk2=2.14.10-r0 \
    libcrypto3=3.5.9-r0 \
    libncursesw=6.5_p20250503-r0 \
    libpq=17.11-r0 \
    libssl3=3.5.9-r0 \
    lz4-libs=1.10.0-r0 \
    musl=1.2.5-r12 \
    ncurses-terminfo-base=6.5_p20250503-r0 \
    openssl=3.5.9-r0 \
    postgresql-common=1.2-r1 \
    postgresql17-client=17.11-r0 \
    readline=8.2.13-r1 \
    tar=1.35-r3 \
    unzip=6.0-r15 \
    zip=3.0-r13 \
    zlib=1.3.2-r0 \
    zstd-libs=1.5.7-r0
COPY --from=runtime /apps-runtime /apps-runtime
COPY backup/restore.sh backup/README.txt /app/backup/
RUN chmod -R a+rX /app/backup
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      com.chakkrit.stack="rust"
USER 0:0
ENTRYPOINT ["/apps-runtime"]
CMD ["backup"]
