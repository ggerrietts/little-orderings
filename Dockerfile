ARG GIT_SHA=dev

# Stage 1: Build the React frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
ARG GIT_SHA
ENV VITE_GIT_SHA=$GIT_SHA
RUN npm run build

# Stage 2: Build the Rust backend
FROM rust:1.94-bookworm AS backend-builder
WORKDIR /app

RUN apt-get update && apt-get install -y libsqlite3-dev && rm -rf /var/lib/apt/lists/*

# Install sqlx-cli to create the DB for compile-time query checks
RUN cargo install sqlx-cli --no-default-features --features sqlite

COPY Cargo.toml Cargo.lock ./
COPY migrations/ migrations/
COPY src/ src/

# Create and migrate a throw-away DB so sqlx macros can verify queries
ENV DATABASE_URL=sqlite:/app/build.db
RUN sqlx database create && sqlx migrate run

RUN cargo build --release

# Stage 3: Minimal runtime image
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libsqlite3-0 ca-certificates curl libssl3 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 app && useradd -u 10001 -g app -M -s /usr/sbin/nologin app
WORKDIR /app

COPY --from=backend-builder /app/target/release/little-orderings ./
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
COPY migrations/ migrations/

# Ownership is preserved when Docker initializes an empty named volume from
# this path, so /data comes up writable by `app` on first run.
RUN mkdir -p /data && chown app:app /data

ARG GIT_SHA
ENV DATABASE_URL=sqlite:/data/todo.db
ENV HOST=0.0.0.0
ENV PORT=3000
ENV FRONTEND_DIST=/app/frontend/dist
ENV GIT_SHA=$GIT_SHA

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:3000/health || exit 1
CMD ["./little-orderings", "serve"]
