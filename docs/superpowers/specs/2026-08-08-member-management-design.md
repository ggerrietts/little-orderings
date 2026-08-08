# Project Member Management UI — Design

**Date:** 2026-08-08
**Scope:** Let project owners add, remove, and change the role of project members through the UI. The backend already fully supports membership (`project_members` table, `add_member`/`remove_member`/`list_members` routes) but nothing in the frontend ever calls `addMember`/`removeMember`, and there's no way to change a member's role at all today.
**Stack assumption:** Rust/Axum/SQLite backend, React 19/Vite CSR frontend (Little Orderings). Builds on the existing project/milestone/task CRUD patterns and the `WatchToggle`/`InlineEdit` UI conventions established in prior features.

---

## 1. Goals

- A project owner can add any existing user to the project, at a chosen role.
- A project owner can change a member's role, or remove them, from the UI.
- Non-owner members can see who's on the project (read-only) but can't manage membership.
- The last remaining owner can't be demoted or removed, in the UI same as it already is at the API layer.

## Non-goals

- **User creation/invitation.** Users are still created via the existing `little-orderings user create` CLI only — this feature only manages *membership* of already-existing accounts, not account creation or email invites.
- **Search/pagination on the user picker.** The user base is small and trusted (self-hosted, family-scale); the add-member picker lists every non-member user directly, no search-as-you-type.
- **Per-role permission editing.** The three roles (`owner`/`member`/`viewer`) and what each can do are unchanged — this feature only lets you assign an existing role, not define new ones or edit their meaning.

---

## 2. Backend additions

### `GET /api/users`

Returns every user's `id`, `username`, `email` (no `password_hash` — same shape `GET /api/auth/me` already returns via the existing `User` struct's `#[serde(skip)]`). Requires only that the caller is authenticated (`AuthUser`), no further authorization — in this app's trust model, any logged-in user already knows who else has an account.

Implementation reuses the existing `auth::list_users(pool)` function (already used by the `user list` CLI subcommand) — the HTTP handler is a thin wrapper, no duplicated query. Lives in a new `src/routes/users.rs`, registered as `GET /api/users`.

### `PATCH /api/projects/:id/members/:user_id`

Body: `{ "role": string }`. Gated by `require_owner`, matching `add_member`/`remove_member`.

Must carry the same last-owner protection `remove_member` already has, extended to cover demotion (not just removal): reject the change only when the target's *current* role is `owner`, the *new* role is not `owner`, and they're the project's only owner. Implemented as one atomic `UPDATE ... WHERE ...` with the guard in the `WHERE` clause — mirroring `remove_member`'s existing style exactly, to avoid a check-then-act race:

```sql
UPDATE project_members
SET role = ?1
WHERE project_id = ?2 AND user_id = ?3
  AND (role != 'owner' OR ?1 = 'owner'
       OR (SELECT COUNT(*) FROM project_members WHERE project_id = ?2 AND role = 'owner') > 1)
```

If zero rows are affected, a follow-up query (same pattern as `remove_member`) distinguishes "not a member" (404) from "last owner, can't demote" (403).

`role` stays a plain `String` in the new request struct (no new enum), matching `AddMemberRequest.role`'s existing convention. Note this convention has no validation today — `add_member` accepts any string as a role (no DB constraint, no enum check; `owner`/`member`/`viewer` is an established-by-convention set, not an enforced one) — the new PATCH route inherits that same pre-existing looseness rather than introducing new validation as part of this feature.

---

## 3. Frontend data flow

**API client (`frontend/src/api/client.ts`):**
- New `users` export: `list()` → `GET /api/users`.
- `projects` gains `updateMemberRole(projectId, userId, role)` → `PATCH /api/projects/:id/members/:user_id`. (`addMember`/`removeMember` already exist in the client, just never called.)

**`ProjectContext`** gains three actions, following the existing `addMilestone`/`deleteMilestone` pattern (call the API, then update local `members` state directly — no refetch):
- `addMember(userId, role)` → appends the new row to `members`
- `removeMember(userId)` → filters it out of `members`
- `updateMemberRole(userId, role)` → maps the matching row's `role` in place

**Determining whether the current user can manage members:** no new state. Cross-reference the already-fetched `members` array against `useAuth().user.id` to find the current user's own row and read its `role`; if `'owner'`, render the management controls, otherwise render read-only. This is a derived value computed where needed (in `MembersTab`), not threaded through context.

---

## 4. UI / components

**New `frontend/src/components/MembersTab.tsx`**, rendered by `Project.tsx` as a third tab alongside List/Kanban — extending the existing `VIEWS` array and the `view === X ? ... : ...` render branch (same `role="tablist"` mechanism already in place, no new UI paradigm).

**Member rows:** username, email, role. For an owner, role renders as a `<select>` that fires `updateMemberRole` on change directly (no separate edit-mode toggle needed — a `<select>` is inherently interactive, unlike the text fields `InlineEdit` wraps), plus a "Remove" button. For a non-owner, role renders as a static badge with no controls.

**Add-member section (owner-only):** fetches `GET /api/users` when the tab mounts, filters out users already present in `members`, and shows a `<select>` of the remaining users, a role `<select>` (defaulting to `member`), and an "Add" button calling `addMember`. If every user is already a member, this section doesn't render a picker at all (nothing left to add) rather than showing an empty one.

---

## 5. Error handling & edge cases

- **Demoting/removing the last owner:** rejected by the backend's atomic guard (§2) with 403. The frontend shows an inline error near the control that triggered it (the role `<select>` reverts to its prior value / the remove action surfaces a brief message) — consistent with this app's existing lightweight inline-error handling (e.g. `Dashboard.tsx`), not a modal or toast system.
- **Duplicate add:** prevented by construction — the picker only ever lists non-members. The backend's existing 400 ("already a member") is the fallback if two owners race to add the same user.
- **Self-removal:** allowed, not special-cased. The backend doesn't distinguish "removing yourself" from "removing someone else" except via the last-owner guard, so "leave this project" falls out for free — an owner can remove their own row like anyone else's, blocked only if they're the sole remaining owner.
- **Non-owner viewing the tab:** read-only list, no add section, no role/remove controls. Enforced both client-side (conditional rendering in `MembersTab`) and server-side (existing `require_owner`/`require_member` gating on every mutating route) — the UI hiding controls is never the only thing preventing an unauthorized change.

---

## 6. Testing

Component test for `MembersTab.tsx`, following the existing `WatchToggle.test.tsx` convention: mock the API client, assert `addMember`/`removeMember`/`updateMemberRole` are called with the right arguments on the right interactions, and assert the read-only rendering path when the current user's role isn't `owner`.

No new Rust route-level tests — matches this codebase's existing convention (there's no route-level test harness yet; `GET /api/users` is exercised indirectly through reuse of the already-used `auth::list_users` function, and the `PATCH` route's guard logic mirrors `remove_member`'s already-shipped, unreviewed-by-automated-test pattern).
