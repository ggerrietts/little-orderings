# Deployment Brief — todo.gerrietts.net

Context handoff for Claude Code. Everything below assumes the server exists, Ubuntu
24.04 is installed, and SSH key auth works.

This supersedes an earlier draft that assumed a Leptos/WASM frontend — that was based
on old planning chats, not the code. The stack below is what's actually in the repo as
of 2026-08-05.

---

## 1. Target environment

| | |
|---|---|
| Host | Hetzner Cloud CX23 (2 vCPU shared, 4 GB RAM, 40 GB NVMe) |
| Region | Helsinki (EU) — ~100–130 ms RTT from US East |
| Arch | **x86_64** (CX line is Intel/AMD; if we ever move to CAX it becomes arm64) |
| OS | Ubuntu 24.04 LTS |
| Runtime | Docker Engine + Compose v2 plugin |
| Hostname | `todo.gerrietts.net` (A record → server IPv4) |
| Ports open | 22, 80, 443 only (Hetzner Cloud Firewall, deny-by-default inbound) |
| Data volume | Attached Hetzner Volume mounted at `/mnt/HC_Volume_106548799` — app + Caddy data live here, not the 40 GB root disk. Parametrized as `DATA_ROOT` (see §6). |
| Users | Currently **root only**. `deploy/provision-server.sh` (added 2026-08-05) creates a `deploy` user for `docker context` access — not yet run against the real box. |

**Constraint that shaped §5's decision:** 2 vCPU / 4 GB is enough to *run* the app
comfortably and not enough to *build* it comfortably — a cold Rust build with a fresh
`sqlx-cli` install would take several minutes and risk OOM. Resolved by never building
on this box at all: see §5. As of 2026-08-05 this server also holds **no source code
and no build tooling** — that was an explicit requirement, not just an optimization.

---

## 2. Stack (confirmed from code, not assumed)

- **Backend:** Rust, Axum 0.7, `sqlx` 0.8 (SQLite, compile-time checked queries)
- **Frontend:** React 19 + Vite, **client-side rendered only** — no SSR, no WASM, no
  Leptos. Built to static assets (`frontend/dist`) and served by the same Axum process
  via `tower-http::ServeDir`, with `index.html` as the SPA fallback for client-side
  routing.
- **Storage:** SQLite, single file on a volume
- **Auth:** session-cookie based, `argon2` password hashing, custom session table
- **Single binary + static asset bundle** — one Docker image contains everything; no
  separate frontend server, no CDN dependency, no build step at runtime.

Since frontend and API are served from the **same origin** in production (unlike local
dev, where Vite's dev server on :5173 proxies to Axum on :3000), most of the
cross-origin concerns in older drafts of this doc (CORS, `SameSite` cookie edge cases)
mostly don't apply once deployed — see §8.

---

## 3. Container image — already built, not hypothetical

`Dockerfile` at repo root, 3 stages, already working (verified locally):

1. **`frontend-builder`** (`node:22-alpine`) — `npm ci` + `npm run build` → `frontend/dist`
2. **`backend-builder`** (`rust:1.94-bookworm`) — installs `sqlx-cli`, spins up a
   throwaway SQLite DB and runs migrations against it so `sqlx`'s compile-time query
   macros can validate queries, then `cargo build --release`
3. **Runtime** (`debian:bookworm-slim`) — copies the binary and `frontend/dist`,
   installs only `libsqlite3-0` + `ca-certificates`, sets `HOST=0.0.0.0`, `PORT=3000`,
   `DATABASE_URL=sqlite:/data/todo.db`, `FRONTEND_DIST=/app/frontend/dist`

Already true, no action needed:
- ✅ `debian:bookworm-slim` runtime (not `scratch`/musl) — matches this doc's original
  recommendation, avoids the musl+SQLite allocator issue under load.
- ✅ `.dockerignore` now exists (added 2026-08-05) — excludes `target/`, `node_modules`,
  `.git`, docs, `.env`, `todo.db` from the build context.
- ✅ `Cargo.lock` is now tracked in git (was gitignored until 2026-08-05 — would have
  broken a from-clone build, since the Dockerfile `COPY`s it by name).
- ✅ **Runs as a non-root user** (added 2026-08-05): `app`, fixed uid/gid 10001.
  `/data` is `chown`'d to `app` in the image *before* it's used as a volume mount
  point. That "ownership copies into a fresh volume on first init" behavior is a
  **Docker-managed volume** feature — it's what the dev compose file gets, but the
  prod compose file bind-mounts an external directory on the attached volume instead
  (§6), and bind mounts do **not** get this treatment. For prod, ownership of that
  directory is instead set explicitly by `deploy/provision-server.sh` (`chown
  10001:10001`, kept in sync with this uid via its `APP_UID` var). Verified via
  `docker compose config`; `app` inherits the image's `USER app`.
- ✅ **`HEALTHCHECK`** added to the Dockerfile (`curl -f http://127.0.0.1:3000/health`,
  30s interval). `curl` added to the runtime image's apt install for this.

---

## 4. SQLite specifics

Current code (`src/db.rs`, runs on every startup including CLI subcommands):

```rust
let options = SqliteConnectOptions::from_str(&database_url)
    .create_if_missing(true)
    .pragma("foreign_keys", "ON");
let pool = SqlitePool::connect_with(options).await...;
sqlx::migrate!("./migrations").run(&pool).await...;
```

Already true:
- ✅ `foreign_keys=ON` — set exactly as this doc originally recommended.
- ✅ **Migrations run at startup**, embedded via `sqlx::migrate!` — no separate deploy
  step, no drift between image and `migrations/` dir. Also exactly as recommended.
- ✅ `DATABASE_URL=sqlite:/data/todo.db`, volume-backed, matches the plan.
- ✅ **`journal_mode=WAL`** — added 2026-08-05, verified locally (`-wal`/`-shm` files
  appear on startup).
- ✅ **`busy_timeout=5s`** — added alongside WAL.
- ✅ **`synchronous=NORMAL`** — added alongside WAL, the correct pairing.

Still open, not urgent:
- ⚠️ **Pool sizing not considered.** `SqlitePool` defaults to a small connection pool,
  which is fine for this app's concurrency level. Worth an explicit `max_connections`
  decision only if usage grows; no action needed now.

Volume gotchas:
- WAL creates `todo.db-wal` and `todo.db-shm` next to the main file — the **directory**
  needs to be writable, not just the db file. In prod, `/data` is bind-mounted to
  `${DATA_ROOT}/little-orderings/app-data`, `chown`'d to uid 10001 by the provisioning
  script (§3) — not the Docker-managed-volume auto-ownership trick, since this is a
  bind mount.

---

## 5. Build and deploy strategy — decided, revised 2026-08-05

Plain `docker compose up` is **not** the same thing as Docker Swarm's
`docker stack deploy`. The `deploy:` key in a Compose file (`replicas`,
`update_config`, `rollback_config`, `secrets`) is mostly Swarm-only — Swarm mode has to
be initialized (`docker swarm init`) even on a single node for most of it to do
anything, and stacks can't `build:` (images must be pre-built and pushed). That's more
machinery than a single-instance personal app needs.

The first version of this decision was "`docker context` now (building on the remote
daemon via `--build`), GHCR + Actions later." **Revised same day:** that still means
the source tree gets streamed to the server's Docker daemon and sits in its build
cache/layers, which conflicts with an explicit requirement — as little as possible on
the server, no source code, ever. So: **build off-box from the start, no on-box build
step at any point.**

- **GitHub Actions** (`.github/workflows/build-and-push.yml`, added 2026-08-05) builds
  the image on GitHub's runners on every push to `main` (or manual dispatch) and
  pushes to `ghcr.io/ggerrietts/little-orderings`, tagged `latest` and by git SHA.
  Source code touches GitHub's ephemeral runners, same as any normal CI build — never
  the server.
- **The server only ever runs** `docker compose -f docker-compose.prod.yml pull` then
  `up -d`. `docker-compose.prod.yml` now references `image: ghcr.io/...` for `app` —
  there's no `build:` key in that file at all, so it's not possible to accidentally
  build there even by habit (`up -d --build` on a compose file with no `build:` key is
  a no-op for that service).
- `docker context` is still useful — it's just scoped to `pull`/`up`, never `--build`,
  so no source ever transits it.
- **Decision (2026-08-06): the repo and its GHCR image are going public.** No
  registry login on the server, ever — `docker compose pull` works unauthenticated.
  The provisioning script's earlier optional GHCR-login step was removed for exactly
  this reason (see §9) — keeping unused auth logic around was against the "as little
  as possible on the server" goal that drove this whole section in the first place.
- Images are tagged by git SHA as well as `latest`, so rollback is "set `IMAGE_TAG` to
  a previous SHA and `up -d`" without rebuilding anything.

---

## 6. Compose topology

Two files now, deliberately kept separate rather than base+override (Compose's merge
semantics for removing/replacing keys like `ports:` are easy to get wrong; two
standalone files are easier to reason about):

- **`docker-compose.yml`** — unchanged, dev-oriented. `app` publishes `8080:3000`
  directly, placeholder `SESSION_SECRET`, hardcoded `testuser`/`changeme` login. Keep
  using this for local `docker compose up`.
- **`docker-compose.prod.yml`** — added 2026-08-05. Diffs from dev:
  - ✅ `app` uses `expose: ["3000"]`, **no host port published** — only `caddy` binds
    to the host, on 80/443. This was called out as the one item with real security
    consequences if skipped, and it's now closed.
  - ✅ `SESSION_SECRET` comes from `env_file: .env` — nothing sensitive is inline in
    the committed file. See `.env.example` (added) for what the server's real `.env`
    needs.
  - ✅ **`init-user` service removed (2026-08-06).** It bootstrapped an admin account
    from `ADMIN_USERNAME`/`ADMIN_EMAIL`/`ADMIN_PASSWORD` via a fixed
    `entrypoint: sh -c "..."`. Turned out that pattern silently ignores any command
    `docker compose run` appends (extra args become unused positional params inside
    the `sh -c` script), so it only ever worked for creating exactly the ADMIN_* user
    baked into `.env` — not a general mechanism, and misleading alongside the `user`
    CLI subcommand. Replaced by running `deploy/admin.sh add-user` once, manually,
    after the first deploy. `app`'s `depends_on: init-user` went with it.
  - ✅ `caddy` service added: `caddy:2-alpine`, volumes `caddy-data`/`caddy-config` for
    the TLS cert/account key so they survive restarts.
  - ✅ `restart: unless-stopped` on `app` and `caddy`.
  - ✅ `json-file` logging capped at `max-size: 10m, max-file: 3` on both services.
  - ✅ Healthcheck comes from the Dockerfile's `HEALTHCHECK` (§3) — no separate
    Compose-level `healthcheck:` needed since it's baked into the image.
  - ✅ **`app-data`/`caddy-data`/`caddy-config` are bind-mounted to the attached
    volume**, not Docker-managed named volumes — `local` driver with `driver_opts:
    {type: none, o: bind, device: ${DATA_ROOT:-/mnt/HC_Volume_106548799}/little-orderings/...}`.
    `DATA_ROOT` is read from `.env` (added to `.env.example`) so the compose file and
    `deploy/provision-server.sh` share one source of truth for the path. Validated with
    `docker compose config` using different `DATA_ROOT` values — interpolates
    correctly.
  - ✅ **`app` uses `image: ghcr.io/ggerrietts/little-orderings:${IMAGE_TAG:-latest}`**,
    no `build:` key at all (revised 2026-08-05, see §5) — this file cannot build,
    only pull and run.

**Getting the compose file, `Caddyfile`, and `.env.example` onto the server:**
`deploy/admin.sh sync` (added 2026-08-06) `scp`s all three from the repo to
`~/little-orderings` on the server — `docker-compose.prod.yml` renamed to
`docker-compose.yml` there, matching what `deploy/admin.sh restart` and the manual
`docker compose` commands below both expect to find. It never touches `.env` itself
(server-only, holds real secrets) — it just warns if `.env` doesn't exist yet so you
remember to create it from the freshly-synced `.env.example`.

Run production with `docker compose -f docker-compose.prod.yml pull && docker compose
-f docker-compose.prod.yml up -d` — deliberately two steps, not `up -d --build` (which
wouldn't build anything here anyway, but `pull` first makes the deploy's intent
explicit: fetch what CI already built, run it). The target directories must exist and
be owned correctly before first run — that's what `deploy/provision-server.sh` does
(§1, not yet run against the real box).

---

## 7. Caddyfile — added 2026-08-05

```
todo.gerrietts.net {
	encode zstd gzip
	reverse_proxy app:3000
}
```

Matches `docker-compose.prod.yml`'s `app` service, which listens on 3000 internally
(8080 was only ever the dev compose file's host-side mapping).

**Still to do on first real deploy:** use Caddy's staging CA
(`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` in a global options
block) for the first boot if there's any doubt DNS is live, then remove it and restart
for a real cert once confirmed.

---

## 8. Application-side changes — reassessed against actual code

| Item | Status |
|---|---|
| Bind `0.0.0.0`, configurable port | ✅ Done — `HOST`/`PORT` env vars, Dockerfile sets `HOST=0.0.0.0 PORT=3000` |
| `/health` endpoint | ✅ Exists (`GET /health` → `"ok"`, `src/main.rs`). ⚠️ Doesn't check the DB pool (`SELECT 1`) — currently returns 200 even if SQLite is wedged. Worth strengthening, not urgent. |
| Graceful shutdown | ✅ Added 2026-08-05 — `axum::serve(...).with_graceful_shutdown(...)` listens for both Ctrl+C and SIGTERM. Verified locally: process logs "shutdown signal received" and exits cleanly on `kill -TERM`, no lingering process. |
| Trust the proxy (`X-Forwarded-*`) | N/A currently — no code reads client IP or forwarded headers (no rate limiting, no IP-based audit logging). Not a gap because there's nothing depending on it yet; revisit if that changes. |
| Session cookies | ✅ Already correct: `HttpOnly`, `SameSite=Lax`, and `Secure` is added whenever it's a release build (`src/auth.rs:88`, keyed off `cfg!(debug_assertions)`, not a runtime TLS check). This means the cookie is always marked `Secure` in the Docker image, which is right for the intended topology (always behind Caddy's TLS) — just note if this binary is ever run directly without a TLS-terminating proxy in front, login cookies won't be set. |
| Config from environment | ✅ Already the case — `DATABASE_URL`, `SESSION_SECRET`, `HOST`, `PORT`, `ALLOWED_ORIGIN`, `FRONTEND_DIST`, `RUST_LOG` are all env-driven, no compiled-in secrets. |
| Structured logging | ✅ `tracing` + `tracing-subscriber` to stdout already in place; plain-text formatting, not JSON — fine for now per original doc's own call. |

---

## 9. Secrets

`.env.example` added 2026-08-05, documenting the pattern: copy to `.env` on the
server, `chmod 600`, referenced via `env_file:` in `docker-compose.prod.yml`.
**Never committed and never baked into the image.** (The repo's own dev `.env` is
gitignored already; the prod one is a separate, server-only file.)

Required contents (per `.env.example`): `SESSION_SECRET` (32+ random bytes, base64 —
generate on the server with `openssl rand -base64 32`, not locally, not in chat, not
in a commit) and `DATA_ROOT` (not sensitive, just kept here so it's one source of
truth with the provisioning script — see §6). No admin credentials go in `.env` —
the first account is created after the stack is up, by running
`deploy/admin.sh add-user <username> <email> <password>` once (see §6).

**No GHCR pull token.** Removed 2026-08-06 along with the repo going public — the
image is now anonymously pullable, so there's nothing to authenticate on this box at
all. `deploy/provision-server.sh` no longer has any registry-login logic; if this
repo/image ever goes private again, that step would need to be added back (a one-time
`docker login ghcr.io` as the `deploy` user, credentials cached in that user's own
Docker config — not via `.env`/`env_file:`, which would leak into the app containers'
environment for no reason).

---

## 10. Backups

Unchanged from original plan, still applies as-is — nothing in the codebase affects
this section:

Docker volumes are not backups. Minimum viable: a cron/systemd timer running
`sqlite3 /data/todo.db "VACUUM INTO '/backups/todo-$(date +%F).db'"`, retained ~14
days, **copied off the box**. `VACUUM INTO` is safe against a live WAL database; a raw
`cp` of the `.db` file is not (this becomes relevant once §4's WAL gap is closed).

Verify a restore actually works, once, before it's needed for real.

---

## 11. Suggested order of work (revised)

Struck-through items are done; the rest is what's actually left.

1. ~~Verify the frontend build shape~~ — confirmed: React/Vite CSR, not Leptos.
2. ~~Dockerfile + `.dockerignore`, confirm image builds~~ — done; `Cargo.lock` tracking
   fixed 2026-08-05 so a from-clone build won't break.
3. ~~App-side changes (§8): graceful shutdown~~ — done, verified locally.
4. ~~SQLite pragmas (§4): WAL + busy_timeout + synchronous=NORMAL~~ — done, verified
   locally.
5. ~~Decide the deploy mechanism (§5)~~ — decided, then revised same day: build
   off-box via GitHub Actions from the start, server only ever pulls. No on-box build
   step at any point, matching an explicit "as little as possible on the server, no
   source code" requirement.
6. ~~Prod Compose topology + Caddyfile (§6/§7)~~ — `docker-compose.prod.yml` (now
   `image:`-only, no `build:`), `Caddyfile`, `.env.example` all added 2026-08-05.
   Validated with `docker compose -f docker-compose.prod.yml config`; not yet run
   against the real server.
7. ~~Write the server provisioning script~~ — `deploy/provision-server.sh` added
   2026-08-05, revised twice same week: dropped the buildx plugin (nothing builds on
   this box); added, then removed, a GHCR login step (added 2026-08-05 while the repo
   was private, removed 2026-08-06 once the decision to go public made it dead code).
   Installs Docker + compose plugin only, creates the `deploy` user, configures `ufw`,
   creates and `chown`s the `DATA_ROOT` directories, sets up a swapfile (general
   safety margin now, not build-OOM avoidance — the reason that mattered is gone).
   Idempotent, not yet run against the real box.
8. ~~Write the GitHub Actions build/push workflow~~ — `.github/workflows/build-and-push.yml`
   added 2026-08-05: builds on `push` to `main` or manual dispatch, pushes to
   `ghcr.io/ggerrietts/little-orderings` tagged `latest` + git SHA, using the
   repo-scoped `GITHUB_TOKEN` (no extra secret needed to push).
9. ~~Sanitization pass before making the repo public~~ — done 2026-08-06: full-history
   scan for secrets, credentials, private keys, PII came back clean. Two minor items
   surfaced and were deliberately left as-is by choice: the old-employer commit-author
   email in early history, and the literal Hetzner volume ID as a default value.
10. ~~Get a first image into GHCR~~ — done 2026-08-06: merging the PR pushed to `main`,
    but the workflow didn't auto-fire on that push for unclear reasons (zero prior runs
    existed), so it was triggered manually via `workflow_dispatch`. Build succeeded;
    `ghcr.io/ggerrietts/little-orderings:latest` confirmed public via the GHCR API —
    no manual visibility toggle needed after all.
11. ~~Write admin tooling for day-2 operations~~ — `deploy/admin.sh` added 2026-08-06:
    `sync` (see §6), `restart` (pull + up -d), `add-user`, `set-password`. Runs from
    your local machine over SSH — deliberately **not** `docker context`, since
    `docker-compose.prod.yml` bind-mounts `./Caddyfile` and bind-mount sources are
    resolved by whichever engine executes the command. Pointing a local `docker
    compose` at a remote context via `docker context` would try to resolve that path
    against your local filesystem, not the server's — so compose has to actually run
    on the server. `deploy/provision-server.sh` creates the `deploy` user compose runs
    as; it doesn't need `docker context` to do that.
12. **Next:** run `deploy/provision-server.sh` against the real server (not yet done).
13. Confirm `dig todo.gerrietts.net` resolves **before** first deploy.
14. `deploy/admin.sh sync` to copy `docker-compose.prod.yml` → `docker-compose.yml`,
    `Caddyfile`, and `.env.example` to `~/little-orderings` on the server.
15. Create the real `.env` there from the synced `.env.example`
    (`SESSION_SECRET` via `openssl rand -base64 32`, confirm `DATA_ROOT`), `chmod 600`.
16. Deploy with ACME staging first if there's any doubt DNS is live (§7):
    `deploy/admin.sh restart` (pull + up -d), verify, switch to production CA.
17. `deploy/admin.sh add-user <username> <email> <password>` — create the first
    account. No more automatic bootstrap from `ADMIN_*` env vars (§6/§9).
18. Backups (§10) — still just documented, not automated. Log rotation is done (§6).

## Open decisions

- [x] ~~Build off-box (GHCR) vs on-box vs a dedicated deploy tool~~ — §5: fully
  off-box via GitHub Actions, decided and re-confirmed 2026-08-05
- [x] ~~Leptos SSR vs CSR~~ — resolved: React CSR, single Axum-served origin
- [x] ~~SQLite WAL/busy_timeout/synchronous~~ — done
- [x] ~~Non-root container user~~ — done
- [x] ~~How to provision the server (packages, non-root user, data volume)~~ — scripted
  in `deploy/provision-server.sh`, not yet executed
- [x] ~~GHCR package visibility~~ — decided 2026-08-06: public, matching the repo.
  Registry-login logic removed from the provisioning script. Confirmed already public
  via the GHCR API once the first image was pushed (§11) — no manual toggle needed.
- [x] ~~How to run day-2 admin commands (user management, restarts) against the
  server~~ — decided 2026-08-06: `deploy/admin.sh`, SSH-driven from the local
  machine, not `docker context` (§11).
- [x] ~~How the first admin account gets created~~ — decided 2026-08-06: manually,
  via `deploy/admin.sh add-user` after first deploy. The `init-user` service's
  automatic bootstrap was removed — its fixed entrypoint silently ignored any
  command appended to it, so it only ever worked for the exact `ADMIN_*` values in
  `.env`, never as a general mechanism (§6).
- [ ] Backup destination (Hetzner Storage Box vs S3 vs rsync target)
- [ ] Whether to add external uptime monitoring now or later
- [ ] Whether `/health` should check the DB pool (`SELECT 1`) — currently a static 200
- [ ] Whether to disable root SSH login once the `deploy` user is confirmed working —
  provisioning script deliberately leaves root login enabled for now, to avoid
  lockout risk on the first pass
