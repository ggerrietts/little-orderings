# Project Archiving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project owner archive/reactivate a project from its own page, and hide archived projects from the Dashboard by default (with a toggle to show them).

**Architecture:** The backend already stores `projects.status` (`active`/`archived`) and already persists it via `PATCH /api/projects/:id`; this plan tightens that endpoint's permission for status changes to owner-only, removes the now-redundant `DELETE /api/projects/:id` archive shortcut, and adds the frontend pieces (a project-page control, a Dashboard filter) that are the only things actually missing today.

**Tech Stack:** Rust/Axum backend (`sqlx`, no new DB access patterns), React 19/Vite frontend, Vitest for frontend tests.

## Global Constraints

- Archiving/reactivating (setting `status` via `PATCH /api/projects/:id`) requires the caller to be an **owner** of the project. Other fields (`name`, `description`, `target_date`) remain writer-editable as today.
- `DELETE /api/projects/:id` (`archive_project` handler) is removed entirely — no code should reference it after this plan.
- No confirmation dialog for archive/reactivate — the action is immediate on click.
- The Dashboard's "show archived" toggle defaults to **hidden** (`false`) and is **not persisted** — it resets on every page load.
- No database schema changes.

Reference: `docs/superpowers/specs/2026-08-18-project-archiving-design.md`.

---

### Task 1: Backend — owner-gated status transitions, remove the DELETE shortcut

**Files:**
- Modify: `src/routes/projects.rs`
- Modify: `src/routes/mod.rs`

**Interfaces:**
- Produces: `PATCH /api/projects/:id` now additionally requires owner permission (`403 Forbidden` for a non-owner writer) whenever the request body includes `status`. Response shape and success behavior for non-status fields are unchanged.
- Produces: `DELETE /api/projects/:id` no longer exists (removed route + handler).

- [ ] **Step 1: Add `ProjectStatus` to this file's model imports**

In `src/routes/projects.rs`, find the `use crate::{ ... models::{ ... } ... }` block near the top:

```rust
use crate::{
    auth::AuthUser,
    error::AppError,
    models::{
        AddMemberRequest, CreateProjectRequest, MilestoneSummary, Patch, Project, ProjectDetail,
        ProjectListItem, ProjectMember, UpdateMemberRoleRequest, UpdateProjectRequest,
    },
    AppState,
};
```

Add `ProjectStatus` to the list (alphabetical order, right after `Project`):

```rust
use crate::{
    auth::AuthUser,
    error::AppError,
    models::{
        AddMemberRequest, CreateProjectRequest, MilestoneSummary, Patch, Project, ProjectDetail,
        ProjectListItem, ProjectMember, ProjectStatus, UpdateMemberRoleRequest, UpdateProjectRequest,
    },
    AppState,
};
```

- [ ] **Step 2: Write the failing unit test for the pure permission-branching function**

At the very end of `src/routes/projects.rs` (after the last `}` in the file, which closes `remove_member`), add:

```rust

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_change_requires_owner_true_when_status_present() {
        assert!(status_change_requires_owner(&Some(ProjectStatus::Archived)));
    }

    #[test]
    fn status_change_requires_owner_false_when_status_absent() {
        assert!(!status_change_requires_owner(&None::<ProjectStatus>));
    }
}
```

`status_change_requires_owner` doesn't exist yet — this is the "red" step.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test status_change_requires_owner`
Expected: FAILS TO COMPILE — `cannot find function 'status_change_requires_owner' in this scope`.

- [ ] **Step 4: Add the pure helper function**

Immediately before `pub async fn update_project(` in `src/routes/projects.rs`, add:

```rust
fn status_change_requires_owner(status: &Option<ProjectStatus>) -> bool {
    status.is_some()
}

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test status_change_requires_owner`
Expected: both tests PASS.

- [ ] **Step 6: Wire the permission check into `update_project`**

In `src/routes/projects.rs`, find:

```rust
pub async fn update_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<UpdateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let mut qb = QueryBuilder::<sqlx::Sqlite>::new(
```

Change to:

```rust
pub async fn update_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<UpdateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;
    if status_change_requires_owner(&payload.status) {
        crate::auth::require_owner(&state.pool, project_id, user.id).await?;
    }

    let mut qb = QueryBuilder::<sqlx::Sqlite>::new(
```

- [ ] **Step 7: Remove `archive_project` and the DELETE route**

In `src/routes/projects.rs`, delete this entire function (it directly follows `update_project`, ending right before `pub async fn list_members` or whatever the next handler is):

```rust
pub async fn archive_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_owner(&state.pool, project_id, user.id).await?;

    sqlx::query(
        "UPDATE projects SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(project_id)
    .execute(&state.pool)
    .await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All, user.id).await;

    Ok(StatusCode::NO_CONTENT)
}
```

In `src/routes/mod.rs`, find:

```rust
        .route(
            "/projects/:id",
            get(projects::get_project)
                .patch(projects::update_project)
                .delete(projects::archive_project),
        )
```

Change to:

```rust
        .route(
            "/projects/:id",
            get(projects::get_project).patch(projects::update_project),
        )
```

- [ ] **Step 8: Build to confirm everything compiles**

Run: `cargo build`
Expected: builds successfully with no errors (the `StatusCode` import in `projects.rs` stays needed — it's used by `create_project`, `add_member`, `remove_member`, and `update_member_role`, none of which this task touches).

- [ ] **Step 9: Run the full backend test suite**

Run: `cargo test`
Expected: all tests pass, including the two new ones from Step 5.

- [ ] **Step 10: Commit**

```bash
git add src/routes/projects.rs src/routes/mod.rs
git commit -m "feat: require owner role for project status transitions, drop DELETE archive shortcut"
```

---

### Task 2: Frontend — `updateProject` action on `ProjectContext`

**Files:**
- Modify: `frontend/src/contexts/ProjectContext.tsx`
- Modify: `frontend/src/contexts/ProjectContext.test.tsx`

**Interfaces:**
- Consumes: `projects.update(id, input)` from `frontend/src/api/client.ts` (already exists, returns `Promise<Project>`), and `UpdateProjectInput` type (already exported from the same file: `{ name?, description?, target_date?, status?: 'active' | 'archived' }`).
- Produces: `updateProject: (input: UpdateProjectInput) => Promise<void>` added to `ProjectContextType`/`useProject()`'s return value. Calling it updates `project` state by merging the PATCH response's fields into the existing `ProjectDetail` (preserving `milestones` and `my_watch_tier`, which the PATCH response doesn't include).

- [ ] **Step 1: Write the failing test**

In `frontend/src/contexts/ProjectContext.test.tsx`, find the `vi.mock('../api/client', ...)` block:

```typescript
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    projects: { get: vi.fn(), listMembers: vi.fn() },
    tasks: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
             assign: vi.fn(), unassign: vi.fn(), reorder: vi.fn() },
    milestones: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() },
  }
})
```

Add `update: vi.fn()` to the `projects` mock object:

```typescript
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    projects: { get: vi.fn(), listMembers: vi.fn(), update: vi.fn() },
    tasks: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
             assign: vi.fn(), unassign: vi.fn(), reorder: vi.fn() },
    milestones: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() },
  }
})
```

Then add a new test anywhere after the existing tests in the file (it already has `project`, `members`, `milestone`, `task` fixtures defined near the top — reuse them):

```typescript
test('updateProject calls projects.update and merges the result without losing milestones', async () => {
  mockProjects.get.mockResolvedValue(project)
  mockProjects.listMembers.mockResolvedValue(members)
  mockTasks.list.mockResolvedValue([task])
  mockProjects.update.mockResolvedValue({
    id: 1, name: 'Proj', description: null, status: 'archived',
    target_date: null, created_at: null, updated_at: null,
  })

  function ArchiveConsumer() {
    const ctx = useProject()
    if (ctx.loading) return <div>loading</div>
    return (
      <div>
        <div data-testid="status">{ctx.project?.status}</div>
        <div data-testid="milestone-count">{ctx.milestones.length}</div>
        <button onClick={() => ctx.updateProject({ status: 'archived' })}>archive</button>
      </div>
    )
  }

  render(<ProjectProvider projectId={1}><ArchiveConsumer /></ProjectProvider>)
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('active'))

  await act(async () => {
    screen.getByRole('button', { name: 'archive' }).click()
  })

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('archived'))
  expect(mockProjects.update).toHaveBeenCalledWith(1, { status: 'archived' })
  expect(screen.getByTestId('milestone-count')).toHaveTextContent('1')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/contexts/ProjectContext.test.tsx`
Expected: FAILS — `ctx.updateProject is not a function` (or a TypeScript error if you run `tsc` first; either way, the property doesn't exist yet).

- [ ] **Step 3: Add `UpdateProjectInput` to the type imports**

In `frontend/src/contexts/ProjectContext.tsx`, find:

```typescript
import { projects as projectsApi, milestones as milestonesApi, tasks as tasksApi } from '../api/client'
import type { CreateMilestoneInput, UpdateMilestoneInput, CreateTaskInput, UpdateTaskInput } from '../api/client'
```

Change to:

```typescript
import { projects as projectsApi, milestones as milestonesApi, tasks as tasksApi } from '../api/client'
import type { CreateMilestoneInput, UpdateMilestoneInput, CreateTaskInput, UpdateTaskInput, UpdateProjectInput } from '../api/client'
```

- [ ] **Step 4: Add `updateProject` to the context type and implementation**

In `frontend/src/contexts/ProjectContext.tsx`, find the `ProjectContextType` interface's `addMilestone` line:

```typescript
  addMilestone: (input: CreateMilestoneInput) => Promise<void>
```

Add a new line directly above it:

```typescript
  updateProject: (input: UpdateProjectInput) => Promise<void>
  addMilestone: (input: CreateMilestoneInput) => Promise<void>
```

Then find the `addMilestone` function implementation:

```typescript
  async function addMilestone(input: CreateMilestoneInput) {
    const m = await milestonesApi.create(projectId, input)
    setMilestones(prev => [...prev, m])
  }
```

Add a new function directly above it:

```typescript
  async function updateProject(input: UpdateProjectInput) {
    const updated = await projectsApi.update(projectId, input)
    setProject(prev => (prev ? { ...prev, ...updated } : prev))
  }

  async function addMilestone(input: CreateMilestoneInput) {
    const m = await milestonesApi.create(projectId, input)
    setMilestones(prev => [...prev, m])
  }
```

Finally, find the `ProjectContext.Provider` value object:

```typescript
    <ProjectContext.Provider value={{
      project, projectId, milestones, tasks, members, loading,
      selectedTaskId, setSelectedTaskId,
      addMilestone, updateMilestone, deleteMilestone, reorderMilestone,
```

Change to:

```typescript
    <ProjectContext.Provider value={{
      project, projectId, milestones, tasks, members, loading,
      selectedTaskId, setSelectedTaskId,
      updateProject,
      addMilestone, updateMilestone, deleteMilestone, reorderMilestone,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/contexts/ProjectContext.test.tsx`
Expected: all tests (existing + new) PASS.

- [ ] **Step 6: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/contexts/ProjectContext.tsx frontend/src/contexts/ProjectContext.test.tsx
git commit -m "feat: add updateProject action to ProjectContext"
```

---

### Task 3: Frontend — `ArchiveControl` component, wired into the Project page

**Files:**
- Create: `frontend/src/components/ArchiveControl.tsx`
- Test: `frontend/src/components/ArchiveControl.test.tsx`
- Modify: `frontend/src/pages/Project.tsx`

**Interfaces:**
- Consumes: `useAuth()` (`frontend/src/contexts/AuthContext.tsx`, returns `{ user: User | null, ... }`), `useProject()` (Task 2's `updateProject`, plus existing `project: ProjectDetail | null` and `members: ProjectMember[]`).
- Produces: `ArchiveControl` — a no-props component rendered inside `<ProjectProvider>` (via `Project.tsx`), self-contained.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ArchiveControl.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ArchiveControl } from './ArchiveControl'
import * as authContext from '../contexts/AuthContext'
import * as projectContext from '../contexts/ProjectContext'
import type { ProjectMember, ProjectDetail, User } from '../types'

vi.mock('../contexts/AuthContext')
vi.mock('../contexts/ProjectContext')

const mockUseAuth = authContext.useAuth as ReturnType<typeof vi.fn>
const mockUseProject = projectContext.useProject as ReturnType<typeof vi.fn>

const owner: ProjectMember = { user_id: 1, username: 'alice', email: 'alice@example.com', role: 'owner' }
const memberRow: ProjectMember = { user_id: 2, username: 'bob', email: 'bob@example.com', role: 'member' }

const ownerUser: User = { id: 1, username: 'alice', email: 'alice@example.com', created_at: null }
const memberUser: User = { id: 2, username: 'bob', email: 'bob@example.com', created_at: null }

const updateProject = vi.fn()

function activeProject(): ProjectDetail {
  return {
    id: 1, name: 'Proj', description: null, status: 'active',
    target_date: null, created_at: null, updated_at: null,
    milestones: [], my_watch_tier: null,
  }
}

function mockContext(project: ProjectDetail, members: ProjectMember[]) {
  mockUseProject.mockReturnValue({
    project, members, updateProject,
  } as unknown as ReturnType<typeof projectContext.useProject>)
}

beforeEach(() => {
  vi.resetAllMocks()
  updateProject.mockResolvedValue(undefined)
})

test('renders nothing for a non-owner', () => {
  mockUseAuth.mockReturnValue({ user: memberUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext(activeProject(), [owner, memberRow])

  render(<ArchiveControl />)

  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('shows "Archive" for an owner viewing an active project', () => {
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext(activeProject(), [owner, memberRow])

  render(<ArchiveControl />)

  expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()
})

test('shows "Reactivate" for an owner viewing an archived project', () => {
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext({ ...activeProject(), status: 'archived' }, [owner, memberRow])

  render(<ArchiveControl />)

  expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument()
})

test('clicking "Archive" calls updateProject with status: archived', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext(activeProject(), [owner, memberRow])

  render(<ArchiveControl />)
  await user.click(screen.getByRole('button', { name: 'Archive' }))

  expect(updateProject).toHaveBeenCalledWith({ status: 'archived' })
})

test('clicking "Reactivate" calls updateProject with status: active', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext({ ...activeProject(), status: 'archived' }, [owner, memberRow])

  render(<ArchiveControl />)
  await user.click(screen.getByRole('button', { name: 'Reactivate' }))

  expect(updateProject).toHaveBeenCalledWith({ status: 'active' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/ArchiveControl.test.tsx`
Expected: FAIL — `Failed to resolve import "./ArchiveControl"` (the component doesn't exist yet).

- [ ] **Step 3: Write the component**

Create `frontend/src/components/ArchiveControl.tsx`:

```typescript
import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProject } from '../contexts/ProjectContext'

export function ArchiveControl() {
  const { user: currentUser } = useAuth()
  const { project, members, updateProject } = useProject()
  const [busy, setBusy] = useState(false)

  const currentRole = members.find(m => m.user_id === currentUser?.id)?.role
  const isOwner = currentRole === 'owner'

  if (!isOwner || !project) return null

  const isArchived = project.status === 'archived'

  async function handleClick() {
    setBusy(true)
    try {
      await updateProject({ status: isArchived ? 'active' : 'archived' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="text-sm text-muted hover:text-text transition-colors disabled:opacity-50"
    >
      {isArchived ? 'Reactivate' : 'Archive'}
    </button>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/ArchiveControl.test.tsx`
Expected: all 5 tests PASS.

- [ ] **Step 5: Wire it into `Project.tsx`**

In `frontend/src/pages/Project.tsx`, add the import alongside the other component imports:

```typescript
import { WatchToggle } from '../components/WatchToggle'
import { MembersTab } from '../components/MembersTab'
```

becomes:

```typescript
import { WatchToggle } from '../components/WatchToggle'
import { MembersTab } from '../components/MembersTab'
import { ArchiveControl } from '../components/ArchiveControl'
```

Then find the header controls row:

```typescript
            <div className="flex items-center gap-3">
              <WatchToggle projectId={projectId} currentTier={watchTier} onChange={setWatchTier} />
              <InstallLink />
            </div>
```

Change to:

```typescript
            <div className="flex items-center gap-3">
              <ArchiveControl />
              <WatchToggle projectId={projectId} currentTier={watchTier} onChange={setWatchTier} />
              <InstallLink />
            </div>
```

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npm test`
Expected: all tests pass, including the existing `Project.test.tsx` suite (its `fakeMembers` fixture is an empty array, so `ArchiveControl` renders nothing there — no existing assertions are affected) and the 5 new `ArchiveControl.test.tsx` tests.

- [ ] **Step 7: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ArchiveControl.tsx frontend/src/components/ArchiveControl.test.tsx frontend/src/pages/Project.tsx
git commit -m "feat: add Archive/Reactivate control to the project page"
```

---

### Task 4: Frontend — Dashboard "show archived" filter

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/pages/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `ProjectListItem.status` (already present on every item returned by `projectsApi.list()`).
- Produces: no new exports — this is a self-contained change to `Dashboard`'s own render logic.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/pages/Dashboard.test.tsx`, add these three tests anywhere after the existing ones:

```typescript
test('hides archived projects by default', async () => {
  const items: ProjectListItem[] = [
    { id: 1, name: 'Alpha', description: null, status: 'active',
      target_date: null, created_at: null, updated_at: null,
      member_count: 1, open_task_count: 0 },
    { id: 2, name: 'Camping Trip', description: null, status: 'archived',
      target_date: null, created_at: null, updated_at: null,
      member_count: 1, open_task_count: 0 },
  ]
  mockProjects.list.mockResolvedValue(items)
  renderDashboard()
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
  expect(screen.queryByText('Camping Trip')).not.toBeInTheDocument()
})

test('shows archived projects when "Show archived" is checked', async () => {
  const user = userEvent.setup()
  const items: ProjectListItem[] = [
    { id: 1, name: 'Alpha', description: null, status: 'active',
      target_date: null, created_at: null, updated_at: null,
      member_count: 1, open_task_count: 0 },
    { id: 2, name: 'Camping Trip', description: null, status: 'archived',
      target_date: null, created_at: null, updated_at: null,
      member_count: 1, open_task_count: 0 },
  ]
  mockProjects.list.mockResolvedValue(items)
  renderDashboard()
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())

  await user.click(screen.getByRole('checkbox', { name: /show archived/i }))

  expect(screen.getByText('Camping Trip')).toBeInTheDocument()
})

test('shows a filtered-empty message when every project is archived and the toggle is off', async () => {
  const items: ProjectListItem[] = [
    { id: 2, name: 'Camping Trip', description: null, status: 'archived',
      target_date: null, created_at: null, updated_at: null,
      member_count: 1, open_task_count: 0 },
  ]
  mockProjects.list.mockResolvedValue(items)
  renderDashboard()
  await waitFor(() => expect(screen.getByText(/no active projects/i)).toBeInTheDocument())
  expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/Dashboard.test.tsx`
Expected: the 3 new tests FAIL — no checkbox exists yet, and archived items render unfiltered.

- [ ] **Step 3: Add the `showArchived` state and filtered list**

In `frontend/src/pages/Dashboard.tsx`, find:

```typescript
  const [modalOpen, setModalOpen] = useState(false)
  const { setUser } = useAuth()
```

Change to:

```typescript
  const [modalOpen, setModalOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const { setUser } = useAuth()
```

Then find:

```typescript
  const today = startOfToday()
```

Change to:

```typescript
  const today = startOfToday()
  const visibleItems = items.filter(item => showArchived || item.status !== 'archived')
```

- [ ] **Step 4: Add the toggle to the header row**

Find:

```typescript
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold text-text">Your Projects</h1>
            <button
              onClick={() => setModalOpen(true)}
              className="bg-accent hover:bg-accent-hover text-surface text-sm font-semibold rounded-lg px-4 py-2 transition-colors"
            >
              New Project
            </button>
          </div>
```

Change to:

```typescript
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold text-text">Your Projects</h1>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={e => setShowArchived(e.target.checked)}
                  className="rounded border-border"
                />
                Show archived
              </label>
              <button
                onClick={() => setModalOpen(true)}
                className="bg-accent hover:bg-accent-hover text-surface text-sm font-semibold rounded-lg px-4 py-2 transition-colors"
              >
                New Project
              </button>
            </div>
          </div>
```

- [ ] **Step 5: Filter the grid and add the filtered-empty message**

Find the empty-state/grid conditional (it starts right after the header row from Step 4):

```typescript
          {items.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-muted mb-4">No projects yet.</p>
              <button
                onClick={() => setModalOpen(true)}
                className="text-accent-muted hover:underline"
              >
                Create your first project
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.map(item => {
```

Change to:

```typescript
          {visibleItems.length === 0 ? (
            <div className="text-center py-20">
              {items.length === 0 ? (
                <>
                  <p className="text-muted mb-4">No projects yet.</p>
                  <button
                    onClick={() => setModalOpen(true)}
                    className="text-accent-muted hover:underline"
                  >
                    Create your first project
                  </button>
                </>
              ) : (
                <p className="text-muted">No active projects. Check "Show archived" to see archived projects.</p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleItems.map(item => {
```

The closing structure at the end of this block (`})}` closing the `.map`, then `</div>`, then `)}` closing the ternary) is unchanged — only the two `items` references shown above become `visibleItems`, and the empty-state branch gains the inner conditional. The `.map(item => { ... })` body itself (project card contents, `overdue` calculation, status badge, etc.) is untouched.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/Dashboard.test.tsx`
Expected: all tests (existing + 3 new) PASS.

- [ ] **Step 7: Run the full frontend test suite and type-check**

Run: `cd frontend && npm test && npx tsc -b`
Expected: all tests pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx frontend/src/pages/Dashboard.test.tsx
git commit -m "feat: hide archived projects from the Dashboard by default, add a toggle to show them"
```

---

## Self-Review Notes

- **Spec coverage:** §3 (owner-gated PATCH, DELETE removal) → Task 1. §4 (Project-page Archive/Reactivate control, owner-only visibility, no confirmation) → Task 3 (with Task 2 providing the context action it depends on). §5 (Dashboard default-hidden + toggle, no persistence) → Task 4. §6 (testing) → each task's own test steps; the backend test is scoped to the pure permission-branching function per this repo's established convention (no DB-backed route test harness exists — see `docs/superpowers/specs/2026-08-07-push-notifications-design.md` §9 and the version-refresh plan's precedent).
- **Type consistency:** `UpdateProjectInput` (from `api/client.ts`, unchanged) flows into `updateProject: (input: UpdateProjectInput) => Promise<void>` (Task 2) exactly as consumed by `ArchiveControl`'s `updateProject({ status: ... })` calls (Task 3) — `status` values are the literal strings `'active'`/`'archived'`, matching `UpdateProjectInput['status']`'s type and the backend's `ProjectStatus` enum's `as_str()` output. `status_change_requires_owner(status: &Option<ProjectStatus>) -> bool` (Task 1) is used consistently in its one call site.
- **No placeholders:** every step contains literal, runnable code and commands; no "TBD," no "add appropriate handling."
