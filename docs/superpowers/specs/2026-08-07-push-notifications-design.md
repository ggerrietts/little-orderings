# Push Notifications for Watched Projects — Design

**Date:** 2026-08-07
**Scope:** Let any project member opt in to push notifications when a project they've watched changes, delivered via Web Push to an installed PWA. Originally motivated by wanting the user's wife notified on her iPhone, generalized into a feature any member can use for any project.
**Stack assumption:** Rust/Axum/SQLite backend, React 19/Vite CSR frontend, single-origin production deploy behind Caddy at `todo.gerrietts.net` (see `docs/deployment-brief.md`). No existing notification system, background job runner, or PWA scaffolding.

---

## 1. Goals

- A project member can "watch" a project they belong to, at one of three granularity levels, and receive a push notification on their phone (or any device with the installed app) when matching activity happens.
- Works on iPhone (the original motivating case) without requiring an Apple Developer Program account, Xcode, or an App Store listing.
- Fits the app's existing shape: single Rust binary, single SQLite file, no new services, no background workers.

## Non-goals

- **Digest/batched notifications** (e.g., "3 tasks completed in the last 5 minutes" as one push) — replaced by the simpler pending-flag debounce in §4, which needs no scheduler.
- **Notification content specificity** — pushes are intentionally generic ("*Project X* has updates"), not per-field descriptions. See §4 for why.
- **Non-iPhone platforms as a design target** — Android and desktop Chromium browsers get real push support "for free" from the standard Web Push implementation described here (and desktop/Android installability is handled naturally by `<InstallLink />`, §7), but they aren't the motivating case and haven't been manually verified on real hardware.
- **Retry/queueing for failed push sends** — a failed send is logged and dropped; see §8.

---

## 2. Data model

Two new tables:

```sql
CREATE TABLE project_watches (
    project_id   INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    tier         TEXT NOT NULL DEFAULT 'task_milestones',  -- task_milestones | milestones | all
    notified_at  DATETIME,   -- NULL = no push pending; set when a push is sent,
                              -- cleared when the user opens this project's page
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id) ON DELETE CASCADE
);

CREATE TABLE push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh_key  TEXT NOT NULL,
    auth_key    TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

`project_watches` has a compound foreign key into `project_members` (not separately into `projects`/`users`) — this makes it structurally impossible to watch a project you're not a member of, and membership removal cascades the watch away automatically.

`push_subscriptions` is keyed per-device, independent of `project_watches` — one user can have multiple subscriptions (e.g. phone + iPad), and all of them receive every push that user's watches trigger.

## 3. Event taxonomy

Three cumulative (nested) tiers, narrowest to broadest:

1. **`task_milestones`** — task created; task status changed *to* `done`
2. **`milestones`** — everything in (1), plus milestone created / updated / deleted
3. **`all`** — everything in (2), plus project metadata edits (including archive), project membership changes, task field edits, task delete, task assign/unassign

A watcher on tier N sees all events at tiers ≤ N. A watcher's `tier` column stores the broadest tier they've opted into.

**Explicit exclusions:**
- **Reorder actions (`PATCH .../reorder` endpoints) never trigger notifications, at any tier, including `all`.** Drag-to-reorder is presentation, not content change.
- **Notification bodies are always generic** (e.g. "*Kitchen Remodel* has updates"), never field-specific. Because of the debounce in the next section, a specific message risks going stale if more matching changes land before the watcher looks — generic is honest regardless of how much has piled up.

## 4. Notification triggering (debounce mechanism)

No background scheduler. Debounce works via the `notified_at` column on `project_watches`:

- When a qualifying mutation happens (event tier ≤ watcher's tier) **and** `notified_at IS NULL` for that watcher, send a push and set `notified_at = now()`.
- Further qualifying events for that project, for that watcher, are silently skipped (no second push) as long as `notified_at` stays non-null — this is the debounce.
- `notified_at` is cleared back to `NULL` when that specific user opens that specific project's page (`GET /api/projects/:id`), re-arming the watch for the next change.

This means: at most one pending, un-acknowledged push per watched project per user, at any time.

## 5. Backend flow

A new `src/notifications.rs` module exposes:

```rust
async fn notify_watchers(pool: &Pool, project_id: i64, event_tier: Tier) -> Result<()>
```

Called at the end of each mutating handler, **after** its transaction commits — never inside the transaction, so a slow or failed push send can never roll back the actual data change. It selects `project_watches` rows for that project where `notified_at IS NULL` and the watcher's `tier` is broad enough to include `event_tier` (per §3's nesting), and for each match: loads that user's `push_subscriptions`, sends a push to each (see §8 for failure handling), and sets `notified_at = now()`.

Every mutating handler across `projects.rs` / `milestones.rs` / `tasks.rs` gets one added call to `notify_watchers(...)` with the appropriate `Tier`, except the reorder endpoints (§3) and read-only routes — roughly 8 call sites.

**New API routes:**
- `PUT /api/projects/:id/watch` `{ tier }` — upsert the caller's watch (also implicitly usable to change tier)
- `DELETE /api/projects/:id/watch` — unwatch
- `POST /api/push-subscriptions` — register a subscription (endpoint + keys) for the logged-in user
- `DELETE /api/push-subscriptions` — remove one, by endpoint (e.g. when notifications are turned off browser-side)

`GET /api/projects/:id` gains a side effect: if the requesting user has a `project_watches` row with non-null `notified_at`, clear it (§4). This is a read endpoint causing a write — a deliberate, minor REST-purity break, since it's the only natural hook for "she opened the project page."

## 6. Secrets & key management

Web Push requires a VAPID keypair: the private key signs outgoing push requests server-side (a real secret); the public key is embedded in the frontend at build time (not secret — it's sent in the clear on every subscribe call). Concretely: **committed as a plain constant in frontend source** (e.g. `frontend/src/config.ts`), not threaded through CI as a build arg. `build-and-push.yml` doesn't currently pass any build-time configuration into the image, and this app doesn't anticipate rotating the VAPID key often enough to justify adding that machinery — rotating it later just means a source change and a rebuild, same as any other constant.

- **New backend CLI subcommand**, alongside the existing `user create`/`list`/etc: `little-orderings vapid generate`, printing `VAPID_PUBLIC_KEY=...` / `VAPID_PRIVATE_KEY=...`. Uses the `web-push` crate's key generation (VAPID keys are P-256 EC keys in a specific base64url encoding, not a plain `openssl rand` value). `SESSION_SECRET` generation is unaffected — stays exactly as documented today (`openssl rand -base64 32`).
- **`deploy/prod.env`** (new, gitignored) becomes the local durable copy of the server's real `.env`. Bootstrapped once via a documented manual command — `scp todo:little-orderings/.env deploy/prod.env` — then appended with the freshly generated `VAPID_*` lines.
- **`deploy/admin.sh push-env`** (new, separate from `sync`) — `scp`s `deploy/prod.env` → the server's `.env`, `chmod 600` remotely after transfer. Kept deliberately separate from the existing `sync` command (which pushes `docker-compose.prod.yml`/`Caddyfile`/`.env.example` and is safe to run casually): overwriting server secrets from a stale local file is a worse failure mode than overwriting a Caddyfile, so pushing `.env` stays an explicit, separate action.
- **`.env.example`** gains empty, documented `VAPID_PUBLIC_KEY=` / `VAPID_PRIVATE_KEY=` entries, matching the existing `SESSION_SECRET=` pattern — so a real prod `.env`'s shape stays discoverable from the public repo without containing any actual secret.

This is orthogonal to the repo's existing "keep it generic" tradeoffs (e.g. the Hetzner volume ID default, deliberately left in `docs/deployment-brief.md` §9) — those are non-secret portability questions; VAPID/session secrets are a hard security boundary regardless of how personal the repo already is.

## 7. Frontend flow

**PWA installability:** `manifest.json` (name, icons, `display: standalone`), plus an `apple-touch-icon` link tag and `apple-mobile-web-app-capable` meta tag for iOS, which predates/ignores parts of the manifest spec.

**Service worker:** registered once on app load (`main.tsx`). Two handlers: `push` (calls `self.registration.showNotification(...)` with the generic message from §3) and `notificationclick` (focuses/opens the app at that project's `/projects/:id` URL — no new routing needed).

**`<InstallLink />`** — one small shared component, rendered in the existing per-page header markup in both `Dashboard.tsx` and `Project.tsx` (there's no shared nav/header component yet; each page currently rolls its own, consistent with the nav rework already planned separately). Visibility and behavior split on which installability signal is available:
- If the `beforeinstallprompt` event fired (captured and stashed early in app lifecycle) — Chromium-based browsers, desktop or Android — show the link; clicking it calls the stashed `deferredPrompt.prompt()`, a real native install dialog.
- Else, if Safari on a touch/mobile UA (iOS/iPadOS never fires `beforeinstallprompt` and exposes no installability API at all) and not already standalone (`navigator.standalone !== true`) — show the link; clicking it opens a small explainer ("Tap the Share icon, then Add to Home Screen"), since there's no programmatic install trigger available.
- Otherwise (already standalone, or desktop Safari, which doesn't support installable PWAs) — hidden.

Install is always a deliberate, user-initiated action — the link is never auto-shown as a nudge tied to enabling a watch or any other action.

**Watch toggle UI:** on `Project.tsx`, near the existing member/role controls — a toggle plus tier picker, calling the `PUT`/`DELETE /api/projects/:id/watch` routes from §5.

**Notification permission:** turning a watch on triggers `Notification.requestPermission()` → `pushManager.subscribe()` → `POST /api/push-subscriptions`, regardless of install state (this is a real, programmatic browser API, unlike the install trigger, so it doesn't need the same "always a separate deliberate action" treatment). If permission is denied, the watch preference still saves — it's a separate concern from whether a working subscription exists — she just won't receive pushes until the browser permission changes.

## 8. Error handling

Push sends happen after the triggering request's transaction commits (§5) and never affect that request's outcome. Per-subscription:
- A `404`/`410` response from the push service means that subscription is dead (app uninstalled, OS revoked it, etc.) — delete the row.
- Any other failure (network error, `5xx`) is logged and dropped. No retry queue — consistent with this app's no-background-worker, personal-scale design.

## 9. Testing

The repo's only existing backend test is a single `#[test]` in `models.rs`; there's no established integration-test harness for routes. This design doesn't introduce one. Scoped to what's cheaply testable:
- **Backend:** unit tests for the tier-nesting comparison logic (pure function, no DB).
- **Frontend:** component tests for `<InstallLink />` and the watch toggle, following the existing per-component Vitest/RTL convention (e.g. `Project.test.tsx`), mocking `beforeinstallprompt` / `Notification` / service worker registration, none of which jsdom supports natively.
- **Manual:** actual push delivery to a real iPhone isn't automatable — final verification is manual, on-device, once, at the end of implementation.

## 10. Ops

No new services, no background jobs — fits the existing single-binary/single-container production model unchanged. Deployment-tooling deltas (`vapid generate` CLI subcommand, `deploy/admin.sh push-env`, `.env.example` additions from §6) get folded into `docs/deployment-brief.md` during implementation, not as part of this spec.
