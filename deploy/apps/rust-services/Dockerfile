# DB-IP "IP to Country Lite" for the Cyber page (CC BY 4.0, attribution is shown on the page). A release is
# eligible 14 days after DB-IP publishes it; bump the month and the checksum together (see HANDOFF.md).
ARG DBIP_MONTH=2026-10
ARG DBIP_SHA256=097426b8ddae89157d444a59ac1847e873f7943c32d52becc4371c8b0273af80

FROM rust:1.90.0-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS build
ARG DBIP_MONTH
ARG DBIP_SHA256
WORKDIR /build
ENV CARGO_BUILD_JOBS=2
# before the sources, so a code change does not download it again; a wrong checksum fails the build
RUN mkdir /geo \
    && curl -fsSL --retry 3 "https://download.db-ip.com/free/dbip-country-lite-${DBIP_MONTH}.csv.gz" -o /geo/dbip-country-lite.csv.gz \
    && echo "${DBIP_SHA256}  /geo/dbip-country-lite.csv.gz" | sha256sum -c -
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# The collector has no outbound TLS/DNS dependencies. Static glibc keeps its
# runtime to one binary; the pinned compiler/build image is already audited.
RUN RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked --target x86_64-unknown-linux-gnu \
    && test -z "$(readelf -l target/x86_64-unknown-linux-gnu/release/dock-metrics | sed -n '/INTERP/p')"

FROM scratch
ARG DBIP_MONTH
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Rust Dock host, container and proxy-history collector" \
      com.chakkrit.stack="rust"
COPY --from=build /build/target/x86_64-unknown-linux-gnu/release/dock-metrics /dock-metrics
COPY --from=build /geo/dbip-country-lite.csv.gz /geo/dbip-country-lite.csv.gz
ENV GEOIP_DB=/geo/dbip-country-lite.csv.gz GEOIP_MONTH=${DBIP_MONTH}
USER 0:0
EXPOSE 9100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/dock-metrics", "--healthcheck"]
ENTRYPOINT ["/dock-metrics"]
