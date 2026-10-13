# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends brotli && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
ARG VITE_CHAIN_ID=5042
ARG VITE_PUSHPOT_ADDRESS
ARG VITE_ORACLE_ADDRESS
ARG VITE_WALLETCONNECT_PROJECT_ID
RUN test -n "$VITE_PUSHPOT_ADDRESS" && test -n "$VITE_ORACLE_ADDRESS" && pnpm build
RUN find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
      -o -name '*.wasm' -o -name '*.json' \) -size +1k \
      -exec gzip -k -9 {} \; -exec brotli -k -q 11 {} \;

FROM rust:1.99-bookworm AS server
# The build host is shared; leave cores for other workloads.
ENV CARGO_BUILD_JOBS=8
WORKDIR /app
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked && cp target/release/pushpot-server /usr/local/bin/

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 pushpot
COPY --from=server /usr/local/bin/pushpot-server /usr/local/bin/pushpot-server
COPY --from=web /app/web/dist /app/web
ENV WEB_DIR=/app/web BIND_ADDR=0.0.0.0:8080 RUST_LOG=info
USER pushpot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q ok <&3"]
CMD ["pushpot-server"]
