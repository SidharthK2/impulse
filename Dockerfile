# syntax=docker/dockerfile:1
# Impulse: one image holding the Rust server and the built web app. The server serves both, plus the API and the
# websocket, on PORT. State lives in DATA_DIR (SQLite), which must be a persistent volume.

# ---- web app (React + Vite) ----
FROM node:24-bookworm-slim AS web
WORKDIR /src/web
RUN npm install -g pnpm@11.6.0
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY web/ ./
RUN pnpm run build

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
COPY --from=web /src/web/dist /app/web/dist
ENV PORT=8787 \
    WEB_DIR=/app/web/dist \
    DATA_DIR=/data
EXPOSE 8787
CMD ["/app/impulse-server"]
