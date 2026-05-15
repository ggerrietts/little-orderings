# Frontend MVP Design — little-orderings

**Date:** 2026-05-14  
**Scope:** Phases 5–10 of the original plan, plus one backend correction (task status enum)  
**Stack assumption:** Rust/Axum/SQLite backend is complete for phases 0–4 (and user management overhaul). Frontend is currently stubs.

---

## 1. Pre-flight: Cleanup Before Frontend Work

Before any frontend work begins, the following uncommitted backend changes must be committed:

- `Cargo.toml` — added `clap` dep for CLI
- `src/main.rs` — rewritten with `clap` CLI: `plan-g serve`, `plan-g user {create,list,delete,set-password}`
- `src/auth.rs` — removed `register` Axum handler; added standalone `create_user`, `list_users`, `delete_user`, `set_user_password`, `seed_admin` functions
- `src/models.rs` — removed `RegisterRequest` struct
- `src/routes/mod.rs` — removed `POST /api/users` route (**`create_user` must not be exposed as an HTTP endpoint; verify no route re-introduces it**)
- `src/error.rs` — added `Display` impl for `AppError`
- `Dockerfile`, `docker-compose.yml` — added Docker build and runtime
- `frontend/src/api/client.ts` — remove the dead `auth.register()` method (the endpoint no longer exists)

The `PLAN.md` file was also moved from `doc/` to `docs/` — include this rename in the commit.

---

## 2. Backend Correction: Task Status Enum

The original plan defined task statuses as `todo | in_progress | review | done | cancelled`. Replace `review` with `blocked` to better match the problem domain (personal/family project management, not software reviews).

**Changes required:**

- New migration file `migrations/002_task_status_blocked.sql`:
  ```sql
  UPDATE tasks SET status = 'blocked' WHERE status = 'review';
  ```
- `src/models.rs` — update `TaskStatus` enum: replace `Review` variant with `Blocked`
- Re-run `cargo test` to regenerate `frontend/src/types/TaskStatus.ts`
- The generated type change propagates automatically to the frontend

---

## 3. Frontend Foundation: What's Already Done

The following are complete and should not be modified:

- `frontend/src/App.tsx` — router, `ProtectedRoute`, route layout
- `frontend/src/contexts/AuthContext.tsx` — auth context with `user`, `setUser`, `loading`
- `frontend/src/pages/Login.tsx` — login form, styled, functional
- `frontend/src/api/client.ts` — typed fetch wrappers for all API routes (after `auth.register` removal)
- `frontend/src/types/` — generated TypeScript types from Rust structs (after `TaskStatus` update)

Phase 5 is complete. Work begins at Phase 6.

---

## 4. Phase 6: Dashboard

**File:** `frontend/src/pages/Dashboard.tsx`

Fetches `GET /api/projects` (`ProjectListItem[]`) on mount via `useState` + `useEffect`.

**Page layout:**
- `slate-900` background, full-height
- Top nav: app name ("Little Orderings"), right-side logout button — calls `auth.logout()`, clears `AuthContext` user, navigates to `/login`
- Below nav: "Your Projects" heading + "New Project" button (top-right)
- Responsive card grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`, `gap-4`)

**Project card** (`bg-slate-800`, rounded, hover highlight):
- Project name — link (`<Link>`) to `/projects/:id`
- Description — 2 lines max (`line-clamp-2`), `text-slate-400`
- Target date — formatted `MMM d, yyyy` via `date-fns`; red if `target_date < today`
- Status badge — `active` (emerald) / `archived` (slate)
- Member count and open task count — bottom row, icon + number

**Create Project modal:**
- Triggered by "New Project" button; rendered with a simple `{open && <Modal>}` pattern (no portal needed at this scope)
- Form fields: name (required text), description (optional textarea), target date (optional `<input type="date">`)
- Submit: `POST /api/projects`, then append the returned `Project` to local list state (cast to `ProjectListItem` with zero counts); close modal

**Loading state:** centered spinner (`border-emerald-500`, `animate-spin`)  
**Error state:** `text-red-400` error message  
**Empty state:** "No projects yet." message with "Create your first project" button (triggers same modal)

---

## 5. Phase 7: Project Page & List View

### 5.1 ProjectContext

**File:** `frontend/src/contexts/ProjectContext.tsx`

Provides all project-level data and mutation methods to child components.

**State shape:**
```typescript
interface ProjectContextType {
  project: ProjectDetail | null;
  milestones: MilestoneSummary[];
  tasks: Record<number, TaskWithAssignees[]>; // keyed by milestone_id
  members: ProjectMember[];
  loading: boolean;
  selectedTaskId: number | null;
  setSelectedTaskId: (id: number | null) => void;
  // Mutations (all call API then update local state):
  addMilestone: (input: CreateMilestoneInput) => Promise<void>;
  updateMilestone: (id: number, input: UpdateMilestoneInput) => Promise<void>;
  deleteMilestone: (id: number) => Promise<void>;
  reorderMilestone: (id: number, sortOrder: number) => Promise<void>;
  addTask: (milestoneId: number, input: CreateTaskInput) => Promise<void>;
  updateTask: (id: number, milestoneId: number, input: UpdateTaskInput) => Promise<void>;
  deleteTask: (id: number, milestoneId: number) => Promise<void>;
  reorderTask: (id: number, fromMilestoneId: number, toMilestoneId: number, sortOrder: number) => Promise<void>;
  assignUser: (taskId: number, milestoneId: number, userId: number) => Promise<void>;
  unassignUser: (taskId: number, milestoneId: number, userId: number) => Promise<void>;
}
```

**Data loading in `Project.tsx`:** Fetch `project` + `members` in parallel on mount. After milestones are known (from `project.milestones`), fetch all milestone task lists in a second wave (`Promise.all`). All results land in context state.

### 5.2 Project.tsx (container)

**File:** `frontend/src/pages/Project.tsx`

- Creates `ProjectContext`, handles loading/error states
- Page header: project name, target date, optional description, view toggle tabs (List | Kanban)
- View toggle reads `?view=list|kanban` query param; default is list. **Design the toggle as a multi-option tab bar, not a binary toggle** — List and Kanban are the first two views; additional views (e.g., Calendar, see §9) will be added later without structural change.
- Renders `<ListView />` or `<KanbanBoard />` based on param
- Renders `<TaskDetailModal />` when `selectedTaskId !== null`

### 5.3 ListView Component

**File:** `frontend/src/components/ListView.tsx`

Reads from `ProjectContext`. Renders milestones in `sort_order` order.

**Milestone section:**
- Drag handle (visible on hover) + collapsible chevron
- Milestone name — `<InlineEdit>` component (span → input on click, blur/Enter saves, Escape cancels)
- Status badge, target date, task count
- "+" button to add a task (inline form at bottom of task list)
- `@dnd-kit/sortable` `SortableContext` (vertical) for milestone-level reordering; on drag end calls `reorderMilestone`

**Task row:**
- Checkbox — toggles `todo` ↔ `done` via `updateTask`
- Title — `<button>` styled as text; clicking sets `selectedTaskId` to open `TaskDetailModal`. All editing happens in the modal, not inline on the row.
- Priority dot — `w-2 h-2 rounded-full`: low=`bg-slate-500`, normal=`bg-blue-500`, high=`bg-amber-500`, urgent=`bg-red-500`
- Due date — `text-slate-400` or `text-red-400` if overdue and not done
- Assignee avatars — `w-6 h-6 rounded-full bg-slate-600` with initials, max 3 shown + overflow count
- `@dnd-kit/sortable` for task reordering within milestone; on drag end calls `reorderTask`

**"Add task" row** (bottom of each milestone): text input + submit; calls `addTask`  
**"Add milestone" button** (page bottom): opens a small form/modal; calls `addMilestone`

### 5.4 InlineEdit Component

**File:** `frontend/src/components/InlineEdit.tsx`

```typescript
interface InlineEditProps {
  value: string;
  onSave: (newValue: string) => void;
  className?: string;
}
```

Renders as `<span>` normally; on click switches to `<input>` with same text/font class; saves on `blur` or `Enter`; cancels (restores original) on `Escape`. Handles empty-string guard (don't save blank).

---

## 6. Phase 8: Kanban View

**File:** `frontend/src/components/KanbanBoard.tsx`

Reads from `ProjectContext`. Renders all non-cancelled tasks across all milestones, organized by status.

**Columns:** Todo, In Progress, Blocked, Done (4 columns)

**Layout:** Horizontal scroll container; each column `min-w-64`, `bg-slate-800/50`, rounded. Column header shows name + task count badge.

**KanbanCard** (`frontend/src/components/KanbanCard.tsx`):
- Title
- Milestone name label (small `bg-slate-700` badge)
- Priority dot (same colors as ListView)
- Due date (red if overdue and not done)
- Assignee avatar initials (max 3)
- Clicking card sets `selectedTaskId` → opens `TaskDetailModal`

**Drag between columns:**
- `DndContext` wraps the board
- Each column is a `useDroppable` zone (id = status string)
- Each card is a `useDraggable` item (id = task id)
- `onDragEnd`: if destination column differs from task's current status, call `updateTask` with new status and optimistically update context state first (so the card moves immediately without waiting for API)

---

## 7. Phase 9: Task Detail Modal

**File:** `frontend/src/components/TaskDetailModal.tsx`

Rendered via `ReactDOM.createPortal` into `document.body`. Triggered when `ProjectContext.selectedTaskId !== null`.

**Layout:** Dark overlay (`bg-black/50`), centered panel (`bg-slate-800`, `max-w-lg`, `rounded-xl`). Close on Escape keydown or backdrop click.

**Fields (all save immediately on change/blur — no explicit Save button):**
- Title — text input, saves on blur
- Description — textarea, saves on blur
- Status — `<select>` with 5 options, saves on change
- Priority — `<select>` with 4 options, saves on change
- Due date — `<input type="date">`, saves on change
- Milestone — `<select>` populated from `ProjectContext.milestones`; changing it calls `reorderTask` to move the task to the new milestone
- Assignees — list of `{username, id}` from `TaskWithAssignees.assignees`; each has a ×-button calling `unassignUser`; "Assign" `<select>` listing project members not yet assigned, on change calls `assignUser`

**Delete button** — bottom of modal, `text-red-400`; confirms with a browser confirm dialog; calls `deleteTask`, closes modal.

All mutations flow through `ProjectContext` methods, which update local state so both ListView and KanbanBoard reflect changes without re-fetching.

---

## 8. Phase 10: Polish

**Overdue highlighting:**
- Task due date display (in ListView, KanbanCard, TaskDetailModal) applies `text-red-400` when `due_date < today && status !== 'done' && status !== 'cancelled'`
- Milestone target date applies same logic in ListView milestone header

**Empty states:**
- Dashboard: "No projects yet. Create your first project." with a "New Project" button
- Project page (no milestones): "No milestones yet. Add your first milestone." with an "Add milestone" button
- Milestone (no tasks): "No tasks yet. Add your first task." with an "Add task" button

---

## 9. Deferred (Post-MVP)

The following were considered and explicitly deferred:

- **Remove `seed_admin` startup behavior** — the current `seed_admin` function runs at startup to create an initial admin user. There is no meaningful distinction between admin and non-admin users in this system, so the "admin user" concept does not belong in the data model. Replace `seed_admin` with a Docker Compose `init` service that runs `plan-g user create` to provision a test user. No user is created implicitly at server startup.
- **Calendar view** — projects, milestones, and selected tasks should be visualizable on a calendar. The view toggle in §5.2 is intentionally designed as an extensible tab bar to accommodate this. A calendar view will require a dedicated route/query param value (`?view=calendar`) and a new calendar component; no structural change to `Project.tsx` is expected.
- **Completed/cancelled task archiving** — tasks and milestones in terminal states (`done`, `cancelled`) should eventually be hidden from default views but remain accessible for historical/archival purposes. The mechanism (a filter toggle, a separate "Archive" route, an `archived_at` timestamp, etc.) is TBD; for now, all tasks are always shown.
- **Avatar customization** — family members share initials; allow per-user emoji avatar selection. Requires `profile_emoji` column on users, profile editor UI.
- **'n' keyboard shortcut** — add task in focused milestone
- **Ctrl+K global search** — filter visible tasks by title
- **"My Tasks" view** — tasks assigned to current user across projects, requires new API endpoint + new route

---

## 10. File Structure After Completion

```
frontend/src/
├── contexts/
│   ├── AuthContext.tsx       (existing — complete)
│   └── ProjectContext.tsx    (new)
├── components/
│   ├── InlineEdit.tsx        (new)
│   ├── ListView.tsx          (new)
│   ├── KanbanBoard.tsx       (new)
│   ├── KanbanCard.tsx        (new)
│   └── TaskDetailModal.tsx   (new)
├── pages/
│   ├── Login.tsx             (existing — complete)
│   ├── Dashboard.tsx         (implement)
│   ├── Project.tsx           (implement)
│   └── NotFound.tsx          (existing — complete)
├── api/
│   └── client.ts             (existing — remove auth.register)
└── types/                    (generated — update after TaskStatus migration)
```

Backend additions:
```
migrations/
└── 002_task_status_blocked.sql   (new migration: review → blocked)
```
