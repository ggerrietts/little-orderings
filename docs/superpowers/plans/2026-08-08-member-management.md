# Project Member Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let project owners add, remove, and change the role of project members through the UI, via a new "Members" tab on the project page.

**Architecture:** Two small backend additions (`GET /api/users` for the add-member picker, `PATCH /api/projects/:id/members/:user_id` for role changes) plus a new `MembersTab` React component wired into `Project.tsx` as a third tab alongside List/Kanban. `ProjectContext` gains `addMember`/`removeMember`/`updateMemberRole` actions that update local state directly (no refetch), matching the existing `addMilestone`/`deleteMilestone` pattern.

**Tech Stack:** Rust/Axum/SQLite backend, React 19/Vite CSR frontend, Vitest/RTL for frontend tests.

**Spec:** `docs/superpowers/specs/2026-08-08-member-management-design.md`

## Global Constraints

- `GET /api/users` requires only authentication (`AuthUser`), no further authorization — this app's user base is small and trusted.
- The last remaining project owner cannot be demoted (role changed away from `owner`) or removed — the new PATCH route's guard must mirror `remove_member`'s existing atomic-`WHERE`-clause style exactly, to avoid a check-then-act race.
- Role values (`owner`/`member`/`viewer`) are an established-by-convention set with no DB constraint or enum validation today (`add_member` already accepts any string) — the new PATCH route inherits that same looseness, not new validation.
- `addMember`/`removeMember`/`updateMemberRole` update `ProjectContext`'s local `members` state directly after a successful API call — no refetch of `listMembers`.
- Self-removal (an owner removing their own membership) is allowed, not specially handled — falls out of not special-casing "removing yourself" vs "removing someone else."
- Non-owners see a read-only member list — no add/remove/role controls, enforced both client-side (conditional rendering) and server-side (existing `require_owner` gating).
- Every Rust task ends with `cargo build` passing (`cargo test` where relevant). Every frontend task ends with `cd frontend && npm test && npm run build` passing.
- Commit after each task — do not batch commits.

---

## File Map

**Backend — created:**
- `src/routes/users.rs` — `GET /api/users` handler (Task 1)

**Backend — modified:**
- `src/routes/mod.rs` — register `users` module and route (Task 1); register `PATCH /projects/:id/members/:user_id` (Task 2)
- `src/models.rs` — add `UpdateMemberRoleRequest` (Task 2)
- `src/routes/projects.rs` — add `update_member_role` handler (Task 2)

**Frontend — created:**
- `frontend/src/components/MembersTab.tsx` + `.test.tsx` (Task 4)

**Frontend — modified:**
- `frontend/src/api/client.ts` — add `users.list()`, `projects.updateMemberRole()` (Task 3)
- `frontend/src/contexts/ProjectContext.tsx` — add `addMember`/`removeMember`/`updateMemberRole` actions (Task 3)
- `frontend/src/pages/Project.tsx` — add "Members" tab (Task 5)
- `frontend/src/pages/Project.test.tsx` — wrap in `AuthProvider`, mock `auth`/`users`, add a tab-switch test (Task 5)

**Not modified:** `Dockerfile`, `docker-compose*.yml`, migrations (no schema change — `project_members.role` is already a plain `TEXT` column), all other existing routes/components/tests.

---

## Task 1: `GET /api/users`

**Files:**
- Create: `src/routes/users.rs`
- Modify: `src/routes/mod.rs`

**Interfaces:**
- Consumes: `crate::auth::list_users(pool: &SqlitePool) -> Result<Vec<User>, AppError>` (already exists, used today by the `user list` CLI subcommand).
- Produces: `GET /api/users` → `Vec<User>` (JSON), each entry `{ id, username, email, created_at }` (`password_hash` already `#[serde(skip)]` on `User`).

- [ ] **Step 1: Implement the handler**

Create `src/routes/users.rs`:

```rust
use axum::{extract::State, response::IntoResponse, Json};

use crate::{auth::AuthUser, error::AppError, AppState};

pub async fn list_users(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(crate::auth::list_users(&state.pool).await?))
}
```

- [ ] **Step 2: Register the route**

In `src/routes/mod.rs`, add `pub mod users;` after `pub mod tasks;` (line 5):

```rust
pub mod helpers;
pub mod milestones;
pub mod projects;
pub mod push_subscriptions;
pub mod tasks;
pub mod users;
pub mod watches;
```

Add the route inside `api_router()`, after the `/auth/me` route (after line 21) and before the `// Push subscriptions` comment:

```rust
        .route("/auth/me", get(auth::me))
        .route("/users", get(users::list_users))
        // Push subscriptions
```

- [ ] **Step 3: Run `cargo build`**

Run: `cargo build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/routes/users.rs src/routes/mod.rs
git commit -m "feat: add GET /api/users route"
```

---

## Task 2: `PATCH /api/projects/:id/members/:user_id` (role change)

**Files:**
- Modify: `src/models.rs`
- Modify: `src/routes/projects.rs`
- Modify: `src/routes/mod.rs`

**Interfaces:**
- Produces: `PATCH /api/projects/:id/members/:user_id` `{ role: string }` → 204, or 403 if this would demote the project's only owner, or 404 if the target isn't a member.

- [ ] **Step 1: Add the request struct**

In `src/models.rs`, add after `AddMemberRequest` (after line 244, before `// ── Notifications ──`):

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateMemberRoleRequest {
    pub role: String,
}
```

- [ ] **Step 2: Implement the handler**

In `src/routes/projects.rs`, add `UpdateMemberRoleRequest` to the `models::{...}` import list (line 12-15):

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

Add this handler after `add_member` (after the current `remove_member` function, at the end of the file):

```rust
pub async fn update_member_role(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path((project_id, member_user_id)): Path<(i64, i64)>,
    Json(payload): Json<UpdateMemberRoleRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_owner(&state.pool, project_id, user.id).await?;

    // Atomically update the role unless doing so would demote the last
    // owner, avoiding a TOCTOU race between an "is last owner?" check and
    // the UPDATE — mirrors remove_member's guard style exactly.
    let result = sqlx::query(
        "UPDATE project_members
         SET role = ?
         WHERE project_id = ? AND user_id = ?
           AND (role != 'owner' OR ? = 'owner'
                OR (SELECT COUNT(*) FROM project_members
                    WHERE project_id = ? AND role = 'owner') > 1)",
    )
    .bind(&payload.role)
    .bind(project_id)
    .bind(member_user_id)
    .bind(&payload.role)
    .bind(project_id)
    .execute(&state.pool)
    .await?;

    if result.rows_affected() == 0 {
        // Either the member doesn't exist or they're the last owner.
        let exists: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .bind(project_id)
        .bind(member_user_id)
        .fetch_optional(&state.pool)
        .await?;
        return Err(if exists.is_some() {
            AppError::Forbidden // last owner — cannot demote
        } else {
            AppError::NotFound
        });
    }

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All, user.id).await;

    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 3: Register the route**

In `src/routes/mod.rs`, change the members route (lines 42-45) from:

```rust
        .route(
            "/projects/:id/members/:user_id",
            delete(projects::remove_member),
        )
```

to:

```rust
        .route(
            "/projects/:id/members/:user_id",
            patch(projects::update_member_role).delete(projects::remove_member),
        )
```

(`patch` is already imported in this file's `use axum::routing::{...}` line — no import change needed.)

- [ ] **Step 4: Run `cargo build`**

Run: `cargo build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/models.rs src/routes/projects.rs src/routes/mod.rs
git commit -m "feat: add PATCH route for changing a project member's role"
```

---

## Task 3: Frontend data layer — API client + `ProjectContext` actions

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/contexts/ProjectContext.tsx`

**Interfaces:**
- Consumes: `GET /api/users`, `PATCH /api/projects/:id/members/:user_id` from Tasks 1-2. `ProjectMember` type (`{ user_id, username, email, role }`, already generated at `frontend/src/types/ProjectMember.ts`).
- Produces: `users.list(): Promise<User[]>`. `projects.updateMemberRole(id, userId, role): Promise<void>`. `ProjectContext`'s `addMember(member: ProjectMember): Promise<void>`, `removeMember(userId: number): Promise<void>`, `updateMemberRole(userId: number, role: string): Promise<void>` — consumed by Task 4's `MembersTab`.

- [ ] **Step 1: Add `users.list()` to the API client**

In `frontend/src/api/client.ts`, add after the `pushSubscriptions` block (after line 118, before `// ── Milestones ──`):

```ts
export const users = {
  list: () =>
    request<User[]>('/api/users'),
};
```

- [ ] **Step 2: Add `projects.updateMemberRole()`**

Change the `projects` object's `removeMember` entry (lines 85-86) from:

```ts
  removeMember: (id: number, userId: number) =>
    request<void>(`/api/projects/${id}/members/${userId}`, { method: 'DELETE' }),
};
```

to:

```ts
  removeMember: (id: number, userId: number) =>
    request<void>(`/api/projects/${id}/members/${userId}`, { method: 'DELETE' }),

  updateMemberRole: (id: number, userId: number, role: string) =>
    request<void>(`/api/projects/${id}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
};
```

- [ ] **Step 3: Add `ProjectContext` actions**

In `frontend/src/contexts/ProjectContext.tsx`, add three entries to the `ProjectContextType` interface, after `unassignUser` (after line 24):

```ts
  unassignUser: (taskId: number, milestoneId: number, userId: number) => Promise<void>
  addMember: (member: ProjectMember) => Promise<void>
  removeMember: (userId: number) => Promise<void>
  updateMemberRole: (userId: number, role: string) => Promise<void>
```

Add the three functions after `unassignUser` (after line 149, before the `return (`):

```ts
  async function addMember(member: ProjectMember) {
    await projectsApi.addMember(projectId, member.user_id, member.role)
    setMembers(prev => [...prev, member])
  }

  async function removeMember(userId: number) {
    await projectsApi.removeMember(projectId, userId)
    setMembers(prev => prev.filter(m => m.user_id !== userId))
  }

  async function updateMemberRole(userId: number, role: string) {
    await projectsApi.updateMemberRole(projectId, userId, role)
    setMembers(prev => prev.map(m => m.user_id === userId ? { ...m, role } : m))
  }
```

Add them to the provider's context value (the `return (<ProjectContext.Provider value={{...}}>` block, lines 152-158):

```tsx
  return (
    <ProjectContext.Provider value={{
      project, projectId, milestones, tasks, members, loading,
      selectedTaskId, setSelectedTaskId,
      addMilestone, updateMilestone, deleteMilestone, reorderMilestone,
      addTask, updateTask, deleteTask, reorderTask,
      assignUser, unassignUser,
      addMember, removeMember, updateMemberRole,
    }}>
      {children}
    </ProjectContext.Provider>
  )
```

- [ ] **Step 4: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/contexts/ProjectContext.tsx
git commit -m "feat: add member management to API client and ProjectContext"
```

---

## Task 4: `MembersTab` component

**Files:**
- Create: `frontend/src/components/MembersTab.tsx`
- Test: `frontend/src/components/MembersTab.test.tsx`

**Interfaces:**
- Consumes: `useAuth()` (`frontend/src/contexts/AuthContext.tsx`, returns `{ user: User | null, ... }`). `useProject()` from Task 3 (`members`, `addMember`, `removeMember`, `updateMemberRole`). `users.list()` from Task 3.
- Produces: `export function MembersTab(): JSX.Element` — self-contained, no props, reads everything from context. Consumed by Task 5.

**Design decisions locked in here** (not explicit in the spec's prose, made concrete for this task): errors from any of the three actions surface as one shared inline message at the top of the tab (not per-row) — a role `<select>` automatically reverts to its prior value on a failed change for free, since it's a controlled input bound to context state that only updates after the API call succeeds. Every interactive control gets an `aria-label` disambiguating it by member name (`"Role for bob"`, `"Remove bob"`) — needed because an owner sees the same controls on every row including their own, so plain visible text like "Remove" is not unique across the page.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/MembersTab.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { MembersTab } from './MembersTab'
import * as authContext from '../contexts/AuthContext'
import * as projectContext from '../contexts/ProjectContext'
import * as client from '../api/client'
import type { ProjectMember, User } from '../types'

vi.mock('../contexts/AuthContext')
vi.mock('../contexts/ProjectContext')
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return { ...mod, users: { list: vi.fn() } }
})

const mockUseAuth = authContext.useAuth as ReturnType<typeof vi.fn>
const mockUseProject = projectContext.useProject as ReturnType<typeof vi.fn>
const mockUsersList = client.users.list as ReturnType<typeof vi.fn>

const owner: ProjectMember = { user_id: 1, username: 'alice', email: 'alice@example.com', role: 'owner' }
const memberRow: ProjectMember = { user_id: 2, username: 'bob', email: 'bob@example.com', role: 'member' }
const otherUser: User = { id: 3, username: 'carol', email: 'carol@example.com', created_at: null }

// useAuth() returns a User (id), not a ProjectMember (user_id) — these are
// separate fixtures with matching ids, not the ProjectMember rows above,
// or `currentUser?.id` in the component never matches anything.
const ownerUser: User = { id: 1, username: 'alice', email: 'alice@example.com', created_at: null }
const memberUser: User = { id: 2, username: 'bob', email: 'bob@example.com', created_at: null }

const addMember = vi.fn()
const removeMember = vi.fn()
const updateMemberRole = vi.fn()

function mockProject(members: ProjectMember[]) {
  mockUseProject.mockReturnValue({
    members, addMember, removeMember, updateMemberRole,
  } as unknown as ReturnType<typeof projectContext.useProject>)
}

beforeEach(() => {
  vi.resetAllMocks()
  addMember.mockResolvedValue(undefined)
  removeMember.mockResolvedValue(undefined)
  updateMemberRole.mockResolvedValue(undefined)
  mockUsersList.mockResolvedValue([otherUser])
})

test('non-owner sees a read-only role badge, no controls', async () => {
  mockUseAuth.mockReturnValue({ user: memberUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  expect(await screen.findByText('bob')).toBeInTheDocument()
  expect(screen.getByText('member')).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
})

test('owner can change a member\'s role', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for bob' }), 'viewer')

  expect(updateMemberRole).toHaveBeenCalledWith(2, 'viewer')
})

test('owner can remove a member', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await user.click(await screen.findByRole('button', { name: 'Remove bob' }))

  expect(removeMember).toHaveBeenCalledWith(2)
})

test('owner can add a non-member user', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Add member' }), '3')
  await user.click(screen.getByRole('button', { name: 'Add' }))

  expect(addMember).toHaveBeenCalledWith({ user_id: 3, username: 'carol', email: 'carol@example.com', role: 'member' })
})

test('add section is hidden once every user is already a member', async () => {
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockUsersList.mockResolvedValue([])
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await screen.findByText('bob')
  expect(screen.queryByRole('combobox', { name: 'Add member' })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/MembersTab.test.tsx`
Expected: FAIL — `./MembersTab` module doesn't exist yet.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/MembersTab.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProject } from '../contexts/ProjectContext'
import { users as usersApi } from '../api/client'
import type { User } from '../types'

const ROLES = ['owner', 'member', 'viewer'] as const

export function MembersTab() {
  const { user: currentUser } = useAuth()
  const { members, addMember, removeMember, updateMemberRole } = useProject()
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [selectedRole, setSelectedRole] = useState<string>('member')
  const [error, setError] = useState<string | null>(null)

  const currentRole = members.find(m => m.user_id === currentUser?.id)?.role
  const isOwner = currentRole === 'owner'

  useEffect(() => {
    if (isOwner) {
      usersApi.list().then(setAllUsers)
    }
  }, [isOwner])

  const memberIds = new Set(members.map(m => m.user_id))
  const availableUsers = allUsers.filter(u => !memberIds.has(u.id))

  async function handleAdd() {
    if (!selectedUserId) return
    const picked = allUsers.find(u => u.id === Number(selectedUserId))
    if (!picked) return
    setError(null)
    try {
      await addMember({ user_id: picked.id, username: picked.username, email: picked.email, role: selectedRole })
      setSelectedUserId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add member')
    }
  }

  async function handleRoleChange(userId: number, role: string) {
    setError(null)
    try {
      await updateMemberRole(userId, role)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change role')
    }
  }

  async function handleRemove(userId: number) {
    setError(null)
    try {
      await removeMember(userId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member')
    }
  }

  return (
    <div className="space-y-4">
      {error != null && <p className="text-danger text-sm">{error}</p>}
      <ul className="divide-y divide-border">
        {members.map(m => (
          <li key={m.user_id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-text font-medium">{m.username}</p>
              <p className="text-muted text-sm">{m.email}</p>
            </div>
            {isOwner ? (
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Role for ${m.username}`}
                  value={m.role}
                  onChange={e => handleRoleChange(m.user_id, e.target.value)}
                  className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
                >
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <button
                  aria-label={`Remove ${m.username}`}
                  onClick={() => handleRemove(m.user_id)}
                  className="text-danger hover:underline text-sm"
                >
                  Remove
                </button>
              </div>
            ) : (
              <span className="px-2 py-0.5 rounded-full bg-canvas border border-border text-muted text-xs font-medium">
                {m.role}
              </span>
            )}
          </li>
        ))}
      </ul>

      {isOwner && availableUsers.length > 0 && (
        <div className="flex items-center gap-2 pt-2">
          <select
            aria-label="Add member"
            value={selectedUserId}
            onChange={e => setSelectedUserId(e.target.value)}
            className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
          >
            <option value="">Add a member…</option>
            {availableUsers.map(u => (
              <option key={u.id} value={u.id}>{u.username}</option>
            ))}
          </select>
          <select
            aria-label="Role for new member"
            value={selectedRole}
            onChange={e => setSelectedRole(e.target.value)}
            className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
          >
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button
            onClick={handleAdd}
            disabled={!selectedUserId}
            className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-surface text-sm font-semibold rounded-lg px-3 py-1.5 transition-colors"
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/MembersTab.test.tsx`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/MembersTab.tsx frontend/src/components/MembersTab.test.tsx
git commit -m "feat: add MembersTab component"
```

---

## Task 5: Wire `MembersTab` into `Project.tsx`

**Files:**
- Modify: `frontend/src/pages/Project.tsx`
- Modify: `frontend/src/pages/Project.test.tsx`

**Interfaces:**
- Consumes: `MembersTab` from Task 4.

- [ ] **Step 1: Add the third tab**

In `frontend/src/pages/Project.tsx`, add the import (after the existing `WatchToggle` import, line 8):

```tsx
import { WatchToggle } from '../components/WatchToggle'
import { MembersTab } from '../components/MembersTab'
```

Change `ViewType` and `VIEWS` (lines 10-15) from:

```tsx
type ViewType = 'list' | 'kanban'

const VIEWS: { id: ViewType; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'kanban', label: 'Kanban' },
]
```

to:

```tsx
type ViewType = 'list' | 'kanban' | 'members'

const VIEWS: { id: ViewType; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'members', label: 'Members' },
]
```

Change the render branch (line 78) from:

```tsx
          {view === 'list' ? <ListView /> : <KanbanBoard />}
```

to:

```tsx
          {view === 'list' ? <ListView /> : view === 'kanban' ? <KanbanBoard /> : <MembersTab />}
```

- [ ] **Step 2: Update `Project.test.tsx` for the new `useAuth()` dependency**

`MembersTab` calls `useAuth()`, which throws outside an `AuthProvider`. In the real app `Project` is always rendered inside `AuthProvider` (see `frontend/src/App.tsx`) — this test's render helper just didn't need to reflect that until now, since nothing under `Project` used auth before. Bring it in line with the real render tree.

Change the top of `frontend/src/pages/Project.test.tsx` from:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import Project from './Project'
import * as client from '../api/client'
import type { ProjectDetail, ProjectMember } from '../types'

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    projects: { get: vi.fn(), listMembers: vi.fn() },
    tasks: { list: vi.fn() },
    milestones: {},
    watches: { set: vi.fn(), remove: vi.fn() },
  }
})

const mockProjects = client.projects as Record<string, ReturnType<typeof vi.fn>>
const mockTasks = client.tasks as Record<string, ReturnType<typeof vi.fn>>

const fakeProject: ProjectDetail = {
  id: 1, name: 'Alpha', description: null, status: 'active',
  target_date: null, created_at: null, updated_at: null, milestones: [],
  my_watch_tier: null,
}
const fakeMembers: ProjectMember[] = []

function renderProject(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/projects/1${search}`]}>
      <Routes>
        <Route path="/projects/:id" element={<Project />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mockProjects.get.mockResolvedValue(fakeProject)
  mockProjects.listMembers.mockResolvedValue(fakeMembers)
  mockTasks.list.mockResolvedValue([])
})
```

to:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import Project from './Project'
import { AuthProvider } from '../contexts/AuthContext'
import * as client from '../api/client'
import type { ProjectDetail, ProjectMember, User } from '../types'

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    auth: { me: vi.fn() },
    projects: { get: vi.fn(), listMembers: vi.fn() },
    tasks: { list: vi.fn() },
    milestones: {},
    watches: { set: vi.fn(), remove: vi.fn() },
    users: { list: vi.fn() },
  }
})

const mockAuth = client.auth as Record<string, ReturnType<typeof vi.fn>>
const mockProjects = client.projects as Record<string, ReturnType<typeof vi.fn>>
const mockTasks = client.tasks as Record<string, ReturnType<typeof vi.fn>>
const mockUsers = client.users as Record<string, ReturnType<typeof vi.fn>>

const fakeUser: User = { id: 1, username: 'testuser', email: 'test@example.com', created_at: null }
const fakeProject: ProjectDetail = {
  id: 1, name: 'Alpha', description: null, status: 'active',
  target_date: null, created_at: null, updated_at: null, milestones: [],
  my_watch_tier: null,
}
const fakeMembers: ProjectMember[] = []

function renderProject(search = '') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/projects/1${search}`]}>
        <Routes>
          <Route path="/projects/:id" element={<Project />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mockAuth.me.mockResolvedValue(fakeUser)
  mockProjects.get.mockResolvedValue(fakeProject)
  mockProjects.listMembers.mockResolvedValue(fakeMembers)
  mockTasks.list.mockResolvedValue([])
  mockUsers.list.mockResolvedValue([])
})
```

- [ ] **Step 3: Add a test for the new tab**

Add to the end of `frontend/src/pages/Project.test.tsx`:

```tsx
test('switching to members tab sets aria-selected', async () => {
  const user = userEvent.setup()
  renderProject()
  await waitFor(() => screen.getByText('Alpha'))
  await user.click(screen.getByRole('tab', { name: /members/i }))
  expect(screen.getByRole('tab', { name: /members/i })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: /list/i })).toHaveAttribute('aria-selected', 'false')
})
```

- [ ] **Step 4: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all tests pass (existing `Project.test.tsx` tests plus the new one, plus Task 4's `MembersTab.test.tsx`), and the production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Project.tsx frontend/src/pages/Project.test.tsx
git commit -m "feat: add Members tab to the project page"
```

This closes out the feature — a project owner can now add, remove, and change the role of members entirely through the UI.
