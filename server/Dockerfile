FROM rust:1.91-bookworm AS builder
WORKDIR /app
COPY server/Cargo.toml ./Cargo.toml
COPY server/src ./src
COPY server/migrations ./migrations
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/dcc-server /usr/local/bin/dcc-server
ENV PORT=8080
EXPOSE 8080
CMD ["dcc-server"]
