# Stage 1: Build the React frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
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
RUN apt-get update && apt-get install -y libsqlite3-0 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=backend-builder /app/target/release/little-orderings ./
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
COPY migrations/ migrations/

RUN mkdir -p /data

ENV DATABASE_URL=sqlite:/data/todo.db
ENV HOST=0.0.0.0
ENV PORT=3000
ENV FRONTEND_DIST=/app/frontend/dist

EXPOSE 3000
CMD ["./little-orderings", "serve"]
