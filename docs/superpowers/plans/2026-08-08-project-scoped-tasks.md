# Project-Scoped Tasks with Optional Milestone Tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tasks belong to a project directly (required) and are optionally tagged with a milestone (no longer required), with List view supporting both the existing milestone-grouped display and a new flat, project-wide-ordered display.

**Architecture:** A migration adds `tasks.project_id` (backfilled, required) and makes `tasks.milestone_id` nullable with `ON DELETE SET NULL`. `sort_order` changes from per-milestone to project-wide. Reordering gets a `scoped` flag distinguishing "drag within a milestone-filtered section" from "drag in the flat list," since both operate on one shared ordering. The frontend's `tasks` state flattens from a milestone-keyed map to a single array.

**Tech Stack:** Rust/Axum/SQLite backend, React 19/Vite CSR frontend, Vitest/RTL for frontend tests, dnd-kit for drag-and-drop.

**Spec:** `docs/superpowers/specs/2026-08-08-project-scoped-tasks-design.md`

## Global Constraints

- Every existing task has a non-null `milestone_id` today — `project_id` backfills deterministically via a join through `milestones`, zero data loss.
- Deleting a milestone now untags its tasks (`SET NULL`) instead of deleting them (was `CASCADE`) — deliberate behavior change, confirmed during design.
- `sort_order` is a single ordering across every task in a project, not per-milestone.
- A grouped-mode (milestone-filtered) reorder must never change the stored `sort_order` value, or the relative order, of any task outside the touched milestone — implemented by redistributing the touched milestone's own current slot values, never a fresh `0..N` renumbering of the subset.
- Milestone (re)assignment happens only through the task detail modal's existing dropdown (extended with a "No milestone" option) — never through the reorder endpoint, and not directly from a chip in list/kanban rows.
- The "No milestone" section in grouped mode is always rendered, even when empty, pinned last, and is not itself draggable (it isn't backed by a real milestone).
- Every Rust task ends with `cargo build` passing (`cargo test` where relevant). Every frontend task ends with `cd frontend && npm test && npm run build` passing.
- Commit after each task — do not batch commits.

---

## File Map

**Backend — created:**
- `migrations/006_project_scoped_tasks.sql` (Task 1)

**Backend — modified:**
- `src/models.rs` — `Task` gains `project_id`, `milestone_id` becomes `Option<i64>`; `CreateTaskRequest` gains `milestone_id`; `UpdateTaskRequest` gains `milestone_id: Patch<i64>`; `ReorderTaskRequest` becomes `{ sort_order, scoped }` (Tasks 2, 3)
- `src/routes/helpers.rs` — `project_id_for_task` simplifies to a direct query (Task 2)
- `src/routes/tasks.rs` — `list_tasks`/`create_task` become project-scoped (Task 2); `update_task` gains milestone patching, `reorder_task` rewritten for scoped/flat (Task 3)
- `src/routes/mod.rs` — task routes re-registered under `/projects/:id/tasks` (Task 2)

**Frontend — modified:**
- `frontend/src/api/client.ts` — `tasks.list`/`tasks.create` become project-scoped, `tasks.reorder` gains `scoped`, drops `milestoneId` (Task 4)
- `frontend/src/contexts/ProjectContext.tsx` — `tasks` becomes a flat array; every task action drops its `milestoneId` parameter; `deleteMilestone` untags instead of removing tasks (Task 4)
- `frontend/src/components/KanbanBoard.tsx`, `frontend/src/components/KanbanBoard.test.tsx` — read from flat `tasks`, null-safe milestone lookup (Task 5)
- `frontend/src/components/TaskDetailModal.tsx`, `frontend/src/components/TaskDetailModal.test.tsx` — milestone dropdown gains "No milestone", assignment via `updateTask` not `reorderTask` (Task 5)
- `frontend/src/components/ListView.tsx`, `frontend/src/components/ListView.test.tsx` — grouping toggle, "No milestone" section, flat mode with chips (Task 6)

**Not modified:** `frontend/src/components/KanbanCard.tsx` (already handles an absent milestone gracefully — no change needed), `Dockerfile`, `docker-compose*.yml`, all other routes/components.

---

## Task 1: Migration — project-scoped tasks

**Files:**
- Create: `migrations/006_project_scoped_tasks.sql`

**Interfaces:**
- Produces: `tasks.project_id INTEGER NOT NULL`, `tasks.milestone_id INTEGER` (nullable, `ON DELETE SET NULL`), `tasks.sort_order` renumbered project-wide. Consumed by every later task.

This is the highest-stakes task in this plan — it reshapes a table with real production data. Verify it thoroughly before moving on.

- [ ] **Step 1: Write the migration**

Create `migrations/006_project_scoped_tasks.sql`:

```sql
-- Tasks become project-scoped directly; milestone becomes an optional tag
-- rather than a required container. sort_order changes from per-milestone
-- to project-wide.

-- Add project_id nullable first (SQLite can't add a NOT NULL column
-- without a static default; this needs a computed backfill instead).
ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id);

UPDATE tasks
SET project_id = (SELECT project_id FROM milestones WHERE milestones.id = tasks.milestone_id);

-- Rebuild the table to: make project_id NOT NULL, make milestone_id
-- nullable, and change milestone_id's delete behavior from CASCADE to SET
-- NULL (deleting a milestone should untag its tasks, not delete them).
-- SQLite's ALTER TABLE can't change a column's nullability or foreign key
-- clause in place, so this needs the standard rebuild pattern.
CREATE TABLE tasks_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'todo',
    priority     TEXT NOT NULL DEFAULT 'normal',
    due_date     DATE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tasks_new (id, project_id, milestone_id, title, description, status,
                        priority, due_date, sort_order, created_by, created_at, updated_at)
SELECT id, project_id, milestone_id, title, description, status,
       priority, due_date, sort_order, created_by, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- Rebuilding the table drops its indexes and triggers along with it —
-- recreate them (index from migration 001, trigger from migration 002).
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TRIGGER tasks_updated_at
AFTER UPDATE ON tasks
BEGIN
    UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Renumber sort_order project-wide. Every task at this point still has a
-- milestone (this migration runs before any task can exist without one),
-- so order by each task's milestone's own sort_order, then the task's old
-- per-milestone sort_order, then id — this reproduces today's
-- milestone-grouped visual order as the initial flat project-wide order.
WITH ranked AS (
    SELECT t.id,
           ROW_NUMBER() OVER (
               PARTITION BY t.project_id
               ORDER BY m.sort_order, t.sort_order, t.id
           ) - 1 AS new_order
    FROM tasks t
    JOIN milestones m ON m.id = t.milestone_id
)
UPDATE tasks
SET sort_order = (SELECT new_order FROM ranked WHERE ranked.id = tasks.id)
WHERE id IN (SELECT id FROM ranked);
```

- [ ] **Step 2: Rehearse the migration against synthetic pre-migration data**

This is the important check — it proves the backfill and renumbering logic against representative data, not just that the SQL parses. Uses the `sqlite3` CLI directly against the plain migration `.sql` files, no Rust/cargo needed:

```bash
rm -f /tmp/migration_test.db
sqlite3 /tmp/migration_test.db < migrations/001_initial.sql
sqlite3 /tmp/migration_test.db < migrations/002_updated_at_triggers.sql
sqlite3 /tmp/migration_test.db < migrations/003_remove_owner_id.sql
sqlite3 /tmp/migration_test.db < migrations/004_task_status_blocked.sql
sqlite3 /tmp/migration_test.db < migrations/005_push_notifications.sql

sqlite3 /tmp/migration_test.db <<'EOF'
INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@example.com', 'x');
INSERT INTO projects (id, name) VALUES (1, 'Kitchen Remodel');
INSERT INTO project_members (project_id, user_id, role) VALUES (1, 1, 'owner');
INSERT INTO milestones (id, project_id, name, sort_order) VALUES (10, 1, 'Demo', 0);
INSERT INTO milestones (id, project_id, name, sort_order) VALUES (20, 1, 'Build', 1);
INSERT INTO tasks (id, milestone_id, title, sort_order, created_by) VALUES (100, 10, 'Remove cabinets', 0, 1);
INSERT INTO tasks (id, milestone_id, title, sort_order, created_by) VALUES (101, 10, 'Remove flooring', 1, 1);
INSERT INTO tasks (id, milestone_id, title, sort_order, created_by) VALUES (102, 20, 'Install cabinets', 0, 1);
EOF

sqlite3 /tmp/migration_test.db < migrations/006_project_scoped_tasks.sql

sqlite3 /tmp/migration_test.db "SELECT id, project_id, milestone_id, title, sort_order FROM tasks ORDER BY sort_order;"
```

Expected output:
```
100|1|10|Remove cabinets|0
101|1|10|Remove flooring|1
102|1|20|Install cabinets|2
```
(`project_id` backfilled to `1` for all three; `sort_order` renumbered project-wide `0,1,2` in milestone-then-old-order sequence.)

- [ ] **Step 3: Verify schema, index, and trigger survived the rebuild**

```bash
sqlite3 /tmp/migration_test.db ".schema tasks"
sqlite3 /tmp/migration_test.db "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='tasks';"
sqlite3 /tmp/migration_test.db "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks';"
```

Expected: the schema output shows `project_id INTEGER NOT NULL` and `milestone_id INTEGER` (no `NOT NULL` on that one); the trigger query returns `tasks_updated_at`; the index query returns `idx_tasks_milestone` and `idx_tasks_project`.

- [ ] **Step 4: Verify `ON DELETE SET NULL` actually untags rather than deletes**

```bash
sqlite3 /tmp/migration_test.db "PRAGMA foreign_keys=ON; DELETE FROM milestones WHERE id=10; SELECT id, milestone_id FROM tasks WHERE id IN (100,101,102);"
```

Expected:
```
100|
101|
102|20
```
(Tasks 100 and 101 survive with `milestone_id` now empty/NULL, not deleted. `PRAGMA foreign_keys=ON` has to be set explicitly for this one-off `sqlite3` CLI session — the app itself always has it on via `src/db.rs`, but a bare `sqlite3` session defaults to off.)

Clean up: `rm -f /tmp/migration_test.db`.

- [ ] **Step 5: Verify it also runs cleanly against a fresh, empty database**

```bash
rm -f /tmp/fresh_test.db
DATABASE_URL=sqlite:/tmp/fresh_test.db cargo run -- user list
rm -f /tmp/fresh_test.db
```

Expected: prints "No users." with no errors — confirms all 6 migrations apply cleanly in sequence from empty, not just the rehearsal path above.

- [ ] **Step 6: Commit**

```bash
git add migrations/006_project_scoped_tasks.sql
git commit -m "feat: make tasks project-scoped with an optional milestone tag"
```

---

## Task 2: Backend — project-scoped task creation and listing

**Files:**
- Modify: `src/models.rs`
- Modify: `src/routes/helpers.rs`
- Modify: `src/routes/tasks.rs`
- Modify: `src/routes/mod.rs`

**Interfaces:**
- Consumes: the new schema from Task 1.
- Produces: `POST /api/projects/:id/tasks`, `GET /api/projects/:id/tasks` (replacing the milestone-scoped versions). `Task.project_id: i64`, `Task.milestone_id: Option<i64>`. `CreateTaskRequest.milestone_id: Option<i64>`.

- [ ] **Step 1: Update `Task` and `CreateTaskRequest` in `src/models.rs`**

Change the `Task` struct from:

```rust
pub struct Task {
    #[cfg_attr(test, ts(type = "number"))]
    pub id: i64,
    #[cfg_attr(test, ts(type = "number"))]
    pub milestone_id: i64,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub sort_order: i64,
    #[cfg_attr(test, ts(type = "number"))]
    pub created_by: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
```

to:

```rust
pub struct Task {
    #[cfg_attr(test, ts(type = "number"))]
    pub id: i64,
    #[cfg_attr(test, ts(type = "number"))]
    pub project_id: i64,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub milestone_id: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub sort_order: i64,
    #[cfg_attr(test, ts(type = "number"))]
    pub created_by: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
```

Change `CreateTaskRequest` from:

```rust
#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<TaskPriority>,
    pub due_date: Option<String>,
}
```

to:

```rust
#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<TaskPriority>,
    pub due_date: Option<String>,
    pub milestone_id: Option<i64>,
}
```

(No `#[serde(default)]` needed on `milestone_id` here — serde already treats a missing JSON key as `None` for any `Option<T>` field.)

- [ ] **Step 2: Simplify `project_id_for_task` in `src/routes/helpers.rs`**

Change:

```rust
pub async fn project_id_for_task(
    pool: &sqlx::SqlitePool,
    task_id: i64,
) -> Result<i64, AppError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT m.project_id FROM tasks t
         JOIN milestones m ON m.id = t.milestone_id
         WHERE t.id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await?;
    row.map(|(id,)| id).ok_or(AppError::NotFound)
}
```

to:

```rust
pub async fn project_id_for_task(
    pool: &sqlx::SqlitePool,
    task_id: i64,
) -> Result<i64, AppError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT project_id FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_optional(pool)
            .await?;
    row.map(|(id,)| id).ok_or(AppError::NotFound)
}
```

`project_id_for_milestone` (used elsewhere in this file) is unchanged.

- [ ] **Step 3: Rewrite `list_tasks` and `create_task` in `src/routes/tasks.rs`**

Change `get_full_task` (the private helper near the top of the file) from:

```rust
async fn get_full_task(
    pool: &sqlx::SqlitePool,
    task_id: i64,
) -> Result<TaskWithAssignees, AppError> {
    let task: Task = sqlx::query_as(
        "SELECT id, milestone_id, title, description, status, priority,
                due_date, sort_order, created_by, created_at, updated_at
         FROM tasks WHERE id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let assignees: Vec<Assignee> = sqlx::query_as(
        "SELECT ta.user_id, u.username
         FROM task_assignments ta JOIN users u ON u.id = ta.user_id
         WHERE ta.task_id = ?",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;

    Ok(TaskWithAssignees { task, assignees })
}
```

to:

```rust
async fn get_full_task(
    pool: &sqlx::SqlitePool,
    task_id: i64,
) -> Result<TaskWithAssignees, AppError> {
    let task: Task = sqlx::query_as(
        "SELECT id, project_id, milestone_id, title, description, status, priority,
                due_date, sort_order, created_by, created_at, updated_at
         FROM tasks WHERE id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let assignees: Vec<Assignee> = sqlx::query_as(
        "SELECT ta.user_id, u.username
         FROM task_assignments ta JOIN users u ON u.id = ta.user_id
         WHERE ta.task_id = ?",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;

    Ok(TaskWithAssignees { task, assignees })
}
```

Change `list_tasks` from:

```rust
pub async fn list_tasks(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id =
        project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let tasks: Vec<Task> = sqlx::query_as(
        "SELECT id, milestone_id, title, description, status, priority,
                due_date, sort_order, created_by, created_at, updated_at
         FROM tasks WHERE milestone_id = ? ORDER BY sort_order, id",
    )
    .bind(milestone_id)
    .fetch_all(&state.pool)
    .await?;
```

to:

```rust
pub async fn list_tasks(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let tasks: Vec<Task> = sqlx::query_as(
        "SELECT id, project_id, milestone_id, title, description, status, priority,
                due_date, sort_order, created_by, created_at, updated_at
         FROM tasks WHERE project_id = ? ORDER BY sort_order, id",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
```

(The rest of `list_tasks` — the early-return-on-empty and batch assignee fetch — is unchanged; leave it as-is.)

Change `create_task` from:

```rust
pub async fn create_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
    Json(payload): Json<CreateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id =
        project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let priority = payload.priority.as_ref().map(|p| p.as_str()).unwrap_or("normal");

    let mut tx = state.pool.begin().await?;

    let (next_order,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE milestone_id = ?",
    )
    .bind(milestone_id)
    .fetch_one(&mut *tx)
    .await?;

    let result = sqlx::query(
        "INSERT INTO tasks (milestone_id, title, description, priority, due_date, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(milestone_id)
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(priority)
    .bind(&payload.due_date)
    .bind(next_order)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;

    let task_id = result.last_insert_rowid();
    tx.commit().await?;

    crate::notifications::notify_watchers(
        &state.pool,
        project_id,
        crate::models::Tier::TaskMilestones,
        user.id,
    )
    .await;

    let task = get_full_task(&state.pool, task_id).await?;
    Ok((StatusCode::CREATED, Json(task)))
}
```

to:

```rust
pub async fn create_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<CreateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    // If a milestone was specified, it must belong to this project.
    if let Some(milestone_id) = payload.milestone_id {
        let milestone_project_id =
            project_id_for_milestone(&state.pool, milestone_id).await?;
        if milestone_project_id != project_id {
            return Err(AppError::BadRequest(
                "Milestone does not belong to this project".to_string(),
            ));
        }
    }

    let priority = payload.priority.as_ref().map(|p| p.as_str()).unwrap_or("normal");

    let mut tx = state.pool.begin().await?;

    let (next_order,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;

    let result = sqlx::query(
        "INSERT INTO tasks (project_id, milestone_id, title, description, priority, due_date, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(payload.milestone_id)
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(priority)
    .bind(&payload.due_date)
    .bind(next_order)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;

    let task_id = result.last_insert_rowid();
    tx.commit().await?;

    crate::notifications::notify_watchers(
        &state.pool,
        project_id,
        crate::models::Tier::TaskMilestones,
        user.id,
    )
    .await;

    let task = get_full_task(&state.pool, task_id).await?;
    Ok((StatusCode::CREATED, Json(task)))
}
```

- [ ] **Step 4: Re-register the routes in `src/routes/mod.rs`**

Change:

```rust
        // Tasks
        .route(
            "/milestones/:id/tasks",
            get(tasks::list_tasks).post(tasks::create_task),
        )
```

to:

```rust
        // Tasks
        .route(
            "/projects/:id/tasks",
            get(tasks::list_tasks).post(tasks::create_task),
        )
```

(Leave this route registered in place among the other `// Tasks` routes — it doesn't need to move next to `// Projects` even though the path now starts with `/projects/:id`; keep the existing grouping-by-comment structure.)

- [ ] **Step 5: Regenerate frontend types and run the backend test suite**

Run: `cargo test`
Expected: passes, and regenerates `frontend/src/types/Task.ts` — open it afterward and confirm `milestone_id` reads as `number | null`, not something involving `bigint` — if it doesn't, adjust the `ts(type = "...")` override in Step 1 to match and re-run.

Run: `cargo build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/models.rs src/routes/helpers.rs src/routes/tasks.rs src/routes/mod.rs frontend/src/types/Task.ts
git commit -m "feat: make task creation and listing project-scoped"
```

---

## Task 3: Backend — milestone tagging via update, scoped/flat reorder

**Files:**
- Modify: `src/models.rs`
- Modify: `src/routes/tasks.rs`

**Interfaces:**
- Consumes: `Task`, `get_full_task`, `project_id_for_task`, `project_id_for_milestone` from Task 2.
- Produces: `UpdateTaskRequest.milestone_id: Patch<i64>`. `ReorderTaskRequest { sort_order: i64, scoped: bool }`. `PATCH /api/tasks/:id/reorder` now returns `Vec<TaskWithAssignees>` (every task whose `sort_order` may have changed), not a single task — Task 4's frontend code relies on this.

- [ ] **Step 1: Add `milestone_id` to `UpdateTaskRequest`, rewrite `ReorderTaskRequest`**

Change `UpdateTaskRequest` from:

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    #[serde(default)]
    pub description: Patch<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    #[serde(default)]
    pub due_date: Patch<String>,
}
```

to:

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    #[serde(default)]
    pub description: Patch<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    #[serde(default)]
    pub due_date: Patch<String>,
    #[serde(default)]
    pub milestone_id: Patch<i64>,
}
```

Change `ReorderTaskRequest` from:

```rust
#[derive(Debug, Deserialize)]
pub struct ReorderTaskRequest {
    pub milestone_id: i64,
    pub sort_order: i64,
}
```

to:

```rust
#[derive(Debug, Deserialize)]
pub struct ReorderTaskRequest {
    pub sort_order: i64,
    #[serde(default)]
    pub scoped: bool,
}
```

- [ ] **Step 2: Add milestone patching to `update_task`**

Change `update_task` in `src/routes/tasks.rs` from:

```rust
pub async fn update_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<UpdateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let (old_status,): (String,) = sqlx::query_as("SELECT status FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(&state.pool)
        .await?;

    let mut qb = QueryBuilder::<sqlx::Sqlite>::new(
        "UPDATE tasks SET updated_at = CURRENT_TIMESTAMP",
    );
    if let Some(ref v) = payload.title {
        qb.push(", title = ").push_bind(v);
    }
    match &payload.description {
        Patch::Value(v) => { qb.push(", description = ").push_bind(v); }
        Patch::Null => { qb.push(", description = NULL"); }
        Patch::Missing => {}
    }
    if let Some(ref v) = payload.status {
        qb.push(", status = ").push_bind(v.as_str());
    }
    if let Some(ref v) = payload.priority {
        qb.push(", priority = ").push_bind(v.as_str());
    }
    match &payload.due_date {
        Patch::Value(v) => { qb.push(", due_date = ").push_bind(v); }
        Patch::Null => { qb.push(", due_date = NULL"); }
        Patch::Missing => {}
    }
    qb.push(" WHERE id = ").push_bind(task_id);
    qb.build().execute(&state.pool).await?;

    let became_done = old_status != "done"
        && matches!(payload.status, Some(crate::models::TaskStatus::Done));
    let event_tier = if became_done {
        crate::models::Tier::TaskMilestones
    } else {
        crate::models::Tier::All
    };
    crate::notifications::notify_watchers(&state.pool, project_id, event_tier, user.id).await;

    Ok(Json(get_full_task(&state.pool, task_id).await?))
}
```

to:

```rust
pub async fn update_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<UpdateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    if let Patch::Value(milestone_id) = &payload.milestone_id {
        let milestone_project_id =
            project_id_for_milestone(&state.pool, *milestone_id).await?;
        if milestone_project_id != project_id {
            return Err(AppError::BadRequest(
                "Milestone does not belong to this project".to_string(),
            ));
        }
    }

    let (old_status,): (String,) = sqlx::query_as("SELECT status FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(&state.pool)
        .await?;

    let mut qb = QueryBuilder::<sqlx::Sqlite>::new(
        "UPDATE tasks SET updated_at = CURRENT_TIMESTAMP",
    );
    if let Some(ref v) = payload.title {
        qb.push(", title = ").push_bind(v);
    }
    match &payload.description {
        Patch::Value(v) => { qb.push(", description = ").push_bind(v); }
        Patch::Null => { qb.push(", description = NULL"); }
        Patch::Missing => {}
    }
    if let Some(ref v) = payload.status {
        qb.push(", status = ").push_bind(v.as_str());
    }
    if let Some(ref v) = payload.priority {
        qb.push(", priority = ").push_bind(v.as_str());
    }
    match &payload.due_date {
        Patch::Value(v) => { qb.push(", due_date = ").push_bind(v); }
        Patch::Null => { qb.push(", due_date = NULL"); }
        Patch::Missing => {}
    }
    match &payload.milestone_id {
        Patch::Value(v) => { qb.push(", milestone_id = ").push_bind(v); }
        Patch::Null => { qb.push(", milestone_id = NULL"); }
        Patch::Missing => {}
    }
    qb.push(" WHERE id = ").push_bind(task_id);
    qb.build().execute(&state.pool).await?;

    let became_done = old_status != "done"
        && matches!(payload.status, Some(crate::models::TaskStatus::Done));
    let event_tier = if became_done {
        crate::models::Tier::TaskMilestones
    } else {
        crate::models::Tier::All
    };
    crate::notifications::notify_watchers(&state.pool, project_id, event_tier, user.id).await;

    Ok(Json(get_full_task(&state.pool, task_id).await?))
}
```

`project_id_for_milestone` needs to be in scope — it already is, via the existing `use crate::routes::helpers::{project_id_for_milestone, project_id_for_task};` at the top of this file.

- [ ] **Step 3: Rewrite `reorder_task`**

Replace the entire `reorder_task` function (from `pub async fn reorder_task(` to its closing brace, the last function in the file) with:

```rust
pub async fn reorder_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<ReorderTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let mut tx = state.pool.begin().await?;

    // The sibling set this reorder operates on, ordered by current
    // sort_order, INCLUDING the moved task's own row (its current
    // sort_order is one of the "slots" we redistribute below).
    //
    // Flat mode (scoped=false) scopes to the whole project. Scoped mode
    // (scoped=true) scopes to every task sharing this task's own current
    // milestone_id (including NULL, for the "No milestone" section) —
    // trusted because grouped-mode drags only ever happen within one
    // milestone section's own drag-and-drop zone; a task can't be dropped
    // into a different section's zone, since milestone reassignment only
    // happens through the detail modal, never through this endpoint.
    let siblings: Vec<(i64, i64)> = if payload.scoped {
        let (milestone_id,): (Option<i64>,) =
            sqlx::query_as("SELECT milestone_id FROM tasks WHERE id = ?")
                .bind(task_id)
                .fetch_one(&mut *tx)
                .await?;
        match milestone_id {
            Some(mid) => {
                sqlx::query_as(
                    "SELECT id, sort_order FROM tasks
                     WHERE project_id = ? AND milestone_id = ? ORDER BY sort_order, id",
                )
                .bind(project_id)
                .bind(mid)
                .fetch_all(&mut *tx)
                .await?
            }
            None => {
                sqlx::query_as(
                    "SELECT id, sort_order FROM tasks
                     WHERE project_id = ? AND milestone_id IS NULL ORDER BY sort_order, id",
                )
                .bind(project_id)
                .fetch_all(&mut *tx)
                .await?
            }
        }
    } else {
        sqlx::query_as(
            "SELECT id, sort_order FROM tasks WHERE project_id = ? ORDER BY sort_order, id",
        )
        .bind(project_id)
        .fetch_all(&mut *tx)
        .await?
    };

    let slots: Vec<i64> = siblings.iter().map(|(_, so)| *so).collect();
    let mut ids: Vec<i64> = siblings
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| *id != task_id)
        .collect();

    let pos = (payload.sort_order.max(0) as usize).min(ids.len());
    ids.insert(pos, task_id);

    // Reassign the SAME set of slot values to the new order — not a fresh
    // 0..N. This is what keeps every task outside this scope completely
    // undisturbed, both in stored value and in order relative to anything
    // else in the project.
    for (slot, id) in slots.iter().zip(ids.iter()) {
        sqlx::query("UPDATE tasks SET sort_order = ? WHERE id = ?")
            .bind(slot)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    // Return every task whose sort_order may have changed, not just the
    // moved one, so the frontend can update them all in local state
    // without a refetch (matches how reorder_milestone already returns
    // every milestone in the project after a move).
    let mut affected: Vec<TaskWithAssignees> = Vec::with_capacity(ids.len());
    for id in &ids {
        affected.push(get_full_task(&state.pool, *id).await?);
    }
    Ok(Json(affected))
}
```

- [ ] **Step 4: Run the backend test suite and build**

Run: `cargo test && cargo build`
Expected: both succeed. This closes out all backend work for this feature.

- [ ] **Step 5: Commit**

```bash
git add src/models.rs src/routes/tasks.rs
git commit -m "feat: milestone tagging via update, scoped/flat task reordering"
```

---

## Task 4: Frontend data layer — API client + `ProjectContext`

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/contexts/ProjectContext.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/projects/:id/tasks`, `PATCH /api/tasks/:id` (now accepts `milestone_id`), `PATCH /api/tasks/:id/reorder` (now takes `{ sort_order, scoped }`, returns `TaskWithAssignees[]`) from Tasks 2-3.
- Produces: `ProjectContextType.tasks: TaskWithAssignees[]` (flat, was `Record<number, TaskWithAssignees[]>`). `addTask(input: CreateTaskInput): Promise<void>`. `updateTask(id: number, input: UpdateTaskInput): Promise<void>`. `deleteTask(id: number): Promise<void>`. `reorderTask(id: number, sortOrder: number, scoped: boolean): Promise<void>`. `assignUser(taskId: number, userId: number): Promise<void>`. `unassignUser(taskId: number, userId: number): Promise<void>` — every one of these drops the `milestoneId` parameter it carried before. Consumed by Task 5 and Task 6.

- [ ] **Step 1: Rewrite the `tasks` section of `frontend/src/api/client.ts`**

Change the whole `// ── Tasks ──` section (from the `export type CreateTaskInput` line through the `tasks` object's closing `};`) from:

```ts
export type CreateTaskInput = {
  title: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  due_date?: string;
};
export type UpdateTaskInput = {
  title?: string;
  description?: string | null;
  status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  due_date?: string | null;
};

export const tasks = {
  list: (milestoneId: number) =>
    request<TaskWithAssignees[]>(`/api/milestones/${milestoneId}/tasks`),

  create: (milestoneId: number, input: CreateTaskInput) =>
    request<TaskWithAssignees>(`/api/milestones/${milestoneId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: number, input: UpdateTaskInput) =>
    request<TaskWithAssignees>(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: number) =>
    request<void>(`/api/tasks/${id}`, { method: 'DELETE' }),

  assign: (id: number, userId: number) =>
    request<TaskWithAssignees>(`/api/tasks/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    }),

  unassign: (id: number, userId: number) =>
    request<void>(`/api/tasks/${id}/assign/${userId}`, { method: 'DELETE' }),

  reorder: (id: number, milestoneId: number, sortOrder: number) =>
    request<TaskWithAssignees>(`/api/tasks/${id}/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ milestone_id: milestoneId, sort_order: sortOrder }),
    }),
};
```

to:

```ts
export type CreateTaskInput = {
  title: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  due_date?: string;
  milestone_id?: number;
};
export type UpdateTaskInput = {
  title?: string;
  description?: string | null;
  status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  due_date?: string | null;
  milestone_id?: number | null;
};

export const tasks = {
  list: (projectId: number) =>
    request<TaskWithAssignees[]>(`/api/projects/${projectId}/tasks`),

  create: (projectId: number, input: CreateTaskInput) =>
    request<TaskWithAssignees>(`/api/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: number, input: UpdateTaskInput) =>
    request<TaskWithAssignees>(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: number) =>
    request<void>(`/api/tasks/${id}`, { method: 'DELETE' }),

  assign: (id: number, userId: number) =>
    request<TaskWithAssignees>(`/api/tasks/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    }),

  unassign: (id: number, userId: number) =>
    request<void>(`/api/tasks/${id}/assign/${userId}`, { method: 'DELETE' }),

  reorder: (id: number, sortOrder: number, scoped: boolean) =>
    request<TaskWithAssignees[]>(`/api/tasks/${id}/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ sort_order: sortOrder, scoped }),
    }),
};
```

- [ ] **Step 2: Rewrite `ProjectContext.tsx`**

Change the `ProjectContextType` interface from:

```ts
interface ProjectContextType {
  project: ProjectDetail | null
  projectId: number
  milestones: MilestoneSummary[]
  tasks: Record<number, TaskWithAssignees[]>
  members: ProjectMember[]
  loading: boolean
  selectedTaskId: number | null
  setSelectedTaskId: (id: number | null) => void
  addMilestone: (input: CreateMilestoneInput) => Promise<void>
  updateMilestone: (id: number, input: UpdateMilestoneInput) => Promise<void>
  deleteMilestone: (id: number) => Promise<void>
  reorderMilestone: (id: number, sortOrder: number) => Promise<void>
  addTask: (milestoneId: number, input: CreateTaskInput) => Promise<void>
  updateTask: (id: number, milestoneId: number, input: UpdateTaskInput) => Promise<void>
  deleteTask: (id: number, milestoneId: number) => Promise<void>
  reorderTask: (id: number, fromMilestoneId: number, toMilestoneId: number, sortOrder: number) => Promise<void>
  assignUser: (taskId: number, milestoneId: number, userId: number) => Promise<void>
  unassignUser: (taskId: number, milestoneId: number, userId: number) => Promise<void>
  addMember: (member: ProjectMember) => Promise<void>
  removeMember: (userId: number) => Promise<void>
  updateMemberRole: (userId: number, role: string) => Promise<void>
}
```

to:

```ts
interface ProjectContextType {
  project: ProjectDetail | null
  projectId: number
  milestones: MilestoneSummary[]
  tasks: TaskWithAssignees[]
  members: ProjectMember[]
  loading: boolean
  selectedTaskId: number | null
  setSelectedTaskId: (id: number | null) => void
  addMilestone: (input: CreateMilestoneInput) => Promise<void>
  updateMilestone: (id: number, input: UpdateMilestoneInput) => Promise<void>
  deleteMilestone: (id: number) => Promise<void>
  reorderMilestone: (id: number, sortOrder: number) => Promise<void>
  addTask: (input: CreateTaskInput) => Promise<void>
  updateTask: (id: number, input: UpdateTaskInput) => Promise<void>
  deleteTask: (id: number) => Promise<void>
  reorderTask: (id: number, sortOrder: number, scoped: boolean) => Promise<void>
  assignUser: (taskId: number, userId: number) => Promise<void>
  unassignUser: (taskId: number, userId: number) => Promise<void>
  addMember: (member: ProjectMember) => Promise<void>
  removeMember: (userId: number) => Promise<void>
  updateMemberRole: (userId: number, role: string) => Promise<void>
}
```

(`(exact field order of your existing interface may differ slightly around addMember/removeMember/updateMemberRole from the member-management feature — keep those three exactly as they are today, only the task-related lines above change.)`

Change the `ProjectProvider` function body. From:

```ts
export function ProjectProvider({
  projectId,
  children,
}: {
  projectId: number
  children: React.ReactNode
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([])
  const [tasks, setTasks] = useState<Record<number, TaskWithAssignees[]>>({})
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      projectsApi.get(projectId),
      projectsApi.listMembers(projectId),
    ]).then(async ([proj, mems]) => {
      setProject(proj)
      setMembers(mems)
      setMilestones(proj.milestones)
      const taskArrays = await Promise.all(
        proj.milestones.map(m => tasksApi.list(m.id))
      )
      const taskMap: Record<number, TaskWithAssignees[]> = {}
      proj.milestones.forEach((m, i) => { taskMap[m.id] = taskArrays[i] })
      setTasks(taskMap)
    }).finally(() => setLoading(false))
  }, [projectId])

  async function addMilestone(input: CreateMilestoneInput) {
    const m = await milestonesApi.create(projectId, input)
    setMilestones(prev => [...prev, m])
    setTasks(prev => ({ ...prev, [m.id]: [] }))
  }

  async function updateMilestone(id: number, input: UpdateMilestoneInput) {
    const updated = await milestonesApi.update(id, input)
    setMilestones(prev => prev.map(m => m.id === id ? updated : m))
  }

  async function deleteMilestone(id: number) {
    await milestonesApi.delete(id)
    setMilestones(prev => prev.filter(m => m.id !== id))
    setTasks(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  async function reorderMilestone(id: number, sortOrder: number) {
    const updated = await milestonesApi.reorder(id, sortOrder)
    setMilestones(updated.slice().sort((a, b) => a.sort_order - b.sort_order))
  }

  async function addTask(milestoneId: number, input: CreateTaskInput) {
    const t = await tasksApi.create(milestoneId, input)
    setTasks(prev => ({ ...prev, [milestoneId]: [...(prev[milestoneId] ?? []), t] }))
  }

  async function updateTask(id: number, milestoneId: number, input: UpdateTaskInput) {
    const updated = await tasksApi.update(id, input)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).map(t => t.id === id ? updated : t),
    }))
  }

  async function deleteTask(id: number, milestoneId: number) {
    await tasksApi.delete(id)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).filter(t => t.id !== id),
    }))
  }

  async function reorderTask(
    id: number,
    fromMilestoneId: number,
    toMilestoneId: number,
    sortOrder: number,
  ) {
    const updated = await tasksApi.reorder(id, toMilestoneId, sortOrder)
    if (fromMilestoneId === toMilestoneId) {
      setTasks(prev => ({
        ...prev,
        [fromMilestoneId]: (prev[fromMilestoneId] ?? [])
          .map(t => t.id === id ? updated : t)
          .sort((a, b) => a.sort_order - b.sort_order),
      }))
    } else {
      setTasks(prev => ({
        ...prev,
        [fromMilestoneId]: (prev[fromMilestoneId] ?? []).filter(t => t.id !== id),
        [toMilestoneId]: [...(prev[toMilestoneId] ?? []), updated]
          .sort((a, b) => a.sort_order - b.sort_order),
      }))
    }
  }

  async function assignUser(taskId: number, milestoneId: number, userId: number) {
    const updated = await tasksApi.assign(taskId, userId)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).map(t => t.id === taskId ? updated : t),
    }))
  }

  async function unassignUser(taskId: number, milestoneId: number, userId: number) {
    await tasksApi.unassign(taskId, userId)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).map(t =>
        t.id === taskId
          ? { ...t, assignees: t.assignees.filter(a => a.user_id !== userId) }
          : t
      ),
    }))
  }
```

to:

```ts
export function ProjectProvider({
  projectId,
  children,
}: {
  projectId: number
  children: React.ReactNode
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([])
  const [tasks, setTasks] = useState<TaskWithAssignees[]>([])
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      projectsApi.get(projectId),
      projectsApi.listMembers(projectId),
      tasksApi.list(projectId),
    ]).then(([proj, mems, taskList]) => {
      setProject(proj)
      setMembers(mems)
      setMilestones(proj.milestones)
      setTasks(taskList)
    }).finally(() => setLoading(false))
  }, [projectId])

  async function addMilestone(input: CreateMilestoneInput) {
    const m = await milestonesApi.create(projectId, input)
    setMilestones(prev => [...prev, m])
  }

  async function updateMilestone(id: number, input: UpdateMilestoneInput) {
    const updated = await milestonesApi.update(id, input)
    setMilestones(prev => prev.map(m => m.id === id ? updated : m))
  }

  async function deleteMilestone(id: number) {
    await milestonesApi.delete(id)
    setMilestones(prev => prev.filter(m => m.id !== id))
    // The backend untags rather than deletes this milestone's tasks
    // (ON DELETE SET NULL) — mirror that locally instead of removing them.
    setTasks(prev => prev.map(t => t.milestone_id === id ? { ...t, milestone_id: null } : t))
  }

  async function reorderMilestone(id: number, sortOrder: number) {
    const updated = await milestonesApi.reorder(id, sortOrder)
    setMilestones(updated.slice().sort((a, b) => a.sort_order - b.sort_order))
  }

  async function addTask(input: CreateTaskInput) {
    const t = await tasksApi.create(projectId, input)
    setTasks(prev => [...prev, t])
  }

  async function updateTask(id: number, input: UpdateTaskInput) {
    const updated = await tasksApi.update(id, input)
    setTasks(prev => prev.map(t => t.id === id ? updated : t))
  }

  async function deleteTask(id: number) {
    await tasksApi.delete(id)
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  async function reorderTask(id: number, sortOrder: number, scoped: boolean) {
    const affected = await tasksApi.reorder(id, sortOrder, scoped)
    const affectedIds = new Set(affected.map(t => t.id))
    setTasks(prev => [
      ...prev.filter(t => !affectedIds.has(t.id)),
      ...affected,
    ].sort((a, b) => a.sort_order - b.sort_order))
  }

  async function assignUser(taskId: number, userId: number) {
    const updated = await tasksApi.assign(taskId, userId)
    setTasks(prev => prev.map(t => t.id === taskId ? updated : t))
  }

  async function unassignUser(taskId: number, userId: number) {
    await tasksApi.unassign(taskId, userId)
    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, assignees: t.assignees.filter(a => a.user_id !== userId) }
        : t
    ))
  }
```

Leave `addMember`/`removeMember`/`updateMemberRole` and the final `return (<ProjectContext.Provider value={{...}}>...)` block exactly as they are today — none of those names or the context value object change.

- [ ] **Step 3: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: fails — `ListView.tsx`, `KanbanBoard.tsx`, and `TaskDetailModal.tsx` all still call the old multi-argument signatures and read `tasks` as a `Record`. This is expected; Tasks 5-6 fix them. Confirm the errors are all in those three files and `client.ts`/`ProjectContext.tsx` themselves compile clean of errors (skim the `tsc` output for errors specifically inside `client.ts`/`ProjectContext.tsx` — there should be none).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/contexts/ProjectContext.tsx
git commit -m "feat: flatten task state, drop milestoneId threading from task actions"
```

---

## Task 5: Frontend — Kanban and task detail modal

**Files:**
- Modify: `frontend/src/components/KanbanBoard.tsx`
- Modify: `frontend/src/components/KanbanBoard.test.tsx`
- Modify: `frontend/src/components/TaskDetailModal.tsx`
- Modify: `frontend/src/components/TaskDetailModal.test.tsx`

**Interfaces:**
- Consumes: flat `tasks: TaskWithAssignees[]` and the simplified action signatures from Task 4.

- [ ] **Step 1: Update `KanbanBoard.tsx`**

Change:

```tsx
export default function KanbanBoard() {
  const { milestones, tasks, setSelectedTaskId, updateTask } = useProject()
  const sensors = useSensors(useSensor(PointerSensor))

  const allTasks: TaskWithAssignees[] = Object.values(tasks)
    .flat()
    .filter(t => t.status !== 'cancelled')

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const taskId = Number(active.id)
    const newStatus = String(over.id)
    const task = allTasks.find(t => t.id === taskId)
    if (!task || task.status === newStatus) return
    await updateTask(taskId, task.milestone_id, {
      status: newStatus as Parameters<typeof updateTask>[2]['status'],
    })
  }

  function milestoneFor(task: TaskWithAssignees) {
    return milestones.find(m => m.id === task.milestone_id)
  }
```

to:

```tsx
export default function KanbanBoard() {
  const { milestones, tasks, setSelectedTaskId, updateTask } = useProject()
  const sensors = useSensors(useSensor(PointerSensor))

  const allTasks: TaskWithAssignees[] = tasks.filter(t => t.status !== 'cancelled')

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const taskId = Number(active.id)
    const newStatus = String(over.id)
    const task = allTasks.find(t => t.id === taskId)
    if (!task || task.status === newStatus) return
    await updateTask(taskId, {
      status: newStatus as Parameters<typeof updateTask>[1]['status'],
    })
  }

  function milestoneFor(task: TaskWithAssignees) {
    return task.milestone_id != null ? milestones.find(m => m.id === task.milestone_id) : undefined
  }
```

Everything else in this file (the `DndContext`/`COLUMNS.map`/`KanbanColumn` rendering below) is unchanged.

- [ ] **Step 2: Update `KanbanBoard.test.tsx`**

Replace the whole file:

```tsx
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import KanbanBoard from './KanbanBoard'
import { ProjectContext } from '../contexts/ProjectContext'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

function makeCtx(tasks: TaskWithAssignees[]) {
  const milestone: MilestoneSummary = {
    id: 10, name: 'M1', description: null, status: 'open',
    target_date: null, due_date: null, sort_order: 0, task_count: tasks.length,
  }
  return {
    project: null, members: [], loading: false,
    selectedTaskId: null, setSelectedTaskId: vi.fn(),
    milestones: [milestone],
    tasks,
    addMilestone: vi.fn(), updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(), reorderMilestone: vi.fn(),
    addTask: vi.fn(), updateTask: vi.fn(),
    deleteTask: vi.fn(), reorderTask: vi.fn(),
    assignUser: vi.fn(), unassignUser: vi.fn(),
    addMember: vi.fn(), removeMember: vi.fn(), updateMemberRole: vi.fn(),
  }
}

function makeTask(id: number, title: string, status: string): TaskWithAssignees {
  return {
    id, project_id: 1, milestone_id: 10, title, description: null,
    status, priority: 'normal', due_date: null,
    sort_order: id, created_by: 1, created_at: null, updated_at: null, assignees: [],
  }
}

test('renders four column headings', () => {
  render(
    <ProjectContext.Provider value={makeCtx([])}>
      <KanbanBoard />
    </ProjectContext.Provider>
  )
  expect(screen.getByText('Todo')).toBeInTheDocument()
  expect(screen.getByText('In Progress')).toBeInTheDocument()
  expect(screen.getByText('Blocked')).toBeInTheDocument()
  expect(screen.getByText('Done')).toBeInTheDocument()
})

test('places tasks in their correct columns', () => {
  const tasks = [
    makeTask(1, 'Task A', 'todo'),
    makeTask(2, 'Task B', 'in_progress'),
    makeTask(3, 'Task C', 'blocked'),
    makeTask(4, 'Task D', 'done'),
  ]
  render(
    <ProjectContext.Provider value={makeCtx(tasks)}>
      <KanbanBoard />
    </ProjectContext.Provider>
  )
  expect(screen.getByText('Task A')).toBeInTheDocument()
  expect(screen.getByText('Task B')).toBeInTheDocument()
  expect(screen.getByText('Task C')).toBeInTheDocument()
  expect(screen.getByText('Task D')).toBeInTheDocument()
})

test('omits cancelled tasks', () => {
  render(
    <ProjectContext.Provider value={makeCtx([makeTask(1, 'Cancelled Task', 'cancelled')])}>
      <KanbanBoard />
    </ProjectContext.Provider>
  )
  expect(screen.queryByText('Cancelled Task')).not.toBeInTheDocument()
})

test('renders a task with no milestone without crashing', () => {
  const task: TaskWithAssignees = { ...makeTask(5, 'Unsorted task', 'todo'), milestone_id: null }
  render(
    <ProjectContext.Provider value={makeCtx([task])}>
      <KanbanBoard />
    </ProjectContext.Provider>
  )
  expect(screen.getByText('Unsorted task')).toBeInTheDocument()
})
```

- [ ] **Step 3: Update `TaskDetailModal.tsx`**

Change the top of the component from:

```tsx
export function TaskDetailModal() {
  const {
    selectedTaskId, setSelectedTaskId,
    milestones, tasks, members,
    updateTask, deleteTask, reorderTask, assignUser, unassignUser,
  } = useProject()

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const task = selectedTaskId != null
    ? Object.values(tasks).flat().find(t => t.id === selectedTaskId) ?? null
    : null
```

to:

```tsx
export function TaskDetailModal() {
  const {
    selectedTaskId, setSelectedTaskId,
    milestones, tasks, members,
    updateTask, deleteTask, assignUser, unassignUser,
  } = useProject()

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const task = selectedTaskId != null
    ? tasks.find(t => t.id === selectedTaskId) ?? null
    : null
```

(`reorderTask` is dropped from the destructure — it's no longer used anywhere in this file once milestone reassignment moves to `updateTask`, and this project's `tsconfig.app.json` has `noUnusedLocals: true`, so leaving it in would fail the build.)

Change:

```tsx
  if (!task) return null

  const milestoneId = task.milestone_id

  async function handleDelete() {
    await deleteTask(task!.id, milestoneId)
    setSelectedTaskId(null)
  }
```

to:

```tsx
  if (!task) return null

  async function handleDelete() {
    await deleteTask(task!.id)
    setSelectedTaskId(null)
  }
```

Change every `updateTask(task.id, milestoneId, { ... })` call to `updateTask(task.id, { ... })` — there are four: the title `onBlur`, the description `onBlur`, the status `onChange`, and the priority `onChange`. For example, the title field changes from:

```tsx
            onBlur={e => {
              if (e.target.value.trim() && e.target.value.trim() !== task.title) {
                updateTask(task.id, milestoneId, { title: e.target.value.trim() })
              }
            }}
```

to:

```tsx
            onBlur={e => {
              if (e.target.value.trim() && e.target.value.trim() !== task.title) {
                updateTask(task.id, { title: e.target.value.trim() })
              }
            }}
```

Apply the same `task.id, milestoneId,` → `task.id,` change to the description `onBlur`, and change `Parameters<typeof updateTask>[2]['status']` / `[2]['priority']` to `Parameters<typeof updateTask>[1]['status']` / `[1]['priority']` in the status and priority `onChange` handlers (the parameter index shifts from 2 to 1 now that `milestoneId` is gone). Same pattern for the due-date `onChange`.

Change the Milestone field from:

```tsx
          {/* Milestone */}
          <label className="block">
            <span className="text-xs text-muted block mb-1">Milestone</span>
            <select
              aria-label="Milestone"
              value={task.milestone_id}
              onChange={e => {
                const toId = Number(e.target.value)
                if (toId !== task.milestone_id) {
                  reorderTask(task.id, task.milestone_id, toId, 0)
                }
              }}
              className="w-full bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
            >
              {milestones.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
```

to:

```tsx
          {/* Milestone */}
          <label className="block">
            <span className="text-xs text-muted block mb-1">Milestone</span>
            <select
              aria-label="Milestone"
              value={task.milestone_id ?? ''}
              onChange={e => {
                const raw = e.target.value
                updateTask(task.id, { milestone_id: raw === '' ? null : Number(raw) })
              }}
              className="w-full bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
            >
              <option value="">No milestone</option>
              {milestones.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
```

Change the two assignment calls (`unassignUser(task.id, milestoneId, a.user_id)` and `assignUser(task.id, milestoneId, Number(e.target.value))`) to drop `milestoneId`:

```tsx
                  <button
                    onClick={() => unassignUser(task.id, a.user_id)}
```

and:

```tsx
                onChange={e => {
                  if (e.target.value) assignUser(task.id, Number(e.target.value))
                }}
```

- [ ] **Step 4: Update `TaskDetailModal.test.tsx`**

Replace the whole file:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { TaskDetailModal } from './TaskDetailModal'
import { ProjectContext } from '../contexts/ProjectContext'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

const milestone: MilestoneSummary = {
  id: 10, name: 'M1', description: null, status: 'open',
  target_date: null, due_date: null, sort_order: 0, task_count: 1,
}
const task: TaskWithAssignees = {
  id: 100, project_id: 1, milestone_id: 10, title: 'Build login', description: 'Some details',
  status: 'todo', priority: 'normal', due_date: null,
  sort_order: 0, created_by: 1, created_at: null, updated_at: null, assignees: [],
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    project: null, members: [], loading: false,
    milestones: [milestone], tasks: [task],
    selectedTaskId: 100, setSelectedTaskId: vi.fn(),
    addMilestone: vi.fn(), updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(), reorderMilestone: vi.fn(),
    addTask: vi.fn(), updateTask: vi.fn(),
    deleteTask: vi.fn(), reorderTask: vi.fn(),
    assignUser: vi.fn(), unassignUser: vi.fn(),
    addMember: vi.fn(), removeMember: vi.fn(), updateMemberRole: vi.fn(),
    ...overrides,
  }
}

test('renders task title and description', () => {
  render(
    <ProjectContext.Provider value={makeCtx()}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  expect(screen.getByDisplayValue('Build login')).toBeInTheDocument()
  expect(screen.getByDisplayValue('Some details')).toBeInTheDocument()
})

test('changing status select calls updateTask', async () => {
  const user = userEvent.setup()
  const updateTask = vi.fn().mockResolvedValue(undefined)
  render(
    <ProjectContext.Provider value={makeCtx({ updateTask })}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  await user.selectOptions(screen.getByLabelText(/status/i), 'blocked')
  expect(updateTask).toHaveBeenCalledWith(100, { status: 'blocked' })
})

test('changing milestone select to "No milestone" clears it', async () => {
  const user = userEvent.setup()
  const updateTask = vi.fn().mockResolvedValue(undefined)
  render(
    <ProjectContext.Provider value={makeCtx({ updateTask })}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  await user.selectOptions(screen.getByLabelText(/milestone/i), '')
  expect(updateTask).toHaveBeenCalledWith(100, { milestone_id: null })
})

test('pressing Escape closes the modal', async () => {
  const user = userEvent.setup()
  const setSelectedTaskId = vi.fn()
  render(
    <ProjectContext.Provider value={makeCtx({ setSelectedTaskId })}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  await user.keyboard('{Escape}')
  expect(setSelectedTaskId).toHaveBeenCalledWith(null)
})

test('delete button calls deleteTask and closes modal', async () => {
  const user = userEvent.setup()
  const deleteTask = vi.fn().mockResolvedValue(undefined)
  const setSelectedTaskId = vi.fn()
  render(
    <ProjectContext.Provider value={makeCtx({ deleteTask, setSelectedTaskId })}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  await user.click(screen.getByRole('button', { name: /delete task/i }))
  await user.click(screen.getByRole('button', { name: /^delete$/i }))
  await waitFor(() => expect(deleteTask).toHaveBeenCalledWith(100))
  expect(setSelectedTaskId).toHaveBeenCalledWith(null)
})
```

(Added one new test — `'changing milestone select to "No milestone" clears it'` — covering the field this task actually adds; the rest are the existing tests updated for the new call signatures.)

- [ ] **Step 5: Run the frontend build and these two test files**

Run: `cd frontend && npx vitest run src/components/KanbanBoard.test.tsx src/components/TaskDetailModal.test.tsx`
Expected: all pass.

Run: `cd frontend && npm run build`
Expected: still fails — only on `ListView.tsx` now (Task 6 fixes it). Confirm no errors remain in `KanbanBoard.tsx` or `TaskDetailModal.tsx`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/KanbanBoard.tsx frontend/src/components/KanbanBoard.test.tsx frontend/src/components/TaskDetailModal.tsx frontend/src/components/TaskDetailModal.test.tsx
git commit -m "feat: adapt Kanban and task detail modal to flat project-scoped tasks"
```

---

## Task 6: Frontend — List view grouping toggle and flat mode

**Files:**
- Modify: `frontend/src/components/ListView.tsx`
- Modify: `frontend/src/components/ListView.test.tsx`

**Interfaces:**
- Consumes: flat `tasks: TaskWithAssignees[]` and simplified action signatures from Task 4. This is the last task — after it, `npm run build` succeeds cleanly project-wide.

- [ ] **Step 1: Replace `ListView.tsx` in full**

```tsx
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { format, parseISO, isBefore, startOfToday } from 'date-fns'
import { useProject } from '../contexts/ProjectContext'
import { InlineEdit } from './InlineEdit'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-priority-low',
  normal: 'bg-priority-normal',
  high: 'bg-priority-high',
  urgent: 'bg-priority-urgent',
}

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low priority',
  normal: 'Normal priority',
  high: 'High priority',
  urgent: 'Urgent priority',
}

type GroupBy = 'milestone' | 'none'

export default function ListView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const groupBy = (searchParams.get('group') ?? 'milestone') as GroupBy
  const { milestones, tasks, addMilestone, updateMilestone, reorderMilestone } = useProject()
  const sensors = useSensors(useSensor(PointerSensor))
  const sortedMilestones = [...milestones].sort((a, b) => a.sort_order - b.sort_order)

  async function handleMilestoneDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const overMs = milestones.find(m => m.id === Number(over.id))
    if (overMs) await reorderMilestone(Number(active.id), overMs.sort_order)
  }

  function setGroupBy(g: GroupBy) {
    const next = new URLSearchParams(searchParams)
    next.set('group', g)
    setSearchParams(next)
  }

  return (
    <div className="space-y-6">
      <div role="tablist" className="flex gap-1">
        <button
          role="tab"
          aria-selected={groupBy === 'milestone'}
          onClick={() => setGroupBy('milestone')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            groupBy === 'milestone' ? 'bg-accent-subtle text-accent' : 'text-muted hover:text-text'
          }`}
        >
          Grouped by milestone
        </button>
        <button
          role="tab"
          aria-selected={groupBy === 'none'}
          onClick={() => setGroupBy('none')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            groupBy === 'none' ? 'bg-accent-subtle text-accent' : 'text-muted hover:text-text'
          }`}
        >
          Flat
        </button>
      </div>

      {groupBy === 'milestone' ? (
        <>
          <DndContext sensors={sensors} onDragEnd={handleMilestoneDragEnd}>
            <SortableContext
              items={sortedMilestones.map(m => m.id)}
              strategy={verticalListSortingStrategy}
            >
              {sortedMilestones.map(m => (
                <MilestoneSection
                  key={m.id}
                  milestone={m}
                  tasks={tasks.filter(t => t.milestone_id === m.id)}
                  onRename={name => updateMilestone(m.id, { name })}
                />
              ))}
            </SortableContext>
          </DndContext>

          {sortedMilestones.length === 0 && (
            <p className="text-muted text-center py-16">
              No milestones yet. Add your first milestone below.
            </p>
          )}

          <AddMilestoneButton onAdd={name => addMilestone({ name })} />

          <NoMilestoneSection tasks={tasks.filter(t => t.milestone_id == null)} />
        </>
      ) : (
        <FlatTaskList tasks={tasks} />
      )}
    </div>
  )
}

function MilestoneSection({
  milestone,
  tasks,
  onRename,
}: {
  milestone: MilestoneSummary
  tasks: TaskWithAssignees[]
  onRename: (name: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: milestone.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const today = startOfToday()
  const overdueMs =
    milestone.target_date != null &&
    isBefore(parseISO(milestone.target_date), today) &&
    milestone.status !== 'done'

  return (
    <div ref={setNodeRef} style={style} className="bg-surface border border-border shadow-sm rounded-xl">
      <div className="flex items-center gap-2 px-4 py-3">
        <span
          {...attributes}
          {...listeners}
          className="cursor-grab text-border-strong hover:text-muted select-none"
        >
          ⠿
        </span>
        <button
          onClick={() => setCollapsed(c => !c)}
          className="text-muted hover:text-text"
        >
          {collapsed ? '▶' : '▼'}
        </button>
        <h3 className="font-semibold text-text flex-1">
          <InlineEdit
            value={milestone.name}
            onSave={onRename}
            className="bg-transparent text-text font-semibold text-base"
          />
        </h3>
        {milestone.target_date != null && (
          <span className={`text-xs ${overdueMs ? 'text-danger' : 'text-muted'}`}>
            {format(parseISO(milestone.target_date), 'MMM d, yyyy')}
          </span>
        )}
        <span className="text-xs text-muted">{tasks.length} tasks</span>
      </div>

      {!collapsed && (
        <>
          <TaskList tasks={tasks} scoped />
          <AddTaskRow milestoneId={milestone.id} />
        </>
      )}
    </div>
  )
}

function NoMilestoneSection({ tasks }: { tasks: TaskWithAssignees[] }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="bg-surface border border-border shadow-sm rounded-xl">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          onClick={() => setCollapsed(c => !c)}
          className="text-muted hover:text-text"
        >
          {collapsed ? '▶' : '▼'}
        </button>
        <h3 className="font-semibold text-text flex-1">No milestone</h3>
        <span className="text-xs text-muted">{tasks.length} tasks</span>
      </div>

      {!collapsed && (
        <>
          <TaskList tasks={tasks} scoped />
          <AddTaskRow milestoneId={null} />
        </>
      )}
    </div>
  )
}

function FlatTaskList({ tasks }: { tasks: TaskWithAssignees[] }) {
  return (
    <div className="bg-surface border border-border shadow-sm rounded-xl">
      <TaskList tasks={tasks} scoped={false} showMilestoneChip />
      <AddTaskRow milestoneId={null} />
    </div>
  )
}

function TaskList({
  tasks,
  scoped,
  showMilestoneChip = false,
}: {
  tasks: TaskWithAssignees[]
  scoped: boolean
  showMilestoneChip?: boolean
}) {
  const { setSelectedTaskId, updateTask, reorderTask, milestones } = useProject()
  const sensors = useSensors(useSensor(PointerSensor))
  const sorted = [...tasks].sort((a, b) => a.sort_order - b.sort_order)
  const today = startOfToday()

  async function handleTaskDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const overIndex = sorted.findIndex(t => t.id === Number(over.id))
    if (overIndex === -1) return
    await reorderTask(Number(active.id), overIndex, scoped)
  }

  function milestoneFor(task: TaskWithAssignees) {
    return task.milestone_id != null ? milestones.find(m => m.id === task.milestone_id) : undefined
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleTaskDragEnd}>
      <SortableContext items={sorted.map(t => t.id)} strategy={verticalListSortingStrategy}>
        {sorted.map(task => {
          const overdue =
            task.due_date != null &&
            isBefore(parseISO(task.due_date), today) &&
            task.status !== 'done' &&
            task.status !== 'cancelled'
          return (
            <SortableTaskRow
              key={task.id}
              task={task}
              overdue={overdue}
              milestone={showMilestoneChip ? milestoneFor(task) : undefined}
              onClickTitle={() => setSelectedTaskId(task.id)}
              onToggleDone={() =>
                updateTask(task.id, {
                  status: task.status === 'done' ? 'todo' : 'done',
                })
              }
            />
          )
        })}
      </SortableContext>
    </DndContext>
  )
}

function SortableTaskRow({
  task,
  overdue,
  milestone,
  onClickTitle,
  onToggleDone,
}: {
  task: TaskWithAssignees
  overdue: boolean
  milestone?: MilestoneSummary
  onClickTitle: () => void
  onToggleDone: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: task.id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  function initials(name: string) {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised group"
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-border hover:text-muted opacity-0 group-hover:opacity-100"
      >
        ⠿
      </span>
      <input
        type="checkbox"
        checked={task.status === 'done'}
        onChange={onToggleDone}
        className="accent-accent"
      />
      <button
        onClick={onClickTitle}
        className="flex-1 text-left text-sm font-medium text-text hover:text-accent-muted"
      >
        {task.title}
      </button>
      {milestone && (
        <span className="text-xs bg-accent-subtle text-accent-muted px-1.5 py-0.5 rounded">
          {milestone.name}
        </span>
      )}
      <span
        title={PRIORITY_LABEL[task.priority] ?? 'Unknown priority'}
        className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] ?? 'bg-priority-low'}`}
      />
      {task.due_date != null && (
        <span className={`text-xs ${overdue ? 'text-danger' : 'text-muted'}`}>
          {format(parseISO(task.due_date), 'MMM d')}
        </span>
      )}
      <div className="flex -space-x-1">
        {task.assignees.slice(0, 3).map(a => (
          <div
            key={a.user_id}
            title={a.username}
            className="w-6 h-6 rounded-full bg-border-strong text-xs flex items-center justify-center text-text border border-surface"
          >
            {initials(a.username)}
          </div>
        ))}
        {task.assignees.length > 3 && (
          <div className="w-6 h-6 rounded-full bg-border-strong text-xs flex items-center justify-center text-text border border-surface">
            +{task.assignees.length - 3}
          </div>
        )}
      </div>
    </div>
  )
}

function AddTaskRow({ milestoneId }: { milestoneId: number | null }) {
  const [value, setValue] = useState('')
  const { addTask } = useProject()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    await addTask(milestoneId != null ? { title: trimmed, milestone_id: milestoneId } : { title: trimmed })
    setValue('')
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 py-2">
      <input
        type="text"
        placeholder="Add a task…"
        value={value}
        onChange={e => setValue(e.target.value)}
        className="w-full bg-transparent text-sm text-muted placeholder:text-border-strong focus:outline-none"
      />
    </form>
  )
}

function AddMilestoneButton({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    await onAdd(trimmed)
    setName('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-muted hover:text-accent-muted text-sm"
      >
        + Add milestone
      </button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        autoFocus
        type="text"
        placeholder="Milestone name"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
        className="bg-surface text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
      />
      <button type="submit" className="bg-accent text-surface text-sm rounded-lg px-4 py-2">
        Add
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-muted text-sm px-2">
        Cancel
      </button>
    </form>
  )
}
```

- [ ] **Step 2: Replace `ListView.test.tsx` in full**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import ListView from './ListView'
import { ProjectContext } from '../contexts/ProjectContext'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

function makeCtx(
  milestones: MilestoneSummary[] = [],
  tasks: TaskWithAssignees[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    project: null, members: [], loading: false,
    selectedTaskId: null, setSelectedTaskId: vi.fn(),
    milestones, tasks,
    addMilestone: vi.fn(), updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(), reorderMilestone: vi.fn(),
    addTask: vi.fn(), updateTask: vi.fn(),
    deleteTask: vi.fn(), reorderTask: vi.fn(),
    assignUser: vi.fn(), unassignUser: vi.fn(),
    addMember: vi.fn(), removeMember: vi.fn(), updateMemberRole: vi.fn(),
    ...overrides,
  }
}

const m1: MilestoneSummary = {
  id: 10, name: 'Sprint 1', description: null, status: 'open',
  target_date: null, due_date: null, sort_order: 0, task_count: 1,
}
const m2: MilestoneSummary = {
  id: 20, name: 'Sprint 2', description: null, status: 'open',
  target_date: null, due_date: null, sort_order: 1, task_count: 0,
}
const t1: TaskWithAssignees = {
  id: 100, project_id: 1, milestone_id: 10, title: 'Build login',
  description: null, status: 'todo', priority: 'normal',
  due_date: null, sort_order: 0, created_by: 1,
  created_at: null, updated_at: null, assignees: [],
}
const t2: TaskWithAssignees = {
  id: 101, project_id: 1, milestone_id: null, title: 'Unsorted task',
  description: null, status: 'todo', priority: 'normal',
  due_date: null, sort_order: 1, created_by: 1,
  created_at: null, updated_at: null, assignees: [],
}

function renderList(ctx: ReturnType<typeof makeCtx>, search = '') {
  return render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <ProjectContext.Provider value={ctx}>
        <ListView />
      </ProjectContext.Provider>
    </MemoryRouter>
  )
}

test('renders milestones in sort_order (ascending)', () => {
  renderList(makeCtx([m2, m1], [t1]))
  const headings = screen.getAllByRole('heading', { level: 3 })
  expect(headings[0]).toHaveTextContent('Sprint 1')
  expect(headings[1]).toHaveTextContent('Sprint 2')
})

test('renders tasks within their milestone', () => {
  renderList(makeCtx([m1], [t1]))
  expect(screen.getByText('Build login')).toBeInTheDocument()
})

test('clicking a task title calls setSelectedTaskId', async () => {
  const user = userEvent.setup()
  const setSelectedTaskId = vi.fn()
  renderList(makeCtx([m1], [t1], { setSelectedTaskId }))
  await user.click(screen.getByText('Build login'))
  expect(setSelectedTaskId).toHaveBeenCalledWith(100)
})

test('submitting a milestone section add-task form calls addTask with that milestone', async () => {
  const user = userEvent.setup()
  const addTask = vi.fn().mockResolvedValue(undefined)
  renderList(makeCtx([m1], [], { addTask }))
  const inputs = screen.getAllByPlaceholderText(/add a task/i)
  await user.type(inputs[0], 'New task{Enter}')
  expect(addTask).toHaveBeenCalledWith({ title: 'New task', milestone_id: 10 })
})

test('shows empty state when no milestones', () => {
  renderList(makeCtx([], []))
  expect(screen.getByText(/no milestones yet/i)).toBeInTheDocument()
})

test('grouped mode always shows a No milestone section, even when empty', () => {
  renderList(makeCtx([m1], [t1]))
  expect(screen.getByText('No milestone')).toBeInTheDocument()
})

test('grouped mode places an unmilestoned task in the No milestone section', () => {
  renderList(makeCtx([m1], [t1, t2]))
  expect(screen.getByText('Unsorted task')).toBeInTheDocument()
})

test('adding a task from the No milestone section creates it with no milestone', async () => {
  const user = userEvent.setup()
  const addTask = vi.fn().mockResolvedValue(undefined)
  renderList(makeCtx([m1], [], { addTask }))
  const inputs = screen.getAllByPlaceholderText(/add a task/i)
  // Last add-task input on the page belongs to the No milestone section
  // (it's always rendered last, per the grouped-mode layout).
  await user.type(inputs[inputs.length - 1], 'Loose task{Enter}')
  expect(addTask).toHaveBeenCalledWith({ title: 'Loose task' })
})

test('switching to flat mode shows every task with a milestone chip', async () => {
  const user = userEvent.setup()
  renderList(makeCtx([m1], [t1, t2]))
  await user.click(screen.getByRole('tab', { name: /^flat$/i }))
  expect(screen.getByText('Build login')).toBeInTheDocument()
  expect(screen.getByText('Unsorted task')).toBeInTheDocument()
  expect(screen.getByText('Sprint 1')).toBeInTheDocument() // the chip
})

test('flat mode has no milestone sections, only the tab switcher and one list', async () => {
  const user = userEvent.setup()
  renderList(makeCtx([m1], [t1]))
  await user.click(screen.getByRole('tab', { name: /^flat$/i }))
  expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
})

test('adding a task in flat mode creates it with no milestone', async () => {
  const user = userEvent.setup()
  const addTask = vi.fn().mockResolvedValue(undefined)
  renderList(makeCtx([m1], [], { addTask }))
  await user.click(screen.getByRole('tab', { name: /^flat$/i }))
  await user.type(screen.getByPlaceholderText(/add a task/i), 'Flat task{Enter}')
  expect(addTask).toHaveBeenCalledWith({ title: 'Flat task' })
})
```

(`ListView` now reads the grouping mode from a URL search param via `useSearchParams`, so its tests need a `MemoryRouter` wrapper — added via the new `renderList` helper. `MilestoneSection`'s add-task row calls `addTask({ title, milestone_id: 10 })`, matching the new `CreateTaskInput` shape from Task 4, not the old `addTask(10, { title })` two-argument form.)

- [ ] **Step 3: Run the full frontend suite and build**

Run: `cd frontend && npm test`
Expected: every test file passes, including the rewritten `ListView.test.tsx`, `KanbanBoard.test.tsx`, and `TaskDetailModal.test.tsx` from this and the prior task.

Run: `cd frontend && npm run build`
Expected: succeeds cleanly — this is the first point since Task 4 where the build is fully green again.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ListView.tsx frontend/src/components/ListView.test.tsx
git commit -m "feat: add List view grouping toggle with flat, project-wide-ordered mode"
```

This closes out the feature — tasks can exist with no milestone, moving one between milestones is a plain field edit in the detail modal, and List view offers both the existing milestone-grouped display and a new flat one with milestone shown as a chip.
