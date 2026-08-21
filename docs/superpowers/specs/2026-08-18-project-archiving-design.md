# Project Archiving — Design

**Date:** 2026-08-18
**Scope:** Give the UI a way to transition a project between `active` and `archived` status, and hide archived projects from the Dashboard by default (with a toggle to show them). Motivated by projects like a past camping trip that no longer need to clutter the dashboard but shouldn't be deleted.
**Stack assumption:** Rust/Axum/SQLite backend, React 19/Vite CSR frontend (see `docs/deployment-brief.md`).

---

## 1. Goals

- A project owner can archive a project from its own page, and reactivate it later from the same control.
- Archived projects are hidden from the Dashboard's main grid by default, but remain fully reachable (direct navigation, and a Dashboard toggle to include them in the grid).
- No data loss, no destructive action — archiving only ever changes `projects.status`.

## Non-goals

- **Confirmation dialogs** — archiving/reactivating is immediate and unconfirmed, consistent with this app's existing convention of immediate per-field saves (milestones, tasks, project name/description edits all save without a confirm step). It's also fully reversible via the same control.
- **Persisting the Dashboard's "show archived" toggle** — it resets to hidden on every page load. No `localStorage`, no backend preference.
- **Bulk archiving, auto-archiving (e.g. by target date), or any scheduled/background status transition** — this is a manual, one-project-at-a-time, user-initiated action only.
- **Changing who can view an archived project** — visibility/membership rules are unaffected by status; only the Dashboard's default filtering changes.

---

## 2. Data model

No schema changes. `projects.status` already exists (`ProjectStatus` enum: `active` | `archived`), and `PATCH /api/projects/:id` (`UpdateProjectRequest.status: Option<ProjectStatus>`) already persists it. This feature is entirely about exposing and gating a capability that already exists at the data layer.

## 3. Backend: owner-gated status transitions, one endpoint

Today there are two ways to reach `projects.status`, with inconsistent permissions:
- `PATCH /api/projects/:id` (`update_project`) accepts `status` alongside other fields, gated only by `require_writer`.
- `DELETE /api/projects/:id` (`archive_project`) is a one-way archive shortcut, gated by `require_owner`.

Neither is currently called from the frontend — this feature is the first UI consumer of either.

**Change:** in `src/routes/projects.rs::update_project`, after the existing `require_writer(...)` call, add a second check — if `payload.status.is_some()`, additionally call `require_owner(&state.pool, project_id, user.id).await?`. Non-status fields (`name`, `description`, `target_date`) remain writer-editable as today; a request that includes `status` requires the caller to be an owner, regardless of what else is in the payload.

`DELETE /api/projects/:id` and its `archive_project` handler are removed — once `PATCH` covers both `active → archived` and `archived → active` under the same (owner-only) permission rule, the DELETE shortcut is fully redundant, and leaving it in place would mean two divergent code paths that do the same thing. The route is dropped from `src/routes/mod.rs` alongside the handler.

## 4. Frontend: Project page control

A small control in `Project.tsx`'s header (near the title, alongside `WatchToggle`/`InstallLink`), visible only to the project's owner:

- Ownership check follows the exact pattern already used in `MembersTab.tsx`: `members.find(m => m.user_id === currentUser?.id)?.role === 'owner'`, using `useAuth()` for the current user and the `members` list already loaded via `ProjectContext`.
- If `project.status === 'active'`: renders an "Archive" button. Clicking calls a new `updateProject` action on `ProjectContext` (mirroring the existing `updateMilestone`/`updateTask` actions) with `{ status: 'archived' }`, via `projects.update(projectId, ...)` (already exists in `api/client.ts`).
- If `project.status === 'archived'`: renders a "Reactivate" button in the same spot, calling the same action with `{ status: 'active' }`.
- Non-owners (including writers and viewers) see neither button — the control doesn't render at all for them, rather than rendering disabled.

## 5. Frontend: Dashboard filtering

`Dashboard.tsx` already fetches the caller's full project list via `projectsApi.list()` (no backend filtering) — this stays a client-side concern:

- New `showArchived` state, default `false`, not persisted.
- A toggle (checkbox, labeled "Show archived") placed in the header row next to the existing "New Project" button.
- The grid renders `items.filter(item => showArchived || item.status !== 'archived')` in place of the current unfiltered `items.map(...)`.
- The existing status badge (already renders "active" styled green, anything else styled neutral) is unchanged — it's how an archived project is distinguished from an active one when the toggle is on.

## 6. Testing

- **Backend:** unit/handler-level test that a writer (non-owner) sending `PATCH /api/projects/:id` with a `status` field is rejected (403/appropriate `AppError`), while the same writer can still successfully update `name`/`description`/`target_date` in a request that omits `status`. A separate test confirms an owner's status-only PATCH succeeds and persists.
- **Frontend:** component tests for the Project page control — following the existing `WatchToggle.test.tsx`/`MembersTab.test.tsx` convention (mocking `api/client`, rendering with a given `members`/`currentUser` combination) — asserting the button is absent for non-owners, shows "Archive" when active and "Reactivate" when archived, and calls `projects.update` with the right payload on click. A `Dashboard.test.tsx` addition asserts archived projects are excluded by default and included once the toggle is checked.

## 7. Ops

No new services, no schema changes, no deployment-tooling changes.
