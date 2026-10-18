FROM rust:1.90.0-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS build
WORKDIR /build
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# The collector has no outbound TLS/DNS dependencies. Static glibc keeps its
# runtime to one binary; the pinned compiler/build image is already audited.
RUN RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked --target x86_64-unknown-linux-gnu \
    && test -z "$(readelf -l target/x86_64-unknown-linux-gnu/release/dock-metrics | sed -n '/INTERP/p')"

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Rust Dock host, container and proxy-history collector" \
      com.chakkrit.stack="rust"
COPY --from=build /build/target/x86_64-unknown-linux-gnu/release/dock-metrics /dock-metrics
USER 0:0
EXPOSE 9100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/dock-metrics", "--healthcheck"]
ENTRYPOINT ["/dock-metrics"]
