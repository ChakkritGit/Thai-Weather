# SymOS accounts (src/main.rs): one static binary on scratch, as rust-services/runtime is built
FROM rust:1.90.0-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS build
WORKDIR /build
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,id=symos-accounts-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=symos-accounts-target,target=/build/target,sharing=locked \
    RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked --target x86_64-unknown-linux-gnu \
    && test -z "$(readelf -l target/x86_64-unknown-linux-gnu/release/symos-accounts | sed -n '/INTERP/p')" \
    && mkdir /out && cp target/x86_64-unknown-linux-gnu/release/symos-accounts /out/symos-accounts
FROM scratch
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="SymOS online accounts and recovery-key escrow" \
      com.chakkrit.stack="rust"
COPY --from=build /out/symos-accounts /symos-accounts
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["/symos-accounts", "--healthcheck"]
ENTRYPOINT ["/symos-accounts"]
