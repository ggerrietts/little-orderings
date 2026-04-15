# Multi-User Todo System — Project Plan
> **Stack:** Rust · Axum · SQLite (sqlx) · React + TypeScript (Vite frontend) · Tailwind CSS
> **Purpose:** This document is designed to be fed to Claude Code as a project specification. Each phase can be handed off as a focused task.

---

## Project Overview

A self-hosted, multi-user task management system with a 3-level project hierarchy, list and kanban views, due dates, targets, and per-task assignments.

### Core Feature Set
- **3-level hierarchy:** Project → Milestone → Task
- **Views:** List view and Kanban board (per project or milestone)
- **Assignments:** Tasks can be assigned to one or more users
- **Due dates & targets:** Date fields on all three levels; milestone-level "target" dates that roll up
- **Multi-user:** Session-based auth; role model (owner, member, viewer)
- **Self-hosted:** Single binary + SQLite file; no external services required

---

## Tech Stack Decisions

| Layer | Choice | Rationale |
|---|---|---|
| Web framework | `axum` | Async, ergonomic, tower middleware ecosystem |
| Database | `SQLite` via `sqlx` | Zero-ops, single file, async, compile-time query checks |
| Frontend | React 18 + TypeScript + Vite | Mature DnD ecosystem (`dnd-kit`); excellent component libraries; fast dev iteration |
| CSS | `Tailwind CSS` (via Vite plugin) | Utility-first; integrates cleanly with Vite |
| Type sharing | `ts-rs` (dev-dep on server crate) | Auto-generates TypeScript types from Rust structs; eliminates API drift |
| Auth | `argon2` + session cookies | No OAuth dependency; keep it simple |
| Build/dev | Vite dev server + `cargo watch` | Vite proxies `/api` to Axum; hot-reload on both sides |

---

## Data Model

### Schema (SQLite — `migrations/001_initial.sql`)

```sql
-- Users
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,   -- UUID
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Projects (Level 1)
CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    owner_id    INTEGER NOT NULL REFERENCES users(id),
    status      TEXT NOT NULL DEFAULT 'active',   -- active | archived
    target_date DATE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Project Members
CREATE TABLE project_members (
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',   -- owner | member | viewer
    PRIMARY KEY (project_id, user_id)
);

-- Milestones (Level 2)
CREATE TABLE milestones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'open',     -- open | in_progress | done | cancelled
    target_date DATE,
    due_date    DATE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tasks (Level 3)
CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'todo',    -- todo | in_progress | review | done | cancelled
    priority     TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high | urgent
    due_date     DATE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Task Assignments
CREATE TABLE task_assignments (
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, user_id)
);

-- Indexes
CREATE INDEX idx_milestones_project ON milestones(project_id);
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id);
CREATE INDEX idx_task_assignments_user ON task_assignments(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Status Enums

| Level | Valid Statuses |
|---|---|
| Project | `active`, `archived` |
| Milestone | `open`, `in_progress`, `done`, `cancelled` |
| Task | `todo`, `in_progress`, `review`, `done`, `cancelled` |

---

## Project Structure

```
plan-mine/
├── Cargo.toml                  # Single crate — the Axum server
├── Cargo.lock
├── .env                        # DATABASE_URL, SESSION_SECRET
├── migrations/
│   └── 001_initial.sql
├── src/
│   ├── main.rs
│   ├── db.rs                   # sqlx pool setup
│   ├── auth.rs                 # session middleware, login/logout handlers
│   ├── error.rs                # AppError type
│   ├── models.rs               # Serde + ts-rs annotated structs
│   └── routes/
│       ├── mod.rs
│       ├── projects.rs
│       ├── milestones.rs
│       ├── tasks.rs
│       └── users.rs
│
└── frontend/                   # React + TypeScript + Vite app
    ├── package.json
    ├── vite.config.ts           # proxies /api → http://localhost:3000
    ├── tsconfig.json
    ├── tailwind.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx              # Router root
        ├── types/
        │   └── api.ts           # Generated by ts-rs (do not edit manually)
        ├── api/
        │   └── client.ts        # fetch wrappers for all API routes
        ├── components/
        │   ├── KanbanBoard.tsx
        │   ├── KanbanCard.tsx
        │   ├── ListView.tsx
        │   ├── TaskCard.tsx
        │   └── DatePicker.tsx
        └── pages/
            ├── Login.tsx
            ├── Dashboard.tsx
            ├── Project.tsx
            └── NotFound.tsx
```

---

## API Design

All routes are JSON over HTTP. Auth is via session cookie set at login.

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Login with username + password |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Current user info |
| `POST` | `/api/users` | Register new user |

### Projects
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List projects for current user |
| `POST` | `/api/projects` | Create project |
| `GET` | `/api/projects/:id` | Get project with milestones |
| `PATCH` | `/api/projects/:id` | Update project |
| `DELETE` | `/api/projects/:id` | Archive project |
| `GET` | `/api/projects/:id/members` | List members |
| `POST` | `/api/projects/:id/members` | Add member |
| `DELETE` | `/api/projects/:id/members/:user_id` | Remove member |

### Milestones
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/milestones` | List milestones (with task counts) |
| `POST` | `/api/projects/:id/milestones` | Create milestone |
| `PATCH` | `/api/milestones/:id` | Update milestone |
| `DELETE` | `/api/milestones/:id` | Delete milestone |
| `PATCH` | `/api/milestones/:id/reorder` | Update sort_order |

### Tasks
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/milestones/:id/tasks` | List tasks for milestone |
| `POST` | `/api/milestones/:id/tasks` | Create task |
| `PATCH` | `/api/tasks/:id` | Update task (title, status, priority, due_date) |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `POST` | `/api/tasks/:id/assign` | Assign user |
| `DELETE` | `/api/tasks/:id/assign/:user_id` | Unassign user |
| `PATCH` | `/api/tasks/:id/reorder` | Move task (new milestone, new sort_order) |

---

## Build Phases

### Phase 0 — Scaffold & Tooling
**Goal:** Single Rust crate and React frontend both compile/start cleanly.

Claude Code prompt:
> "Set up a single Rust binary crate at the repo root (not a workspace). The `Cargo.toml` should have `name = 'plan-mine/runtime-tokio/macros/migrate/time features, tokio with full feature, tower, tower-http with trace/cors/fs features, serde with derive, serde_json, argon2, uuid with v4, time with serde, dotenvy, tracing, tracing-subscriber with env-filter. Add ts-rs with serde-compat as a dev-dependency. Create `src/main.rs` with a minimal axum server that prints 'listening' and a `/health` route. Confirm `cargo build` succeeds.
>
> Then scaffold the React frontend: run `npm create vite@latest frontend -- --template react-ts` at the repo root. `cd frontend && npm install`. Install additional packages: `@dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities react-router-dom date-fns`. Install dev dependencies: `tailwindcss @tailwindcss/vite`. Configure Tailwind via the Vite plugin. Add a `/api` proxy in `vite.config.ts` pointing to `http://localhost:3000`. Confirm `npm run dev` starts the Vite dev server."

Acceptance: `cargo build` succeeds; `npm run dev` starts without errors.

---

### Phase 1 — Database & Migrations
**Goal:** SQLite connection pool with typed queries.

Claude Code prompt:
> "In `crates/server/src/db.rs`, set up an sqlx SqlitePool using DATABASE_URL from .env (via dotenvy). Write the migration file at `migrations/001_initial.sql` containing the full schema (paste schema from Data Model section). Add a `db::init()` function that runs migrations on startup using `sqlx::migrate!()`. Call it from `main.rs` before starting the server. Add sqlx-cli to the dev toolchain."

Acceptance: App boots, migrations run, tables exist in `todo.db`.

---

### Phase 2 — Auth
**Goal:** Register, login, logout, session middleware.

Claude Code prompt:
> "Implement auth in `crates/server/src/auth.rs`. Requirements: POST /api/users creates a user with argon2-hashed password. POST /api/auth/login checks credentials, creates a session row in DB with 7-day expiry, returns a Set-Cookie header with the session ID (HttpOnly, SameSite=Lax). GET /api/auth/me reads the session cookie, validates it against the DB, and returns the current user JSON. POST /api/auth/logout deletes the session. Create an axum extractor `AuthUser` that extracts and validates the session from the request; return 401 if missing or expired. Implement a background task (tokio::spawn) that deletes expired sessions every hour."

Acceptance: Can register, login, hit /api/auth/me and get user back, logout clears it.

---

### Phase 3 — Projects & Members API
**Goal:** Full CRUD for projects and membership management.

Claude Code prompt:
> "Implement `/api/projects` routes in `crates/server/src/routes/projects.rs`. Use the AuthUser extractor on all routes. GET /api/projects returns projects where the user is a member (join project_members). POST /api/projects creates a project and inserts the creator as owner in project_members. PATCH updates name/description/target_date/status. GET /api/projects/:id returns the project plus its milestones (with task counts as a subquery). Member routes: GET lists members with roles, POST adds a member (only owner can), DELETE removes a member (only owner can, cannot remove self if last owner). Return proper HTTP status codes (201 for create, 403 for unauthorized actions, 404 for not found)."

Acceptance: All project endpoints return correct data and enforce authorization.

---

### Phase 4 — Milestones & Tasks API
**Goal:** Full CRUD for milestones and tasks with assignment.

Claude Code prompt:
> "Implement milestone routes in `routes/milestones.rs` and task routes in `routes/tasks.rs`. Milestones: standard CRUD scoped to a project (check project membership before allowing access). Tasks: CRUD scoped to a milestone. Task updates should accept title, description, status, priority, due_date as optional PATCH fields. Assignment endpoints: POST /api/tasks/:id/assign takes `{ user_id }` body and inserts into task_assignments; user must be a project member. Task reorder: PATCH /api/tasks/:id/reorder takes `{ milestone_id, sort_order }` — update the task's milestone_id and sort_order, then renumber other tasks in the affected milestones to keep order contiguous. Return full task objects with assignees embedded."

Acceptance: Can create a project → milestone → task chain via API. Task move between milestones works.

---

### Phase 5 — Frontend Foundation
**Goal:** React app boots, has routing, login page works, TypeScript types are generated.

Claude Code prompt:
> "Set up the React frontend in `frontend/`. First, add ts-rs type exports to `src/models.rs`: annotate each public struct with `#[derive(TS)] #[ts(export)]` and add a `#[cfg(test)]` module with a test `fn export_types()` that calls `<StructName>::export_all_to('../frontend/src/types/')` for each type. Run `cargo test` to generate `frontend/src/types/api.ts`.
>
> In the React app, set up `react-router-dom` with these routes: `/login` (public), `/` (dashboard, protected), `/projects/:id` (project detail, protected). Create an `AuthContext` that fetches `/api/auth/me` on load to determine auth state. Protected routes render `<Navigate to='/login' />` if unauthenticated. Create a Login page that POSTs to `/api/auth/login` and redirects to `/` on success. Style with Tailwind CSS. Use a dark theme: `slate-900` background, `slate-800` cards, `emerald-500` accents. Create a thin API client in `src/api/client.ts` with typed fetch wrappers (using the generated types) for all API endpoints."

Acceptance: App loads, unauthenticated users see login, login works and redirects, TypeScript types file exists and matches the Rust models.

---

### Phase 6 — Dashboard & Project List
**Goal:** Authenticated home screen with project cards.

Claude Code prompt:
> "Build the `Dashboard` page component in React. Use `useState` + `useEffect` (or a small `useFetch` hook) to fetch `/api/projects`. Display each project as a card showing: project name, description (truncated to 2 lines with `line-clamp-2`), target date formatted with `date-fns` as 'MMM d, yyyy' (colored red if overdue), member count, open task count, and a status badge. Include a 'New Project' button that opens a modal with a form (name, description, target_date). On submit, POST to `/api/projects` and refresh the list. Project cards are links to `/projects/:id`."

Acceptance: Dashboard shows all projects, create project modal works.

---

### Phase 7 — List View
**Goal:** Project detail page with hierarchical list of milestones and tasks.

Claude Code prompt:
> "Build the `Project` page at `/projects/:id`. Default view is List View. Fetch the project (with milestones) and for each milestone fetch its tasks. Render as: project header (name, target date, member avatars) → for each milestone, a collapsible section (milestone name, target date, status badge, task count) → inside, a list of task rows. Each task row shows: checkbox (clicking toggles status `done`/`todo` via PATCH), title, priority dot (color-coded), due date formatted with `date-fns`, assignee avatars. Inline editing: clicking a task title makes it an `<input>`, saving on blur via PATCH. Include 'Add task' at the bottom of each milestone section, and an 'Add milestone' button at the page level. For task ordering within a milestone, use `@dnd-kit/sortable` with a vertical `SortableContext`; on drag end, call PATCH `/api/tasks/:id/reorder`."

Acceptance: Full project visible in list view, tasks can be checked off, titles edited inline, and tasks reordered by drag.

---

### Phase 8 — Kanban View
**Goal:** Kanban board toggled from the same project detail page.

Claude Code prompt:
> "Add a Kanban view toggle to the project detail page. The view toggle (List / Kanban) persists in a query param `?view=kanban` so it's linkable.
>
> The kanban board has four columns: Todo, In Progress, Review, Done. Each column shows `KanbanCard` components for tasks in that status across the current project. Cards show: title, milestone name label, priority dot, due date, assignee avatars.
>
> Implement drag between columns using `@dnd-kit/core`: wrap the board in a `DndContext`, each column is a `useDroppable` target, each card is a `useDraggable` item. On `onDragEnd`, if the card moved to a different column, optimistically update local state and call PATCH `/api/tasks/:id` with the new status. Include a count badge in each column header."

Acceptance: Kanban board renders, dragging a card between columns updates its status immediately and persists via API.

---

### Phase 9 — Assignment UI
**Goal:** Assign/unassign users to tasks from both views.

Claude Code prompt:
> "Add a `TaskDetailModal` component. Clicking a task title in either view opens the modal (use a React portal). The modal contains: editable task title, editable description textarea, status `<select>`, priority `<select>`, date `<input type='date'>` for due date, and an Assignees section. Assignees are shown as avatar initials with a remove (×) button; clicking calls DELETE `/api/tasks/:id/assign/:user_id`. An 'Assign' button opens a dropdown listing project members not yet assigned; clicking one calls POST `/api/tasks/:id/assign`. All changes are saved immediately (per-field PATCH or POST/DELETE) and the parent component's task list state is updated via a callback prop so the card reflects changes without a reload."

Acceptance: Can open task detail, assign a member, see avatar appear on task card in both views.

---

### Phase 10 — Polish & QoL
**Goal:** Dates, overdue highlighting, keyboard shortcuts, empty states.

Claude Code prompt:
> "Add polish across the app: (1) Highlight overdue tasks (due_date < today and status != done) with a red due date. Highlight overdue milestones similarly. (2) Add empty states for: no projects (with a call-to-action), no milestones in a project, no tasks in a milestone. (3) Add a keyboard shortcut 'n' to open the new task form when focused in a milestone. (4) Add a global search bar (Ctrl+K) that filters visible tasks by title. (5) Add a 'My Tasks' view accessible from the sidebar that shows all tasks assigned to the current user across all projects, grouped by project, sorted by due date."

---

## Development Notes for Claude Code

### Working Conventions
- Use `sqlx::query_as!` with compile-time checked queries wherever possible
- All handler functions return `Result<impl IntoResponse, AppError>` where `AppError` implements `IntoResponse` (maps to appropriate HTTP status + JSON error body)
- Use `tower_http::trace::TraceLayer` for request logging
- Enable `tower_http::cors::CorsLayer` in dev to allow Vite's port to call the Axum server
- Run `cargo clippy` and `cargo fmt` between phases; fix all warnings
- Migrations are append-only; never edit existing migration files
- `frontend/src/types/api.ts` is generated by `cargo test` — do not edit it manually
- Re-run type generation any time `src/models.rs` changes

### Testing Approach
- Phase 1–4: Write integration tests in `server/src/routes/*.rs` using `axum::test` helpers and a temporary in-memory SQLite DB
- Phase 5–9: Manual browser testing is sufficient for the MVP; add snapshot tests later

### Environment Variables (`.env`)
```
DATABASE_URL=sqlite:./todo.db
SESSION_SECRET=changeme-use-a-real-secret-in-prod
HOST=127.0.0.1
PORT=3000
```

### Running Locally
```bash
# Install Rust tools
cargo install sqlx-cli cargo-watch

# Setup DB
sqlx database create
sqlx migrate run

# Terminal 1 — Axum backend (auto-reloads on change)
cargo watch -x run

# Terminal 2 — React frontend (Vite dev server, proxies /api to :3000)
cd frontend && npm run dev
```

### Production Build
```bash
# Build React app
cd frontend && npm run build   # outputs to frontend/dist/

# Axum serves dist/ as static files via tower-http ServeDir
cargo build --release
```

---

## Suggested Claude Code Session Flow

1. **Start a new session per phase.** Open Claude Code in your project root and say: *"We're working on Phase N of PLAN.md. Here is the prompt for this phase: [paste prompt]."*
2. **After each phase**, run the acceptance criteria manually before moving on.
3. **For bug fixing**, start a new session and describe the symptom + paste the relevant file. Don't carry long contexts across phases.
4. **Schema changes** after Phase 1 should be new migration files (e.g., `002_add_...sql`), never edits to `001_initial.sql`.

---

*Total estimated phases: 10 · Rough complexity order: Phase 2 (auth) is the most complex on the backend; Phase 8 (kanban drag) is straightforward with `dnd-kit`.*
