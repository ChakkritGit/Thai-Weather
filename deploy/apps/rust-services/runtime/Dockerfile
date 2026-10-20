FROM rust:1.90.0-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS build
WORKDIR /build
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY assets ./assets
RUN --mount=type=cache,id=apps-rust-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=apps-rust-target,target=/build/target,sharing=locked \
    RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked --target x86_64-unknown-linux-gnu \
    && test -z "$(readelf -l target/x86_64-unknown-linux-gnu/release/apps-runtime | sed -n '/INTERP/p')" \
    && mkdir /empty-data /out \
    && cp target/x86_64-unknown-linux-gnu/release/apps-runtime /out/apps-runtime
FROM scratch
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Native Rust internal app services" \
      com.chakkrit.stack="rust"
COPY --from=build /out/apps-runtime /apps-runtime
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=1000:1000 /empty-data /data
USER 1000:1000
ENTRYPOINT ["/apps-runtime"]
