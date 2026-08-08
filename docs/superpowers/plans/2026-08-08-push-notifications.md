# Push Notifications for Watched Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any project member opt in to push notifications, at one of three granularity tiers, delivered via Web Push to an installed PWA, when a project they watch changes.

**Architecture:** Two new SQLite tables (`project_watches`, `push_subscriptions`). A `notify_watchers()` function called from every mutating route handler (except reorders) after its transaction commits, which debounces via a `notified_at` flag cleared when the watcher reopens the project page. Frontend gains PWA installability (manifest, service worker, an install affordance that adapts to Chromium vs Safari), a watch-tier toggle, and push subscription registration.

**Tech Stack:** Rust/Axum/SQLite backend (`web-push` crate for sending, `p256`/`ct-codecs` for VAPID key generation), React 19/Vite CSR frontend, Vitest/RTL for frontend tests.

**Spec:** `docs/superpowers/specs/2026-08-07-push-notifications-design.md`

## Global Constraints

- Tier values are exactly three, cumulative/nested: `task_milestones` < `milestones` < `all` (spec §3).
- Reorder endpoints (`PATCH /milestones/:id/reorder`, `PATCH /tasks/:id/reorder`) never trigger notifications, at any tier (spec §3).
- Notification bodies are always generic (`"<Project Name> has updates"`), never field-specific (spec §3).
- Push sends happen strictly after the triggering transaction commits, and never affect that request's outcome (spec §5, §8).
- `deploy/prod.env` (gitignored) is the only place real secrets live locally; `.env.example` documents shape only, never values (spec §6).
- Every Rust task ends with `cargo build` and (where relevant) `cargo test` passing. Every frontend task ends with `cd frontend && npm test && npm run build` passing (matches existing repo convention — see `docs/superpowers/plans/2026-06-27-theming.md`).
- Commit after each task — do not batch commits.

---

## File Map

**Backend — created:**
- `migrations/005_push_notifications.sql` — `project_watches`, `push_subscriptions` tables (Task 1)
- `src/notifications.rs` — tier logic + `notify_watchers()` push-send (Tasks 1–2)
- `src/routes/push_subscriptions.rs` — subscription CRUD handlers (Task 4)
- `src/routes/watches.rs` — project watch CRUD handlers (Task 5)

**Backend — modified:**
- `Cargo.toml` — add `web-push`, `p256`, `ct-codecs` (Task 2)
- `src/models.rs` — add `Tier`, `SetWatchRequest`, `CreatePushSubscriptionRequest`, `DeletePushSubscriptionRequest`; extend `ProjectDetail` with `my_watch_tier` (Tasks 1, 5)
- `src/main.rs` — add `vapid generate` CLI subcommand (Task 3)
- `src/routes/mod.rs` — register new routes (Tasks 4, 5)
- `src/routes/projects.rs` — `get_project` gains watch-state read + pending-clear side effect (Task 5); `update_project`/`archive_project`/`add_member`/`remove_member` call `notify_watchers` (Task 6)
- `src/routes/milestones.rs` — `create_milestone`/`update_milestone`/`delete_milestone` call `notify_watchers` (Task 7)
- `src/routes/tasks.rs` — `create_task`/`update_task`/`delete_task`/`assign_user`/`unassign_user` call `notify_watchers` (Task 8)

**Frontend — created:**
- `frontend/public/manifest.json`, `frontend/public/icon-192.png`, `frontend/public/icon-512.png`, `frontend/public/apple-touch-icon.png` (Task 9)
- `frontend/public/sw.js` — service worker (Task 10)
- `frontend/src/serviceWorkerRegistration.ts` (Task 10)
- `frontend/src/config.ts` — `VAPID_PUBLIC_KEY` constant (Task 11)
- `frontend/src/push.ts` — subscribe-to-push helper (Task 14)
- `frontend/src/components/InstallLink.tsx` + `.test.tsx` (Task 12)
- `frontend/src/components/WatchToggle.tsx` + `.test.tsx` (Task 14)

**Frontend — modified:**
- `frontend/index.html` — manifest link, apple meta tags (Task 9)
- `frontend/src/main.tsx` — register service worker (Task 10)
- `frontend/src/api/client.ts` — add `watches`, `pushSubscriptions` (Task 11)
- `frontend/src/pages/Dashboard.tsx` — render `<InstallLink />` (Task 13)
- `frontend/src/pages/Project.tsx` — render `<InstallLink />` and `<WatchToggle />` (Tasks 13, 14)
- `frontend/src/contexts/ProjectContext.tsx` — expose `projectId` (Task 14)

**Deploy tooling — modified:**
- `.env.example` — add `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (Task 15)
- `.gitignore` — add `deploy/prod.env` (Task 15)
- `deploy/admin.sh` — add `push-env` subcommand (Task 15)

**Not modified:** `Dockerfile`, `docker-compose*.yml`, `Caddyfile`, `deploy/provision-server.sh`, all existing tests other than where noted, all theming/styling tokens.

---

## Task 1: Data model foundation — migration, `Tier` enum, tier-nesting logic

**Files:**
- Create: `migrations/005_push_notifications.sql`
- Modify: `src/models.rs`
- Create: `src/notifications.rs`
- Modify: `src/main.rs:1-5` (add `mod notifications;`)
- Test: inline `#[cfg(test)] mod tests` in `src/notifications.rs`

**Interfaces:**
- Produces: `crate::models::Tier` enum (`TaskMilestones`, `Milestones`, `All`), with `as_str(&self) -> &'static str` and `from_str_opt(s: &str) -> Option<Tier>`. `crate::notifications::tier_covers(watcher_tier: Tier, event_tier: Tier) -> bool`.

- [ ] **Step 1: Write the migration**

Create `migrations/005_push_notifications.sql`:

```sql
-- Push notification watches and subscriptions.

CREATE TABLE project_watches (
    project_id   INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    tier         TEXT NOT NULL DEFAULT 'task_milestones',
    notified_at  DATETIME,
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

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
```

- [ ] **Step 2: Add the `Tier` enum to `src/models.rs`**

Add after the `TaskPriority` block (after line 117, before the `// ── Projects ──` section):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    TaskMilestones,
    Milestones,
    All,
}

impl Tier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::TaskMilestones => "task_milestones",
            Tier::Milestones => "milestones",
            Tier::All => "all",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Tier> {
        match s {
            "task_milestones" => Some(Tier::TaskMilestones),
            "milestones" => Some(Tier::Milestones),
            "all" => Some(Tier::All),
            _ => None,
        }
    }
}
```

Declaration order matters here: deriving `Ord` on a field-less enum ranks variants by declaration order, so `TaskMilestones < Milestones < All` falls out for free and matches the spec's nesting exactly.

Add `SetWatchRequest` to the `// ── Notifications ──` section — add this new section after the `AddMemberRequest` struct (after line 214, before `// ── Milestones ──`):

```rust
// ── Notifications ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SetWatchRequest {
    pub tier: Tier,
}

#[derive(Debug, Deserialize)]
pub struct CreatePushSubscriptionRequest {
    pub endpoint: String,
    pub p256dh_key: String,
    pub auth_key: String,
}

#[derive(Debug, Deserialize)]
pub struct DeletePushSubscriptionRequest {
    pub endpoint: String,
}
```

- [ ] **Step 3: Export `Tier` to TypeScript**

In `src/models.rs`, inside `mod type_export`'s `export_types` test (around line 349), add after the existing enum exports:

```rust
        TaskPriority::export_all_to(dir).unwrap();
        Tier::export_all_to(dir).unwrap();
```

- [ ] **Step 4: Create `src/notifications.rs` with tier-nesting logic and a failing test**

```rust
use crate::models::Tier;

pub fn tier_covers(watcher_tier: Tier, event_tier: Tier) -> bool {
    watcher_tier >= event_tier
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broader_tier_covers_narrower_events() {
        assert!(tier_covers(Tier::All, Tier::TaskMilestones));
        assert!(tier_covers(Tier::All, Tier::Milestones));
        assert!(tier_covers(Tier::All, Tier::All));
        assert!(tier_covers(Tier::Milestones, Tier::TaskMilestones));
        assert!(tier_covers(Tier::Milestones, Tier::Milestones));
        assert!(tier_covers(Tier::TaskMilestones, Tier::TaskMilestones));
    }

    #[test]
    fn narrower_tier_does_not_cover_broader_events() {
        assert!(!tier_covers(Tier::TaskMilestones, Tier::Milestones));
        assert!(!tier_covers(Tier::TaskMilestones, Tier::All));
        assert!(!tier_covers(Tier::Milestones, Tier::All));
    }
}
```

- [ ] **Step 5: Register the module**

In `src/main.rs`, change line 1-4 from:

```rust
mod auth;
mod db;
mod error;
mod models;
mod routes;
```

to:

```rust
mod auth;
mod db;
mod error;
mod models;
mod notifications;
mod routes;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test tier_covers`
Expected: both tests in `src/notifications.rs` PASS. (`cargo test export_types` also still passes and regenerates `frontend/src/types/Tier.ts`.)

- [ ] **Step 7: Commit**

```bash
git add migrations/005_push_notifications.sql src/models.rs src/notifications.rs src/main.rs frontend/src/types/Tier.ts
git commit -m "feat: add push notification data model and tier-nesting logic"
```

---

## Task 2: `notify_watchers()` — push-sending via the `web-push` crate

**Files:**
- Modify: `Cargo.toml`
- Modify: `src/notifications.rs`

**Interfaces:**
- Consumes: `crate::models::Tier`, `crate::notifications::tier_covers` from Task 1.
- Produces: `pub async fn notify_watchers(pool: &SqlitePool, project_id: i64, event_tier: Tier)` — fire-and-forget; never returns an error, logs and swallows all failures per spec §8. This is what every mutating handler in Tasks 6–8 calls.

- [ ] **Step 1: Add dependencies**

In `Cargo.toml`, add to `[dependencies]` (after `rand = "0.8"`):

```toml
web-push = "0.11"
p256 = "0.14"
ct-codecs = "1.1.3"
```

- [ ] **Step 2: Run `cargo build` to confirm the new dependencies resolve**

Run: `cargo build`
Expected: succeeds (downloads and compiles `web-push`, `p256`, `ct-codecs`, and their transitive deps). If `p256`/`ct-codecs` versions conflict with what `web-push` pulls in transitively, `cargo` will report the conflicting version requirements — bump the pinned version in `Cargo.toml` to match what `cargo tree -p web-push` shows for those two crates.

- [ ] **Step 3: Implement `notify_watchers` in `src/notifications.rs`**

Append to `src/notifications.rs` (after the existing `tier_covers` function, before the `#[cfg(test)]` block):

```rust
use sqlx::SqlitePool;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

#[derive(Debug, sqlx::FromRow)]
struct Watcher {
    user_id: i64,
    tier: String,
}

#[derive(Debug, sqlx::FromRow)]
struct Subscription {
    id: i64,
    endpoint: String,
    p256dh_key: String,
    auth_key: String,
}

/// Notifies every eligible watcher of `project_id` that the project changed.
///
/// Must be called only after the triggering mutation's transaction commits —
/// a slow or failed push send must never roll back the actual data change.
/// Failures are logged and swallowed; there is no retry queue (spec §8).
pub async fn notify_watchers(pool: &SqlitePool, project_id: i64, event_tier: Tier) {
    let project_name: Option<(String,)> =
        sqlx::query_as("SELECT name FROM projects WHERE id = ?")
            .bind(project_id)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
    let Some((project_name,)) = project_name else {
        return;
    };

    let watchers: Vec<Watcher> = match sqlx::query_as(
        "SELECT user_id, tier FROM project_watches WHERE project_id = ? AND notified_at IS NULL",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("failed to load watchers for project {project_id}: {e}");
            return;
        }
    };

    for watcher in watchers {
        let Some(tier) = Tier::from_str_opt(&watcher.tier) else {
            continue;
        };
        if !tier_covers(tier, event_tier) {
            continue;
        }
        notify_one_watcher(pool, project_id, watcher.user_id, &project_name).await;
    }
}

async fn notify_one_watcher(pool: &SqlitePool, project_id: i64, user_id: i64, project_name: &str) {
    let subscriptions: Vec<Subscription> = match sqlx::query_as(
        "SELECT id, endpoint, p256dh_key, auth_key FROM push_subscriptions WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("failed to load subscriptions for user {user_id}: {e}");
            return;
        }
    };

    if !subscriptions.is_empty() {
        send_to_subscriptions(pool, project_id, project_name, subscriptions).await;
    }

    let _ = sqlx::query(
        "UPDATE project_watches SET notified_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND user_id = ?",
    )
    .bind(project_id)
    .bind(user_id)
    .execute(pool)
    .await;
}

async fn send_to_subscriptions(
    pool: &SqlitePool,
    project_id: i64,
    project_name: &str,
    subscriptions: Vec<Subscription>,
) {
    let vapid_private_key = match std::env::var("VAPID_PRIVATE_KEY") {
        Ok(k) => k,
        Err(_) => {
            tracing::warn!("VAPID_PRIVATE_KEY not set, skipping push send");
            return;
        }
    };

    let client = match IsahcWebPushClient::new() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("failed to build web push client: {e}");
            return;
        }
    };

    let payload = serde_json::json!({
        "title": "Little Orderings",
        "body": format!("{project_name} has updates"),
        "url": format!("/projects/{project_id}"),
    });
    let payload_bytes = match serde_json::to_vec(&payload) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("failed to serialize push payload: {e}");
            return;
        }
    };

    for sub in subscriptions {
        let subscription_info = SubscriptionInfo::new(
            sub.endpoint.clone(),
            sub.p256dh_key.clone(),
            sub.auth_key.clone(),
        );

        let sig_builder =
            match VapidSignatureBuilder::from_base64(&vapid_private_key, &subscription_info) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("failed to build VAPID signature builder: {e}");
                    continue;
                }
            };
        let vapid_signature = match sig_builder.build() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("failed to sign VAPID claims: {e}");
                continue;
            }
        };

        let mut builder = WebPushMessageBuilder::new(&subscription_info);
        builder.set_payload(ContentEncoding::Aes128Gcm, &payload_bytes);
        builder.set_vapid_signature(vapid_signature);

        let message = match builder.build() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("failed to build push message: {e}");
                continue;
            }
        };

        match client.send(message).await {
            Ok(()) => {}
            Err(WebPushError::EndpointNotValid(_)) | Err(WebPushError::EndpointNotFound(_)) => {
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE id = ?")
                    .bind(sub.id)
                    .execute(pool)
                    .await;
            }
            Err(e) => {
                tracing::warn!("push send failed for subscription {}: {e}", sub.id);
            }
        }
    }
}
```

- [ ] **Step 4: Run `cargo build`**

Run: `cargo build`
Expected: succeeds. This step has no new automated test — sending a real push requires a real VAPID keypair and a real browser subscription, neither of which exist yet (Tasks 3 and 14). It's exercised end-to-end manually once the full feature is wired up.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/notifications.rs
git commit -m "feat: implement notify_watchers push-sending via web-push"
```

---

## Task 3: `vapid generate` CLI subcommand

**Files:**
- Modify: `src/main.rs`

**Interfaces:**
- Produces: `little-orderings vapid generate`, printing `VAPID_PUBLIC_KEY=...` and `VAPID_PRIVATE_KEY=...` lines to stdout, both base64url-no-pad encoded, mutually compatible with `web_push::VapidSignatureBuilder::from_base64` (private key) and the browser `PushManager.subscribe({ applicationServerKey })` call (public key).

- [ ] **Step 1: Add the `Vapid` command variant**

In `src/main.rs`, change the `Command` enum (lines 37-46) from:

```rust
#[derive(Subcommand)]
enum Command {
    /// Start the web server
    Serve,
    /// Manage users
    User {
        #[command(subcommand)]
        action: UserAction,
    },
}
```

to:

```rust
#[derive(Subcommand)]
enum Command {
    /// Start the web server
    Serve,
    /// Manage users
    User {
        #[command(subcommand)]
        action: UserAction,
    },
    /// Manage VAPID keys for web push
    Vapid {
        #[command(subcommand)]
        action: VapidAction,
    },
}

#[derive(Subcommand)]
enum VapidAction {
    /// Generate a new VAPID keypair
    Generate,
}
```

- [ ] **Step 2: Dispatch the new command**

In `src/main.rs`, change the `match cli.command` block (lines 73-76) from:

```rust
    match cli.command {
        Command::Serve => serve().await,
        Command::User { action } => user_cmd(action).await,
    }
```

to:

```rust
    match cli.command {
        Command::Serve => serve().await,
        Command::User { action } => user_cmd(action).await,
        Command::Vapid { action } => vapid_cmd(action).await,
    }
```

- [ ] **Step 3: Add `getrandom` as a direct dependency**

`p256`/`elliptic-curve` 0.14's `SecretKey::random` needs a `rand_core::CryptoRng`, but the `rand_core` 0.10.1 pulled in transitively by `elliptic-curve` 0.14.1 does not export `OsRng` at all in that version (removed from the crate; `rand = "0.8"`'s `OsRng` is a different, incompatible major version of `rand_core`). Sidestep the trait entirely: fill raw bytes with `getrandom` (already resolved transitively at 0.4.2 via the same dependency chain) and construct the key from those bytes directly.

In `Cargo.toml`, add to `[dependencies]` (after the `ct-codecs` line added in Task 2):

```toml
getrandom = "0.4"
```

Run: `cargo build`
Expected: succeeds, resolving to the same `getrandom 0.4.2` already in `Cargo.lock` (no new version introduced).

- [ ] **Step 4: Implement `vapid_cmd`**

Add this function to `src/main.rs`, after `user_cmd` (after line 200, before the closing of the file):

```rust
async fn vapid_cmd(action: VapidAction) {
    match action {
        VapidAction::Generate => {
            use ct_codecs::{Base64UrlSafeNoPadding, Encoder};
            use p256::SecretKey;

            let mut private_bytes = [0u8; 32];
            getrandom::fill(&mut private_bytes).expect("failed to read OS randomness");
            let secret_key = SecretKey::from_slice(&private_bytes)
                .expect("32 random bytes formed an invalid P-256 scalar (astronomically unlikely)");
            let public_bytes = secret_key.public_key().to_sec1_bytes();

            let private_b64 = Base64UrlSafeNoPadding::encode_to_string(private_bytes.as_slice())
                .expect("base64 encoding cannot fail");
            let public_b64 = Base64UrlSafeNoPadding::encode_to_string(public_bytes.as_ref())
                .expect("base64 encoding cannot fail");

            println!("VAPID_PUBLIC_KEY={public_b64}");
            println!("VAPID_PRIVATE_KEY={private_b64}");
        }
    }
}
```

Note: `NistP256::COMPRESS_POINTS = false`, so `secret_key.public_key().to_sec1_bytes()` returns the 65-byte uncompressed SEC1 point (`0x04 || X || Y`) — the format the browser's `PushManager.subscribe({ applicationServerKey })` requires. `private_bytes` is the raw 32-byte private scalar, matching what `VapidSignatureBuilder::from_base64` (Task 2) decodes. `SecretKey::from_slice` rejects a buffer that isn't a valid scalar for the curve (zero, or ≥ the curve order) — for 32 uniformly random bytes against a ~256-bit curve order this fails with probability roughly 2⁻¹²⁸, low enough that `.expect()` is the deliberate choice here rather than a retry loop.

- [ ] **Step 5: Run it manually to verify output shape**

Run: `cargo run -- vapid generate`
Expected: two lines printed, `VAPID_PUBLIC_KEY=` and `VAPID_PRIVATE_KEY=`, each followed by a base64url string (letters, digits, `-`, `_`, no `+`, `/`, or `=`). The public key's decoded length should be 65 bytes and the private key's 32 — you don't need to verify this by hand; the browser subscribe call (Task 14) and the send path (Task 2) are the real end-to-end check, exercised manually once everything is wired up (see "After all tasks: manual end-to-end verification" at the end of this plan).

- [ ] **Step 6: Commit**

```bash
git add src/main.rs
git commit -m "feat: add vapid generate CLI subcommand"
```

---

## Task 4: Push subscription routes

**Files:**
- Create: `src/routes/push_subscriptions.rs`
- Modify: `src/routes/mod.rs`

**Interfaces:**
- Consumes: `crate::models::{CreatePushSubscriptionRequest, DeletePushSubscriptionRequest}` from Task 1.
- Produces: `POST /api/push-subscriptions`, `DELETE /api/push-subscriptions`.

- [ ] **Step 1: Implement the handlers**

Create `src/routes/push_subscriptions.rs`:

```rust
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};

use crate::{
    auth::AuthUser,
    error::AppError,
    models::{CreatePushSubscriptionRequest, DeletePushSubscriptionRequest},
    AppState,
};

pub async fn create_subscription(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<CreatePushSubscriptionRequest>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query(
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh_key = excluded.p256dh_key,
           auth_key = excluded.auth_key",
    )
    .bind(user.id)
    .bind(&payload.endpoint)
    .bind(&payload.p256dh_key)
    .bind(&payload.auth_key)
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::CREATED)
}

pub async fn delete_subscription(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<DeletePushSubscriptionRequest>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
        .bind(user.id)
        .bind(&payload.endpoint)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
```

The `ON CONFLICT (endpoint)` upsert handles a device re-subscribing (browsers occasionally rotate the same logical subscription) and the edge case of a stale endpoint being reused by a different logged-in user (e.g. a shared device) — it reassigns ownership rather than erroring.

- [ ] **Step 2: Register the routes**

In `src/routes/mod.rs`, add `pub mod push_subscriptions;` after `pub mod milestones;` (line 2) — only this line; `pub mod watches;` is added in Task 5, which creates that file:

```rust
pub mod helpers;
pub mod milestones;
pub mod projects;
pub mod push_subscriptions;
pub mod tasks;
```

Add the route inside `api_router()`, after the `/auth/me` route (after line 8) and before the `// Projects` comment:

```rust
        .route("/auth/me", get(auth::me))
        // Push subscriptions
        .route(
            "/push-subscriptions",
            post(push_subscriptions::create_subscription).delete(push_subscriptions::delete_subscription),
        )
        // Projects
```

- [ ] **Step 3: Run `cargo build`**

Run: `cargo build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/routes/push_subscriptions.rs src/routes/mod.rs
git commit -m "feat: add push subscription CRUD routes"
```

---

## Task 5: Project watch routes + clear-pending-on-view

**Files:**
- Create: `src/routes/watches.rs`
- Modify: `src/routes/mod.rs`
- Modify: `src/models.rs` (extend `ProjectDetail`)
- Modify: `src/routes/projects.rs:82-110` (`get_project`)

**Interfaces:**
- Consumes: `crate::models::SetWatchRequest` from Task 1.
- Produces: `PUT /api/projects/:id/watch`, `DELETE /api/projects/:id/watch`. `ProjectDetail.my_watch_tier: Option<String>` — the requesting user's current tier, or `None` if not watching. `GET /api/projects/:id` now clears any pending notification flag for the requester as a side effect.

- [ ] **Step 1: Implement the watch handlers**

Create `src/routes/watches.rs`:

```rust
use axum::{extract::{Path, State}, http::StatusCode, response::IntoResponse, Json};

use crate::{auth::AuthUser, error::AppError, models::SetWatchRequest, AppState};

pub async fn set_watch(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<SetWatchRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    sqlx::query(
        "INSERT INTO project_watches (project_id, user_id, tier) VALUES (?, ?, ?)
         ON CONFLICT (project_id, user_id) DO UPDATE SET tier = excluded.tier",
    )
    .bind(project_id)
    .bind(user.id)
    .bind(payload.tier.as_str())
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_watch(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query("DELETE FROM project_watches WHERE project_id = ? AND user_id = ?")
        .bind(project_id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
```

`set_watch` requires membership (any role, including viewer — watching is read-only in intent) via `require_member`, matching how `list_members`/`get_project` are gated, not the stricter `require_writer`.

- [ ] **Step 2: Register the routes**

In `src/routes/mod.rs`, the `pub mod watches;` line was left for this task — add it now alongside the others:

```rust
pub mod helpers;
pub mod milestones;
pub mod projects;
pub mod push_subscriptions;
pub mod tasks;
pub mod watches;
```

Also change the `use axum::routing::{...}` import (line 5-8) to add `put`:

```rust
use axum::{
    routing::{delete, get, patch, post, put},
    Router,
};
```

Add the route inside `api_router()`, directly after the `/projects/:id/members/:user_id` route (after line 32) and before the `// Milestones` comment:

```rust
        .route(
            "/projects/:id/members/:user_id",
            delete(projects::remove_member),
        )
        .route(
            "/projects/:id/watch",
            put(watches::set_watch).delete(watches::delete_watch),
        )
        // Milestones
```

- [ ] **Step 3: Extend `ProjectDetail` with the caller's watch state**

In `src/models.rs`, change the `ProjectDetail` struct (lines 154-162) from:

```rust
/// Detail view: project + its milestones.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
pub struct ProjectDetail {
    #[serde(flatten)]
    pub project: Project,
    pub milestones: Vec<MilestoneSummary>,
}
```

to:

```rust
/// Detail view: project + its milestones + the caller's own watch state.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
pub struct ProjectDetail {
    #[serde(flatten)]
    pub project: Project,
    pub milestones: Vec<MilestoneSummary>,
    pub my_watch_tier: Option<String>,
}
```

- [ ] **Step 4: Populate `my_watch_tier` and clear pending notifications in `get_project`**

In `src/routes/projects.rs`, change `get_project` (lines 82-110) from:

```rust
pub async fn get_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let project: Project = sqlx::query_as(
        "SELECT id, name, description, status, target_date, created_at, updated_at
         FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let milestones: Vec<MilestoneSummary> = sqlx::query_as(
        "SELECT m.id, m.name, m.description, m.status, m.target_date, m.due_date, m.sort_order,
                (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id) as task_count
         FROM milestones m
         WHERE m.project_id = ?
         ORDER BY m.sort_order, m.id",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ProjectDetail { project, milestones }))
}
```

to:

```rust
pub async fn get_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let project: Project = sqlx::query_as(
        "SELECT id, name, description, status, target_date, created_at, updated_at
         FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let milestones: Vec<MilestoneSummary> = sqlx::query_as(
        "SELECT m.id, m.name, m.description, m.status, m.target_date, m.due_date, m.sort_order,
                (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id) as task_count
         FROM milestones m
         WHERE m.project_id = ?
         ORDER BY m.sort_order, m.id",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;

    let watch: Option<(String,)> =
        sqlx::query_as("SELECT tier FROM project_watches WHERE project_id = ? AND user_id = ?")
            .bind(project_id)
            .bind(user.id)
            .fetch_optional(&state.pool)
            .await?;

    // Opening this project acknowledges any pending notification for it —
    // re-arms the watch so the next matching change notifies again (spec §4).
    sqlx::query(
        "UPDATE project_watches SET notified_at = NULL
         WHERE project_id = ? AND user_id = ? AND notified_at IS NOT NULL",
    )
    .bind(project_id)
    .bind(user.id)
    .execute(&state.pool)
    .await?;

    Ok(Json(ProjectDetail {
        project,
        milestones,
        my_watch_tier: watch.map(|(t,)| t),
    }))
}
```

- [ ] **Step 5: Regenerate frontend types and run backend tests**

Run: `cargo test`
Expected: all tests pass, and `frontend/src/types/ProjectDetail.ts` is regenerated with the new `my_watch_tier: string | null` field.

Run: `cargo build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/routes/watches.rs src/routes/mod.rs src/models.rs src/routes/projects.rs frontend/src/types/ProjectDetail.ts
git commit -m "feat: add project watch routes and clear-pending-on-view"
```

---

## Task 6: Wire `notify_watchers` into project mutations

**Files:**
- Modify: `src/routes/projects.rs`

**Interfaces:**
- Consumes: `crate::notifications::notify_watchers` from Task 2.

- [ ] **Step 1: `update_project`**

In `src/routes/projects.rs`, in `update_project`, change the tail (originally lines 142-151, now shifted slightly by Task 5's edits — locate by the `let project: Project = sqlx::query_as(` that follows the `qb.build().execute(...)` call) from:

```rust
    let project: Project = sqlx::query_as(
        "SELECT id, name, description, status, target_date, created_at, updated_at
         FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(project))
}
```

to:

```rust
    let project: Project = sqlx::query_as(
        "SELECT id, name, description, status, target_date, created_at, updated_at
         FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_one(&state.pool)
    .await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All).await;

    Ok(Json(project))
}
```

- [ ] **Step 2: `archive_project`**

Change (originally lines 153-168):

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

    Ok(StatusCode::NO_CONTENT)
}
```

to:

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

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All).await;

    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 3: `add_member`**

Change the tail of `add_member` (originally lines 201-221) from:

```rust
    .execute(&state.pool)
    .await
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("UNIQUE constraint failed") {
            AppError::BadRequest("User is already a member".to_string())
        } else if msg.contains("FOREIGN KEY constraint failed") {
            AppError::NotFound
        } else {
            AppError::from(e)
        }
    })?;

    Ok(StatusCode::CREATED)
}
```

to:

```rust
    .execute(&state.pool)
    .await
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("UNIQUE constraint failed") {
            AppError::BadRequest("User is already a member".to_string())
        } else if msg.contains("FOREIGN KEY constraint failed") {
            AppError::NotFound
        } else {
            AppError::from(e)
        }
    })?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All).await;

    Ok(StatusCode::CREATED)
}
```

- [ ] **Step 4: `remove_member`**

Change the success tail of `remove_member` (the final lines, after the `if result.rows_affected() == 0 { ... }` block) from:

```rust
        return Err(if exists.is_some() {
            AppError::Forbidden // last owner — cannot remove
        } else {
            AppError::NotFound
        });
    }

    Ok(StatusCode::NO_CONTENT)
}
```

to:

```rust
        return Err(if exists.is_some() {
            AppError::Forbidden // last owner — cannot remove
        } else {
            AppError::NotFound
        });
    }

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All).await;

    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 5: Run `cargo build`**

Run: `cargo build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/routes/projects.rs
git commit -m "feat: notify watchers on project metadata and membership changes"
```

---

## Task 7: Wire `notify_watchers` into milestone mutations

**Files:**
- Modify: `src/routes/milestones.rs`

**Interfaces:**
- Consumes: `crate::notifications::notify_watchers` from Task 2.

- [ ] **Step 1: `create_milestone`**

Change the tail (originally lines 89-94) from:

```rust
    let milestone_id = result.last_insert_rowid();
    tx.commit().await?;

    let milestone = fetch_milestone(&state.pool, milestone_id).await?;
    Ok((StatusCode::CREATED, Json(milestone)))
}
```

to:

```rust
    let milestone_id = result.last_insert_rowid();
    tx.commit().await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::Milestones)
        .await;

    let milestone = fetch_milestone(&state.pool, milestone_id).await?;
    Ok((StatusCode::CREATED, Json(milestone)))
}
```

- [ ] **Step 2: `update_milestone`**

Change the tail (originally lines 129-133) from:

```rust
    qb.push(" WHERE id = ").push_bind(milestone_id);
    qb.build().execute(&state.pool).await?;

    Ok(Json(fetch_milestone(&state.pool, milestone_id).await?))
}
```

to:

```rust
    qb.push(" WHERE id = ").push_bind(milestone_id);
    qb.build().execute(&state.pool).await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::Milestones)
        .await;

    Ok(Json(fetch_milestone(&state.pool, milestone_id).await?))
}
```

- [ ] **Step 3: `delete_milestone`**

Change (originally lines 135-149) from:

```rust
pub async fn delete_milestone(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM milestones WHERE id = ?")
        .bind(milestone_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
```

to:

```rust
pub async fn delete_milestone(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM milestones WHERE id = ?")
        .bind(milestone_id)
        .execute(&state.pool)
        .await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::Milestones)
        .await;

    Ok(StatusCode::NO_CONTENT)
}
```

`reorder_milestone` is deliberately left untouched — reorders never notify (spec §3).

- [ ] **Step 4: Run `cargo build`**

Run: `cargo build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/routes/milestones.rs
git commit -m "feat: notify watchers on milestone create/update/delete"
```

---

## Task 8: Wire `notify_watchers` into task mutations

**Files:**
- Modify: `src/routes/tasks.rs`

**Interfaces:**
- Consumes: `crate::notifications::notify_watchers` from Task 2.

- [ ] **Step 1: `create_task`**

Change the tail (originally lines 145-150) from:

```rust
    let task_id = result.last_insert_rowid();
    tx.commit().await?;

    let task = get_full_task(&state.pool, task_id).await?;
    Ok((StatusCode::CREATED, Json(task)))
}
```

to:

```rust
    let task_id = result.last_insert_rowid();
    tx.commit().await?;

    crate::notifications::notify_watchers(
        &state.pool,
        project_id,
        crate::models::Tier::TaskMilestones,
    )
    .await;

    let task = get_full_task(&state.pool, task_id).await?;
    Ok((StatusCode::CREATED, Json(task)))
}
```

- [ ] **Step 2: `update_task`**

This one needs the *old* status to detect a transition to `done` — that's the narrow "task completed" event (spec §3); any other field-only edit is an `All`-tier event. Change `update_task` (originally lines 152-187) from:

```rust
pub async fn update_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<UpdateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

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
    crate::notifications::notify_watchers(&state.pool, project_id, event_tier).await;

    Ok(Json(get_full_task(&state.pool, task_id).await?))
}
```

- [ ] **Step 3: `delete_task`**

Change (originally lines 189-203) from:

```rust
pub async fn delete_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(task_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
```

to:

```rust
pub async fn delete_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(task_id)
        .execute(&state.pool)
        .await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All).await;

    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 4: `assign_user`**

Change the tail (originally lines 219-233) from:

```rust
    sqlx::query("INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)")
        .bind(task_id)
        .bind(payload.user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            if e.to_string().contains("UNIQUE constraint failed") {
                AppError::BadRequest("User already assigned".to_string())
            } else {
                AppError::from(e)
            }
        })?;

    Ok((StatusCode::CREATED, Json(get_full_task(&state.pool, task_id).await?)))
}
```

to:

```rust
    sqlx::query("INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)")
        .bind(task_id)
        .bind(payload.user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            if e.to_string().contains("UNIQUE constraint failed") {
                AppError::BadRequest("User already assigned".to_string())
            } else {
                AppError::from(e)
            }
        })?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All).await;

    Ok((StatusCode::CREATED, Json(get_full_task(&state.pool, task_id).await?)))
}
```

- [ ] **Step 5: `unassign_user`**

Change (originally lines 235-252) from:

```rust
pub async fn unassign_user(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path((task_id, target_user_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    // Intentionally idempotent: unassigning a user who was never assigned
    // returns 204 rather than 404, matching REST convention for DELETE.
    sqlx::query("DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?")
        .bind(task_id)
        .bind(target_user_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
```

to:

```rust
pub async fn unassign_user(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path((task_id, target_user_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    // Intentionally idempotent: unassigning a user who was never assigned
    // returns 204 rather than 404, matching REST convention for DELETE.
    sqlx::query("DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?")
        .bind(task_id)
        .bind(target_user_id)
        .execute(&state.pool)
        .await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All).await;

    Ok(StatusCode::NO_CONTENT)
}
```

`reorder_task` is deliberately left untouched (spec §3).

- [ ] **Step 6: Run backend build and full test suite**

Run: `cargo build && cargo test`
Expected: both succeed. This closes out all backend work — the API surface is complete and notification triggers are fully wired.

- [ ] **Step 7: Commit**

```bash
git add src/routes/tasks.rs
git commit -m "feat: notify watchers on task create/update/delete/assign/unassign"
```

---

## Task 9: PWA manifest, icons, and HTML meta tags

**Files:**
- Create: `frontend/public/manifest.json`
- Create: `frontend/public/icon-192.png`, `frontend/public/icon-512.png`, `frontend/public/apple-touch-icon.png`
- Modify: `frontend/index.html`

**Interfaces:**
- Produces: `/manifest.json`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png` served as static files (same mechanism as the existing `/favicon.svg`).

- [ ] **Step 1: Generate PNG icons from the existing SVG mark**

The only brand asset in the repo is `frontend/public/favicon.svg` (a near-square 48×46 mark used as the browser tab icon today). Generate square PNGs from it — `-gravity center -extent` pads to an exact square rather than distorting the aspect ratio:

```bash
sudo apt-get install -y imagemagick
cd frontend/public
convert -background none favicon.svg -resize 512x512 -gravity center -extent 512x512 icon-512.png
convert -background none favicon.svg -resize 192x192 -gravity center -extent 192x192 icon-192.png
convert -background white favicon.svg -flatten -resize 180x180 -gravity center -extent 180x180 apple-touch-icon.png
```

`apple-touch-icon.png` gets a white (opaque) background rather than transparent — iOS composites this icon directly onto the home screen and historically handles transparency poorly, so Apple's own guidance is to ship it opaque.

- [ ] **Step 2: Create the manifest**

Create `frontend/public/manifest.json`. Colors match the `--color-canvas` token from `frontend/src/index.css`'s theme block:

```json
{
  "name": "Little Orderings",
  "short_name": "Orderings",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f1f5f9",
  "theme_color": "#f1f5f9",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 3: Wire up `index.html`**

Change `frontend/index.html` from:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Little Orderings</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

to:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="manifest" href="/manifest.json" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f1f5f9" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <title>Little Orderings</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Verify the build picks up the new static files**

Run: `cd frontend && npm run build`
Expected: succeeds; `frontend/dist/manifest.json`, `frontend/dist/icon-192.png`, `frontend/dist/icon-512.png`, and `frontend/dist/apple-touch-icon.png` all exist afterward (Vite copies everything in `public/` verbatim).

- [ ] **Step 5: Commit**

```bash
git add frontend/public/manifest.json frontend/public/icon-192.png frontend/public/icon-512.png frontend/public/apple-touch-icon.png frontend/index.html
git commit -m "feat: add PWA manifest, icons, and iOS install meta tags"
```

---

## Task 10: Service worker + registration

**Files:**
- Create: `frontend/public/sw.js`
- Create: `frontend/src/serviceWorkerRegistration.ts`
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `registerServiceWorker(): Promise<ServiceWorkerRegistration | null>`, called once from `main.tsx`. `navigator.serviceWorker.ready` becomes available to Task 14's subscribe flow once this registers.

- [ ] **Step 1: Write the service worker**

Create `frontend/public/sw.js` (plain JS — service workers run outside the Vite/TypeScript build, same as `favicon.svg` being a static asset):

```js
self.addEventListener('push', (event) => {
  let data = { title: 'Little Orderings', body: 'You have updates', url: '/' }
  if (event.data) {
    try {
      data = event.data.json()
    } catch {
      // fall back to the default above
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      data: { url: data.url },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url ?? '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === url && 'focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })
  )
})
```

The `data.url` field matches the `"url": "/projects/{project_id}"` field the backend's `notify_watchers` (Task 2) puts in the push payload — this is what makes tapping a notification deep-link into the right project.

- [ ] **Step 2: Write the registration helper**

Create `frontend/src/serviceWorkerRegistration.ts`:

```ts
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.register('/sw.js')
}
```

- [ ] **Step 3: Call it from `main.tsx`**

Change `frontend/src/main.tsx` from:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

to:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './serviceWorkerRegistration'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 4: Verify the build and dev server still work**

Run: `cd frontend && npm run build`
Expected: succeeds; `frontend/dist/sw.js` exists afterward.

- [ ] **Step 5: Commit**

```bash
git add frontend/public/sw.js frontend/src/serviceWorkerRegistration.ts frontend/src/main.tsx
git commit -m "feat: add service worker for push notifications"
```

---

## Task 11: VAPID public key config + API client methods

**Files:**
- Create: `frontend/src/config.ts`
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Produces: `VAPID_PUBLIC_KEY: string` (placeholder until Task 3's key is generated at deploy time — see Step 1). `watches.set(projectId, tier)`, `watches.remove(projectId)`, `pushSubscriptions.create(sub)`, `pushSubscriptions.remove(endpoint)`, consumed by Task 14.

- [ ] **Step 1: Create the config constant**

Create `frontend/src/config.ts`:

```ts
// Non-secret — sent in the clear on every push subscription request, and
// safe to commit. Generate a real keypair with `cargo run -- vapid generate`
// (see src/main.rs); this placeholder must be replaced with that command's
// VAPID_PUBLIC_KEY output, and the matching VAPID_PRIVATE_KEY must be set in
// the server's .env (see .env.example) — they are two halves of one keypair.
export const VAPID_PUBLIC_KEY = 'REPLACE_WITH_GENERATED_VAPID_PUBLIC_KEY'
```

- [ ] **Step 2: Add `watches` and `pushSubscriptions` to the API client**

In `frontend/src/api/client.ts`, add after the `projects` object's closing brace (after the `removeMember` method, before the `// ── Milestones ──` comment):

```ts
export const watches = {
  set: (projectId: number, tier: 'task_milestones' | 'milestones' | 'all') =>
    request<void>(`/api/projects/${projectId}/watch`, {
      method: 'PUT',
      body: JSON.stringify({ tier }),
    }),

  remove: (projectId: number) =>
    request<void>(`/api/projects/${projectId}/watch`, { method: 'DELETE' }),
};

export type PushSubscriptionInput = {
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
};

export const pushSubscriptions = {
  create: (subscription: PushSubscriptionInput) =>
    request<void>('/api/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription),
    }),

  remove: (endpoint: string) =>
    request<void>('/api/push-subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),
};
```

- [ ] **Step 3: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: succeeds. `ProjectDetail`'s generated type (from Task 5) now includes `my_watch_tier: string | null`, so any code constructing a `ProjectDetail` object (e.g. test fixtures) will need that field — none exist yet at this point in the plan; `Project.test.tsx`'s `fakeProject` fixture gets updated in Task 14 Step 5, where it starts to matter.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/config.ts frontend/src/api/client.ts
git commit -m "feat: add VAPID public key config and watch/subscription API client methods"
```

---

## Task 12: `<InstallLink />` component

**Files:**
- Create: `frontend/src/components/InstallLink.tsx`
- Test: `frontend/src/components/InstallLink.test.tsx`

**Interfaces:**
- Produces: `export function InstallLink(): JSX.Element | null` — a button rendered by Tasks 13; internally self-contained, no props.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/InstallLink.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { InstallLink } from './InstallLink'

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function mockUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

beforeEach(() => {
  mockMatchMedia(false)
  mockUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  )
  Object.defineProperty(window.navigator, 'standalone', { value: undefined, configurable: true })
})

test('hidden when already running standalone', () => {
  mockMatchMedia(true)
  render(<InstallLink />)
  expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
})

test('hidden on desktop Chrome with no beforeinstallprompt captured', () => {
  render(<InstallLink />)
  expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
})

test('shown after beforeinstallprompt fires, and clicking calls prompt()', async () => {
  const user = userEvent.setup()
  render(<InstallLink />)
  const promptFn = vi.fn().mockResolvedValue(undefined)
  const event = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void> }
  event.prompt = promptFn
  window.dispatchEvent(event)

  const button = await screen.findByRole('button', { name: /install/i })
  await user.click(button)
  expect(promptFn).toHaveBeenCalled()
})

test('shown with manual explainer on mobile Safari with no beforeinstallprompt', async () => {
  mockUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  )
  const user = userEvent.setup()
  render(<InstallLink />)

  const button = screen.getByRole('button', { name: /install/i })
  await user.click(button)
  expect(screen.getByText(/add to home screen/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/InstallLink.test.tsx`
Expected: FAIL — `./InstallLink` module doesn't exist yet.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/InstallLink.tsx`:

```tsx
import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

function isSafariOnMobile(): boolean {
  const ua = window.navigator.userAgent
  // Other iOS browsers (Chrome, Firefox, Edge, Opera) run on Safari's WebKit
  // engine and their UA strings contain "Safari" too — exclude their own
  // tokens (CriOS/FxiOS/EdgiOS/OPiOS) alongside chrome/android, or they'd be
  // misclassified as Safari here.
  const isSafari = /^((?!chrome|android|crios|fxios|edgios|opios).)*safari/i.test(ua)
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua)
  return isSafari && isMobile
}

export function InstallLink() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showExplainer, setShowExplainer] = useState(false)
  const [standalone] = useState(isStandalone)

  useEffect(() => {
    function handler(e: Event) {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (standalone) return null
  if (!deferredPrompt && !isSafariOnMobile()) return null

  async function handleClick() {
    if (deferredPrompt) {
      await deferredPrompt.prompt()
      setDeferredPrompt(null)
    } else {
      setShowExplainer(true)
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        className="text-muted hover:text-text text-sm transition-colors"
      >
        Install
      </button>
      {showExplainer && (
        <div
          className="fixed inset-0 bg-text/40 flex items-center justify-center z-50"
          onClick={() => setShowExplainer(false)}
        >
          <div
            className="bg-surface rounded-xl p-6 w-full max-w-sm border border-border shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-text mb-2">Install Little Orderings</h2>
            <p className="text-muted text-sm mb-4">
              Tap the Share icon, then &quot;Add to Home Screen&quot;.
            </p>
            <button
              onClick={() => setShowExplainer(false)}
              className="w-full bg-accent hover:bg-accent-hover text-surface font-semibold rounded-lg py-2 text-sm transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/InstallLink.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/InstallLink.tsx frontend/src/components/InstallLink.test.tsx
git commit -m "feat: add InstallLink component"
```

---

## Task 13: Wire `<InstallLink />` into page headers

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/pages/Project.tsx`

**Interfaces:**
- Consumes: `InstallLink` from Task 12.

- [ ] **Step 1: Dashboard header**

In `frontend/src/pages/Dashboard.tsx`, add the import (after the existing `import type { ProjectListItem } from '../types'` line):

```tsx
import { InstallLink } from '../components/InstallLink'
```

Change the header block from:

```tsx
      <div className="flex items-center justify-between px-8 py-4 border-b border-border bg-surface shadow-sm">
        <span className="font-semibold text-lg text-text">Little Orderings</span>
        <button
          onClick={handleLogout}
          className="text-muted hover:text-text text-sm transition-colors"
        >
          Sign out
        </button>
      </div>
```

to:

```tsx
      <div className="flex items-center justify-between px-8 py-4 border-b border-border bg-surface shadow-sm">
        <span className="font-semibold text-lg text-text">Little Orderings</span>
        <div className="flex items-center gap-4">
          <InstallLink />
          <button
            onClick={handleLogout}
            className="text-muted hover:text-text text-sm transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
```

- [ ] **Step 2: Project header**

In `frontend/src/pages/Project.tsx`, add the import:

```tsx
import { InstallLink } from '../components/InstallLink'
```

Change:

```tsx
          <Link to="/" className="text-sm text-muted hover:text-accent-muted transition-colors inline-block mb-3">
            ← All Projects
          </Link>
          <h1 className="text-2xl font-semibold text-text mb-1">{project?.name}</h1>
```

to:

```tsx
          <div className="flex items-center justify-between mb-3">
            <Link to="/" className="text-sm text-muted hover:text-accent-muted transition-colors inline-block">
              ← All Projects
            </Link>
            <InstallLink />
          </div>
          <h1 className="text-2xl font-semibold text-text mb-1">{project?.name}</h1>
```

- [ ] **Step 3: Run existing frontend tests**

Run: `cd frontend && npm test`
Expected: all existing tests still pass, including `Dashboard.test.tsx` and `Project.test.tsx` (neither queries for the removed layout structure by role/text that would break — `InstallLink` renders nothing in jsdom's default Chrome-desktop-like `navigator.userAgent` with no `beforeinstallprompt` fired, matching Task 12's "hidden on desktop Chrome" case).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx frontend/src/pages/Project.tsx
git commit -m "feat: show InstallLink in Dashboard and Project headers"
```

---

## Task 14: Watch toggle UI + push subscription flow

**Files:**
- Modify: `frontend/src/contexts/ProjectContext.tsx`
- Create: `frontend/src/push.ts`
- Create: `frontend/src/components/WatchToggle.tsx`
- Test: `frontend/src/components/WatchToggle.test.tsx`
- Modify: `frontend/src/pages/Project.tsx`
- Modify: `frontend/src/pages/Project.test.tsx`

**Interfaces:**
- Consumes: `watches`, `pushSubscriptions` from Task 11; `VAPID_PUBLIC_KEY` from Task 11; `registerServiceWorker`'s registration (via `navigator.serviceWorker.ready`) from Task 10.
- Produces: `subscribeToPush(): Promise<void>`. `<WatchToggle projectId={number} currentTier={string | null} onChange={(tier: string | null) => void} />`.

- [ ] **Step 1: Expose `projectId` from `ProjectContext`**

In `frontend/src/contexts/ProjectContext.tsx`, add `projectId: number` to the `ProjectContextType` interface (after `project: ProjectDetail | null`, line 7):

```ts
interface ProjectContextType {
  project: ProjectDetail | null
  projectId: number
  milestones: MilestoneSummary[]
  ...
```

Add it to the provider value (in the `return` statement, around line 150-157):

```tsx
  return (
    <ProjectContext.Provider value={{
      project, projectId, milestones, tasks, members, loading,
      selectedTaskId, setSelectedTaskId,
      addMilestone, updateMilestone, deleteMilestone, reorderMilestone,
      addTask, updateTask, deleteTask, reorderTask,
      assignUser, unassignUser,
    }}>
      {children}
    </ProjectContext.Provider>
  )
```

(`projectId` is already a prop on `ProjectProvider` — this just forwards it into the context value, no new state.)

- [ ] **Step 2: Write the push subscribe helper**

Create `frontend/src/push.ts`:

```ts
import { pushSubscriptions } from './api/client'
import { VAPID_PUBLIC_KEY } from './config'

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64Safe)
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)))
}

export async function subscribeToPush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return

  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  })

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return

  await pushSubscriptions.create({
    endpoint: json.endpoint,
    p256dh_key: json.keys.p256dh,
    auth_key: json.keys.auth,
  })
}
```

- [ ] **Step 3: Write the failing test for `WatchToggle`**

Create `frontend/src/components/WatchToggle.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { WatchToggle } from './WatchToggle'
import * as client from '../api/client'
import * as push from '../push'

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return { ...mod, watches: { set: vi.fn(), remove: vi.fn() } }
})
vi.mock('../push', () => ({ subscribeToPush: vi.fn().mockResolvedValue(undefined) }))

const mockWatches = client.watches as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.resetAllMocks()
  mockWatches.set.mockResolvedValue(undefined)
  mockWatches.remove.mockResolvedValue(undefined)
  ;(push.subscribeToPush as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

test('shows "Not watching" when currentTier is null', () => {
  render(<WatchToggle projectId={1} currentTier={null} onChange={vi.fn()} />)
  expect(screen.getByRole('combobox')).toHaveValue('')
})

test('selecting a tier calls watches.set and subscribeToPush, then onChange', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<WatchToggle projectId={1} currentTier={null} onChange={onChange} />)

  await user.selectOptions(screen.getByRole('combobox'), 'milestones')

  expect(mockWatches.set).toHaveBeenCalledWith(1, 'milestones')
  expect(push.subscribeToPush).toHaveBeenCalled()
  expect(onChange).toHaveBeenCalledWith('milestones')
})

test('selecting "Not watching" calls watches.remove, then onChange with null', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<WatchToggle projectId={1} currentTier="all" onChange={onChange} />)

  await user.selectOptions(screen.getByRole('combobox'), '')

  expect(mockWatches.remove).toHaveBeenCalledWith(1)
  expect(onChange).toHaveBeenCalledWith(null)
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/WatchToggle.test.tsx`
Expected: FAIL — `./WatchToggle` module doesn't exist yet.

- [ ] **Step 5: Implement `WatchToggle`**

Create `frontend/src/components/WatchToggle.tsx`:

```tsx
import { useState } from 'react'
import { watches } from '../api/client'
import { subscribeToPush } from '../push'

type Tier = 'task_milestones' | 'milestones' | 'all'

const TIER_LABELS: Record<Tier, string> = {
  task_milestones: 'Task added or completed',
  milestones: 'Milestone changes',
  all: 'Any change',
}

export function WatchToggle({
  projectId,
  currentTier,
  onChange,
}: {
  projectId: number
  currentTier: string | null
  onChange: (tier: string | null) => void
}) {
  const [busy, setBusy] = useState(false)

  async function handleChange(value: string) {
    setBusy(true)
    try {
      if (value === '') {
        await watches.remove(projectId)
        onChange(null)
      } else {
        await watches.set(projectId, value as Tier)
        await subscribeToPush()
        onChange(value)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <select
      value={currentTier ?? ''}
      disabled={busy}
      onChange={e => handleChange(e.target.value)}
      className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
    >
      <option value="">Not watching</option>
      <option value="task_milestones">{TIER_LABELS.task_milestones}</option>
      <option value="milestones">{TIER_LABELS.milestones}</option>
      <option value="all">{TIER_LABELS.all}</option>
    </select>
  )
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/WatchToggle.test.tsx`
Expected: PASS, all 3 tests.

- [ ] **Step 7: Wire `WatchToggle` into `Project.tsx`**

In `frontend/src/pages/Project.tsx`, add imports:

```tsx
import { useEffect, useState } from 'react'
import { WatchToggle } from '../components/WatchToggle'
```

(`useEffect`/`useState` are new to this file — add them to a new `import { useEffect, useState } from 'react'` line at the top.)

In `ProjectContent`, change:

```tsx
function ProjectContent() {
  const [searchParams, setSearchParams] = useSearchParams()
  const view = (searchParams.get('view') ?? 'list') as ViewType
  const { project, loading, selectedTaskId } = useProject()
```

to:

```tsx
function ProjectContent() {
  const [searchParams, setSearchParams] = useSearchParams()
  const view = (searchParams.get('view') ?? 'list') as ViewType
  const { project, projectId, loading, selectedTaskId } = useProject()
  const [watchTier, setWatchTier] = useState<string | null>(null)

  useEffect(() => {
    setWatchTier(project?.my_watch_tier ?? null)
  }, [project])
```

Change the header row (built in Task 13) from:

```tsx
          <div className="flex items-center justify-between mb-3">
            <Link to="/" className="text-sm text-muted hover:text-accent-muted transition-colors inline-block">
              ← All Projects
            </Link>
            <InstallLink />
          </div>
```

to:

```tsx
          <div className="flex items-center justify-between mb-3">
            <Link to="/" className="text-sm text-muted hover:text-accent-muted transition-colors inline-block">
              ← All Projects
            </Link>
            <div className="flex items-center gap-3">
              <WatchToggle projectId={projectId} currentTier={watchTier} onChange={setWatchTier} />
              <InstallLink />
            </div>
          </div>
```

- [ ] **Step 8: Update `Project.test.tsx`'s fixture and mocks**

`Project.test.tsx`'s `fakeProject` fixture needs `my_watch_tier` (Task 5's addition to `ProjectDetail`), and the new child components' modules need mocking so existing tests don't attempt real API/service-worker calls. In `frontend/src/pages/Project.test.tsx`, change:

```tsx
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    projects: { get: vi.fn(), listMembers: vi.fn() },
    tasks: { list: vi.fn() },
    milestones: {},
  }
})

const mockProjects = client.projects as Record<string, ReturnType<typeof vi.fn>>
const mockTasks = client.tasks as Record<string, ReturnType<typeof vi.fn>>

const fakeProject: ProjectDetail = {
  id: 1, name: 'Alpha', description: null, status: 'active',
  target_date: null, created_at: null, updated_at: null, milestones: [],
}
```

to:

```tsx
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
```

- [ ] **Step 9: Run all frontend tests and the build**

Run: `cd frontend && npm test && npm run build`
Expected: all tests pass (existing `Project.test.tsx` tests, plus Tasks 12/14's new tests), and the production build succeeds.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/contexts/ProjectContext.tsx frontend/src/push.ts frontend/src/components/WatchToggle.tsx frontend/src/components/WatchToggle.test.tsx frontend/src/pages/Project.tsx frontend/src/pages/Project.test.tsx
git commit -m "feat: add watch toggle UI and push subscription flow"
```

This closes out all application code. What's left (Task 15) is deploy tooling for getting real VAPID keys into production — the feature is functionally complete and testable locally as of this commit (aside from an actual push arriving on a real phone, which needs Task 15's real keys deployed).

---

## Task 15: Deploy tooling for VAPID key management

**Files:**
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `deploy/admin.sh`

**Interfaces:**
- Produces: `deploy/admin.sh push-env`, pushing `deploy/prod.env` (local, gitignored) to the server as `.env`.

- [ ] **Step 1: Document the new `.env` keys**

Change `.env.example` from:

```
# Copy to .env on the server (chmod 600), fill in real values.
# Never commit the real .env — it's gitignored.
# Used by docker-compose.prod.yml via env_file.

# Generate with: openssl rand -base64 32
SESSION_SECRET=

# Where app + Caddy data live on the host — the attached Hetzner volume, not
# the small root disk. Must match what deploy/provision-server.sh created.
# Not sensitive; kept here so compose and the provisioning script share one
# source of truth. Default if unset: /mnt/HC_Volume_106548799
DATA_ROOT=/mnt/HC_Volume_106548799
```

to:

```
# Copy to .env on the server (chmod 600), fill in real values.
# Never commit the real .env — it's gitignored.
# Used by docker-compose.prod.yml via env_file.

# Generate with: openssl rand -base64 32
SESSION_SECRET=

# Generate both together with: cargo run -- vapid generate
# Two halves of one keypair — the private key signs push requests server-side,
# the public key must exactly match the one baked into frontend/src/config.ts
# at build time. Regenerating one without the other breaks push delivery.
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Where app + Caddy data live on the host — the attached Hetzner volume, not
# the small root disk. Must match what deploy/provision-server.sh created.
# Not sensitive; kept here so compose and the provisioning script share one
# source of truth. Default if unset: /mnt/HC_Volume_106548799
DATA_ROOT=/mnt/HC_Volume_106548799
```

- [ ] **Step 2: Gitignore the local secrets file**

In `.gitignore`, add `deploy/prod.env` after the existing `.env` line:

```
target/
todo.db
bindings/
.env
deploy/prod.env
.claude/
.idea/
```

- [ ] **Step 3: Add the `push-env` subcommand to `deploy/admin.sh`**

In `deploy/admin.sh`, add a new function after `cmd_sync` (before `cmd_restart`):

```bash
cmd_push_env() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ ! -f "${repo_root}/deploy/prod.env" ]]; then
    echo "deploy/prod.env not found. Bootstrap it once, then fill in new keys:" >&2
    echo "  scp ${TARGET}:${REMOTE_DIR}/.env deploy/prod.env" >&2
    exit 1
  fi
  scp "${repo_root}/deploy/prod.env" "${TARGET}:${REMOTE_DIR}/.env"
  ssh "${TARGET}" "chmod 600 ${REMOTE_DIR}/.env"
}
```

Update the `usage()` function's command list, adding after the `sync` line:

```
  sync                                  Copy docker-compose.prod.yml, Caddyfile, and
                                         .env.example to the server
  push-env                              Push deploy/prod.env (gitignored, local-only) to
                                         the server as .env — kept separate from sync
                                         since overwriting secrets is a bigger deal than
                                         overwriting the compose file
  restart                               Pull the latest image and (re)start the stack
```

Update the final `case` statement, adding `push-env) cmd_push_env ;;` after `sync) cmd_sync ;;`:

```bash
case "${1:-}" in
  sync) cmd_sync ;;
  push-env) cmd_push_env ;;
  restart|start) cmd_restart ;;
  add-user) shift; cmd_add_user "$@" ;;
  set-password) shift; cmd_set_password "$@" ;;
  *) usage; exit 1 ;;
esac
```

- [ ] **Step 4: Verify the script's syntax**

Run: `bash -n deploy/admin.sh`
Expected: no output (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add .env.example .gitignore deploy/admin.sh
git commit -m "feat: add deploy/admin.sh push-env and document VAPID env vars"
```

---

## After all tasks: manual end-to-end verification

Not automatable (spec §9) — do this once, on a real device, before considering the feature done:

1. `cargo run -- vapid generate`, copy the `VAPID_PUBLIC_KEY` value into `frontend/src/config.ts` (replacing the placeholder), copy both lines into `deploy/prod.env`.
2. Commit the `frontend/src/config.ts` change and push to `main`, then wait for the GitHub Actions `build-and-push.yml` workflow to finish (`gh run list --workflow=build-and-push.yml` or the Actions tab) before continuing — the same check used to confirm the original image build in `docs/deployment-brief.md` §11 item 10. `deploy/admin.sh restart` only *pulls* whatever image already exists in GHCR; it does not build, so the new public key is not live in the runtime image until this rebuild has completed and been pushed.
3. `deploy/admin.sh push-env`, `deploy/admin.sh sync`, `deploy/admin.sh restart`.
4. On an iPhone: visit the deployed site in Safari, tap **Install** (Task 12), follow the Share → Add to Home Screen steps, open the installed app icon.
5. Open a project, toggle **Watch this project** to any tier, accept the notification permission prompt.
6. From another account/session, make a change that matches the chosen tier (e.g. create a task for `task_milestones`).
7. Confirm a push notification arrives on the phone, and tapping it opens the app directly to that project.
8. Confirm a second matching change before reopening the project does *not* produce a second push (debounce, spec §4) — then confirm reopening the project's page and making a third matching change *does* produce a new push (re-armed).
