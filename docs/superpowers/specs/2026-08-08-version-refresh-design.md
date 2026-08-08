# Version Refresh — Design

**Date:** 2026-08-08
**Scope:** Detect when a newly-deployed build differs from the one currently loaded in a user's browser tab, and silently reload to the fresh build on that user's next click — without interfering with the existing push-notification debounce.
**Stack assumption:** Rust/Axum/SQLite backend, React 19/Vite CSR frontend, single-origin production deploy behind Caddy at `todo.gerrietts.net`, images built off-box by GitHub Actions and tagged by git SHA (see `docs/deployment-brief.md`).

---

## 1. Goals

- A browser tab left open across a deploy picks up the new frontend build automatically, without the user needing to know to hit reload.
- Detection happens continuously while the app is open (polling), not just on next navigation.
- The reload itself is unobtrusive: no confirmation dialog, no interruption of an in-progress click's own effect.

## Non-goals

- **Live data updates** (a project page noticing another user's edits and refreshing its content in the background) — a related but separate feature, deferred to a follow-up spec.
- **Optimistic locking / conflict detection on writes** — also deferred; relevant once live data updates make concurrent edits more visible, not needed for this spec.
- **Fixing the pre-existing push-notification debounce fragility** — see §5. `GET /api/projects/:id` clears `project_watches.notified_at` as a side effect (per the push-notifications design), and *any* repeated legitimate fetch of that route (e.g. a refetch-on-window-focus pattern, if one is ever added) can already cause more pushes than intended when two people are active in the same project. This spec avoids compounding that problem but doesn't fix it — tracked here as a known, separate risk.
- **WebSocket-based detection** — polling is simpler and sufficient at this app's scale; not revisited here.

---

## 2. Version source & detection endpoint

CI (`build-and-push.yml`) already knows the git SHA at build time. It's threaded through the Docker build as a build ARG, into both stages:

- **Backend:** baked into the image as a runtime `ENV GIT_SHA=<sha>`, read once at startup via `std::env::var("GIT_SHA").unwrap_or_else(|_| "dev".into())` — matching the app's existing "config from environment" convention (`docs/deployment-brief.md` §8).
- **Frontend:** exposed to the `frontend-builder` Docker stage as `VITE_GIT_SHA`, which Vite automatically inlines into the built bundle as `import.meta.env.VITE_GIT_SHA` (Vite's standard env-var convention — no custom `define` needed).

New route:

```
GET /api/version → { "version": "<sha-or-dev>" }
```

Added to `routes::api_router()` alongside the other routes, unauthenticated (like `/health`). It reads nothing from and writes nothing to the database — this is the load-bearing property that keeps it decoupled from the push-notification debounce (§4).

**Local dev:** neither `GIT_SHA` nor `VITE_GIT_SHA` is set outside the Docker build, so both sides fall back to `"dev"`. Client and server therefore always match in `npm run dev` / `cargo run`, and polling never fires a spurious reload locally.

## 3. Polling behavior

- A hook (`useVersionWatch`), mounted once at the app root (`App.tsx` or `main.tsx`), performs an immediate check on load, then polls `GET /api/version` every 5 minutes.
- Uses the Page Visibility API: the interval is cleared while `document.hidden` is true, and a fresh check fires immediately on the `visibilitychange` event when the tab becomes visible again. A backgrounded tab does zero polling; switching back to it catches up right away.
- Compares the fetched `version` against `import.meta.env.VITE_GIT_SHA`, captured once at load. On the first mismatch, sets an in-memory "stale" flag (e.g. a module-level ref or minimal context value) — nothing else happens until the next qualifying interaction (§4).
- Network failures fetching `/api/version` are logged and swallowed, not surfaced to the user — the next interval simply tries again.

## 4. Reload trigger

- Once "stale," a single `click` listener attached to `document` in the bubble phase (so it runs after the app's own click handlers — letting that click's own effect, e.g. an API save, fire first) checks two things: is the stale flag set, and is `event.target` outside any `input`, `textarea`, or `[contenteditable]` element?
- If both are true: `window.location.reload()`.
- Practical effect: starting to type, clicking to position a cursor, or clicking inside any text field never triggers a reload. Clicking a button, link, checkbox, or drag handle does.
- No banner and no confirmation dialog — the reload is silent by design. This app's field edits already save immediately per-field/per-action (not batched into a larger unsaved draft), so there's minimal in-flight state a reload could lose, and letting the triggering click's own handler run first (rather than pre-empting it) means the action that was clicked still completes normally before the page reloads.
- `window.location.reload()` preserves the current URL, so the user lands back on the same page/project after refresh.

## 5. Relationship to push notifications

This design deliberately never polls or fetches `GET /api/projects/:id` (or any other route with the notification-clearing side effect described in `2026-08-07-push-notifications-design.md` §4–5) for version detection. `/api/version` is fully separate and side-effect-free, so this polling cannot itself cause the notification-debounce-defeating scenario described during design (repeated clearing of `notified_at` turning one debounced push into a push-per-poll-cycle). See Non-goals above for the pre-existing risk this spec deliberately leaves untouched.

## 6. Testing

- **Backend:** a handler test asserting `GET /api/version` returns the `GIT_SHA` env var's value when set, falls back to `"dev"` when unset, and touches no DB state (consistent with the repo's existing sparse-but-targeted testing approach, per the push-notifications spec's precedent).
- **Frontend:** a component/hook test for `useVersionWatch` — mocking `fetch` and `document.visibilityState` — asserting: polling starts on mount, stops while hidden, does an immediate check on becoming visible, and that a click outside vs. inside a text input does/doesn't call `location.reload()` once stale.
- **Manual:** verify end-to-end against a real deploy once implemented — load the app, ship a new image, confirm a click reloads to the new build within one poll interval (or immediately if the tab was hidden and refocused).

## 7. Ops

No new services, no schema changes. `build-and-push.yml` gains a `--build-arg GIT_SHA=${{ github.sha }}` (or equivalent `docker/build-push-action` `build-args` entry); `Dockerfile` gains an `ARG GIT_SHA` in both the `frontend-builder` stage (exported as `VITE_GIT_SHA` before `npm run build`) and the runtime stage (`ENV GIT_SHA=$GIT_SHA`). No changes to `docker-compose.prod.yml`, `deploy/admin.sh`, or `.env` — `GIT_SHA` is baked into the image at build time, not a deploy-time secret.
