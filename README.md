# Little Orderings

A self-hosted task management app. Organize work into projects, milestones, and tasks. Drag tasks between milestones in list view or between status columns in kanban view.

## Features

- **Projects** — create and manage multiple projects, each with a description and optional target date
- **Milestones** — group tasks within a project; drag to reorder
- **Tasks** — title, description, status, priority, due date, and assignees; drag to reorder within or between milestones
- **Kanban board** — four columns (Todo / In Progress / Blocked / Done); drag cards to change status
- **List view** — all milestones and tasks in sort order with inline add-task forms
- **Task detail modal** — click any task to edit all fields; all changes auto-save on change or blur
- **Multi-user** — session-based auth; each project has members with roles

## Running with Docker Compose

The easiest way to run the app. The `init-user` service creates a default user on first start, then the `app` service starts the web server.

```sh
docker compose up
```

The app is available at **http://localhost:8080**.

Default credentials (set in `docker-compose.yml`):

| Field    | Value            |
|----------|------------------|
| Username | `testuser`       |
| Password | `changeme`       |

To change the default user or add more users before first start, edit the `init-user` entrypoint in `docker-compose.yml`, or use the CLI after the volume is created (see below).

## Managing Users

The binary includes a `user` subcommand for managing accounts. In a Docker deployment, run it against the same data volume:

```sh
# Create a user
docker compose run --rm init-user ./little-orderings user create <username> <email> <password>

# List all users
docker compose run --rm init-user ./little-orderings user list

# Change a password
docker compose run --rm init-user ./little-orderings user set-password <username> <newpassword>

# Delete a user
docker compose run --rm init-user ./little-orderings user delete <username>
```

If running the binary directly (not via Docker), set `DATABASE_URL` first:

```sh
export DATABASE_URL=sqlite:./todo.db
./little-orderings user create alice alice@example.com s3cr3t
```

## CLI Reference

```
little-orderings <COMMAND>

Commands:
  serve                 Start the web server
  user create           Create a new user
  user list             List all users
  user set-password     Change a user's password
  user delete           Delete a user by username
```

## Running Locally (Development)

**Prerequisites:** Rust, Node.js 22+, `sqlx-cli` (`cargo install sqlx-cli --no-default-features --features sqlite`)

```sh
# 1. Create and migrate the database
export DATABASE_URL=sqlite:./todo.db
sqlx database create
sqlx migrate run

# 2. Create a user
cargo run -- user create alice alice@example.com changeme

# 3. Start the backend
cargo run -- serve

# 4. In a separate terminal, start the frontend dev server
cd frontend
npm install
npm run dev
```

The frontend dev server proxies API requests to the backend at `http://localhost:3000`. Open **http://localhost:5173**.

## Environment Variables

| Variable         | Default                    | Description                                      |
|------------------|----------------------------|--------------------------------------------------|
| `DATABASE_URL`   | `sqlite:/data/todo.db`     | SQLite database path                             |
| `SESSION_SECRET` | *(required)*               | Secret key for signing session cookies           |
| `HOST`           | `127.0.0.1`                | Bind address                                     |
| `PORT`           | `3000`                     | Bind port                                        |
| `ALLOWED_ORIGIN` | `http://localhost:5173`    | CORS allowed origin for the frontend             |
| `FRONTEND_DIST`  | `frontend/dist`            | Path to the compiled frontend assets             |
| `RUST_LOG`       | `little_orderings=debug`   | Log level filter                                 |

## Building

```sh
# Production build (binary + frontend assets baked into Docker image)
docker build -t little-orderings .

# Backend only
cargo build --release

# Frontend only
cd frontend && npm run build
```
