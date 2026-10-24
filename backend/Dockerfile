# Rust HTTP server, with the existing Python numerical runtime retained exactly.
FROM rust:1.90.0-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS rust-build
WORKDIR /build
ENV CARGO_BUILD_JOBS=2
COPY rust-api/Cargo.toml rust-api/Cargo.lock rust-api/openapi.json ./
COPY rust-api/src ./src
RUN cargo build --release --locked

# This is the same Python version/base already deployed before the Rust migration,
# now pinned rather than resolving the floating 3.12-slim tag again.
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Rust HTTP API with a private Python numerical worker" \
      com.chakkrit.stack="rust-python"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 THWX_DATA_DIR=/var/lib/thwx
# Debian's security updates and a pip without its known CVEs (2026-10-25 image scan, owner's request)
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/backend
COPY requirements-runtime.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check pip==26.2.1 \
 && pip install --no-cache-dir -r requirements-runtime.txt
COPY --from=rust-build /build/target/release/thwx-api /usr/local/bin/thwx-api
COPY app ./app
COPY verify ./verify
RUN useradd --system --uid 10001 thwx && mkdir -p /var/lib/thwx && chown thwx /var/lib/thwx
USER thwx
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health')"
CMD ["/usr/local/bin/thwx-api"]
