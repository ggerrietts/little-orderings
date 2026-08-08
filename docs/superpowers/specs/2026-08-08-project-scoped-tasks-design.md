# Project-Scoped Tasks with Optional Milestone Tag — Design

**Date:** 2026-08-08
**Scope:** Restructure the task/milestone relationship: tasks belong to a project directly (required), and are optionally tagged with a milestone (no longer required). Update List view to support both the current milestone-grouped display and a new flat, project-wide ordering with milestone shown as a chip. Kanban is largely unaffected — it already treats milestone as a display badge, not a grouping key.
**Stack assumption:** Rust/Axum/SQLite backend, React 19/Vite CSR frontend (Little Orderings). Builds on the existing project/milestone/task CRUD and drag-and-drop reordering already in place.

---

## 1. Goals

- A task can exist with no milestone.
- Moving a task between milestones (or to/from no milestone) is a simple field edit, not entangled with position/reordering.
- List view gets a flat, ungrouped mode (project-wide task order, milestone shown as a chip) in addition to the existing grouped-by-milestone mode.
- Deleting a milestone no longer deletes its tasks — it just removes the tag.

## Non-goals

- Kanban's structure doesn't change — it already flattens all tasks and groups by status only, with milestone as a badge. This spec doesn't touch its grouping logic, only the shape of the data it reads.
- The milestone chip is a read-only label in list/kanban rows. Changing a task's milestone stays confined to the task detail modal's existing dropdown (extended to allow "no milestone").
- No new task-creation entry points beyond: the existing per-milestone "+ Add task" row (creates with that milestone), plus one new project-level "+ Add task" control (creates with no milestone).

---

## 2. Data model & migration

```sql
CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,  -- now nullable
    title        TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'todo',
    priority     TEXT NOT NULL DEFAULT 'normal',
    due_date     DATE,
    sort_order   INTEGER NOT NULL DEFAULT 0,   -- now project-wide, not per-milestone
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Two changes from today's schema:
- **`project_id`** (new, required) — the task's direct parent. Backfilled deterministically from each task's current `milestone_id` (`UPDATE tasks SET project_id = (SELECT project_id FROM milestones WHERE id = tasks.milestone_id)`), safe because every existing task already has a non-null `milestone_id` today — zero data loss. SQLite can't `ALTER COLUMN`, so this lands via the standard table-rebuild pattern: add the column, backfill it, then rebuild the table with the final `NOT NULL`/nullable constraints.
- **`milestone_id`** becomes nullable, and its delete behavior changes from `ON DELETE CASCADE` to `ON DELETE SET NULL` — deleting a milestone now untags its tasks instead of deleting them. This is a deliberate, real behavior change from today (confirmed during design).
- **`sort_order`** stays a plain integer column but changes scope from "position within this task's milestone" to "position within this task's project" — a single ordering across every task in a project, regardless of milestone. Existing values get renumbered project-wide as part of the same migration (two tasks from different milestones today could both legitimately be `sort_order = 0`, which would collide once the scope is shared).

Runs automatically via the existing embedded-migration-on-startup mechanism (`sqlx::migrate!`, `src/db.rs`) — no manual deploy step, same as every prior migration. Since backend and frontend ship as one Docker image (see `docs/deployment-brief.md`), there's no rolling-deploy window where mismatched API contract versions could talk to each other — request/response shape changes below are safe to make directly.

---

## 3. Backend routes

- **`POST /api/projects/:id/tasks`** (new, replaces `POST /milestones/:id/tasks`) — creates a task directly in the project. Body gains an optional `milestone_id`.
- **`GET /api/projects/:id/tasks`** (new, replaces `GET /milestones/:id/tasks`) — lists every task in the project in one call, replacing the current one-request-per-milestone pattern.
- **`PATCH /api/tasks/:id`** (existing `update_task`, extended) — `UpdateTaskRequest` gains `milestone_id: Patch<i64>`, the same tri-state pattern already used for `description`/`due_date` (field absent = leave alone, `null` = clear the tag, a value = set it). Milestone assignment becomes just another field edit through the existing endpoint.
- **`PATCH /api/tasks/:id/reorder`** (existing, revised) — see §4 below; this is the one genuinely subtle piece of this design.
- `project_id_for_task` (`src/routes/helpers.rs`) simplifies from a join through `milestones` to a direct `SELECT project_id FROM tasks WHERE id = ?`.

No changes to notification tiers: creating a task is still the `TaskMilestones` event; changing a task's milestone tag is a field edit like any other (`Tier::All`).

---

## 4. Reordering: scoped vs. flat

List view's grouped mode shows each milestone's tasks as a **filtered view** into the single project-wide order, not an independent list — dragging within a section can't be resolved the same way flat-mode dragging is, and naively renumbering just the touched subset contiguously would scramble every task outside that subset (traced through concretely during design: it produces colliding/out-of-order `sort_order` values for untouched tasks). `reorder_task`'s request needs to say which kind of drag happened:

- **`scoped: false`** (flat-mode drag, or the default) — behaves as today: fetch all of the project's other tasks ordered by `sort_order`, splice the moved task in at the requested position, renumber the whole project's list `0..N` contiguously.
- **`scoped: true`** (a grouped-mode section drag) — the moved task's own current `milestone_id` is looked up server-side and trusted as the scope (safe because each milestone section is its own independent drag-and-drop zone today — a task can only be picked up and dropped within the section it's already rendered in; cross-section dragging isn't wired, since milestone reassignment happens only through the detail modal per §1). The backend then:
  1. Fetches every task sharing that same `milestone_id` (including tasks where it's `NULL`, for the "No milestone" section), ordered by current `sort_order` — call the resulting set of values the "slots" (e.g. `{0, 2, 4}` — not generally contiguous, since other tasks occupy the gaps).
  2. Splices the moved task into its requested position within that filtered sequence.
  3. Reassigns that **same set of slot values** to the new intra-group order — not a fresh `0..N`. This is what keeps every task outside the touched milestone completely undisturbed, both in stored value and in order relative to everything else.

Net effect: a grouped-mode drag only ever reshuffles where that milestone's tasks fall relative to each other; a flat-mode drag reorders the whole project.

---

## 5. Frontend data layer

`ProjectContext`'s `tasks` state changes from `Record<milestoneId, TaskWithAssignees[]>` to a flat `TaskWithAssignees[]` — fetched with one `tasksApi.list(projectId)` call instead of the current one-request-per-milestone loop.

Every consumer gets simpler:
- **KanbanBoard**'s `Object.values(tasks).flat()` becomes just `tasks`.
- **TaskDetailModal**'s flatten-and-find becomes a plain `tasks.find(...)`.
- **ListView** is the one place that gains logic: it derives milestone groupings from the flat array itself (group by `milestone_id`; tasks with none land in their own "No milestone" section) rather than receiving pre-grouped data from context.

`ProjectContext`'s task actions all drop the `milestoneId` parameter they currently carry solely to locate the right bucket in the old `Record`:
- `addTask(input)` — `input` carries an optional `milestone_id`.
- `updateTask(id, input)` — `input.milestone_id` becomes settable/clearable like any other field.
- `deleteTask(id)`, `reorderTask(id, sortOrder, scoped)`, `assignUser(taskId, userId)`, `unassignUser(taskId, userId)` — all lose their `milestoneId` argument.

---

## 6. List view UI

**Grouping toggle**, local to ListView (Kanban is unaffected). Lives as a second URL search param alongside the existing `?view=`, e.g. `?group=milestone` (default, current behavior) vs `?group=none` — consistent with how `view` already persists in the URL.

**Grouped mode** (default): same milestone-sectioned rendering as today, plus one new **"No milestone"** section — always rendered, even when empty, pinned last, not draggable as a section (it isn't backed by a real `MilestoneSummary`). It gets the same add-task row as any other section, creating with `milestone_id: null`. Dragging within any section (including "No milestone") issues a `scoped: true` reorder (§4).

**Flat mode**: one list, every project task in the single project-wide order, each row showing a milestone chip (reusing `KanbanCard`'s existing badge styling — `bg-accent-subtle text-accent-muted`, small rounded pill) when the task has one, nothing when it doesn't. One add-task control for the whole list, creating with no milestone by default. Dragging issues a `scoped: false` reorder.

---

## 7. Testing

Matches this repo's existing convention (no backend route-level tests). On the frontend: `ListView.test.tsx` needs new coverage for the grouping toggle and the "No milestone" section; `KanbanBoard.test.tsx` and `TaskDetailModal.test.tsx` need fixtures updated from the `Record<milestoneId, Task[]>` shape to a flat array (their actual test logic shouldn't need to change much, since both already treat tasks as an effectively flat list today).
