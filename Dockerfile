# syntax=docker/dockerfile:1
# Impulse: the Rust server (API and websocket on PORT). The web app is on Cloudflare (web/wrangler.jsonc), which
# forwards /api and /ws here. State lives in DATA_DIR (SQLite), which must be a persistent volume.

# ---- server (Rust) ----
FROM rust:1.96-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
# Cache mounts keep the crate registry and build artifacts between builds on the same builder.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p impulse-server \
    && cp target/release/impulse-server /impulse-server

# ---- runtime ----
FROM debian:bookworm-slim
# ca-certificates: the live price feeds (Hyperliquid, Polymarket) are HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /impulse-server /app/impulse-server
ENV PORT=8787 \
    DATA_DIR=/data
EXPOSE 8787
CMD ["/app/impulse-server"]
