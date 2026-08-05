# Phase 2 — Theming Design Spec

**Goal:** Replace the current dark theme with a light slate-blue theme. Introduce a CSS custom-property token layer (Tailwind v4 `@theme`) so future theme switching requires only a new token block, not component edits. Apply Inter as the app font, establish a three-level type scale, and constrain layout to a readable max-width.

**Scope:** All V and T items from `docs/design-review.md` (V1–V7, T1–T4). T5 was completed in Phase 1.

**Not in scope:** Dark mode, user-selectable themes (planned for a future phase — the token layer makes this straightforward to add).

---

## 1. Token Layer

All tokens live in a single `@theme {}` block in `frontend/src/index.css`. Tailwind v4 generates `bg-*`, `text-*`, `border-*`, and `ring-*` utility classes automatically from every `--color-*` entry. `App.css` (dead Vite scaffold) is deleted entirely.

### Structural tokens

| Token | CSS variable | Light value | Tailwind equiv | Role |
|---|---|---|---|---|
| canvas | `--color-canvas` | `#f1f5f9` | slate-100 | Page background |
| surface | `--color-surface` | `#ffffff` | white | Cards, panels, modals |
| surface-raised | `--color-surface-raised` | `#f8fafc` | slate-50 | Hover state on surface |
| border | `--color-border` | `#e2e8f0` | slate-200 | Default borders, dividers |
| border-strong | `--color-border-strong` | `#cbd5e1` | slate-300 | Emphasized borders |
| text | `--color-text` | `#0f172a` | slate-900 | Primary body text |
| muted | `--color-muted` | `#64748b` | slate-500 | Secondary/metadata text |

### Accent tokens

| Token | CSS variable | Light value | Tailwind equiv | Role |
|---|---|---|---|---|
| accent | `--color-accent` | `#4f46e5` | indigo-600 | Buttons, focus rings, active tab indicator |
| accent-hover | `--color-accent-hover` | `#4338ca` | indigo-700 | Hover on accent elements |
| accent-muted | `--color-accent-muted` | `#6366f1` | indigo-500 | Accent-colored text on light backgrounds |
| accent-subtle | `--color-accent-subtle` | `#eef2ff` | indigo-50 | Badge/chip backgrounds, active tab bg |

### Semantic tokens

| Token | CSS variable | Light value | Role |
|---|---|---|---|
| danger | `--color-danger` | `#ef4444` | Delete buttons, error states |
| danger-subtle | `--color-danger-subtle` | `#fef2f2` | Error message backgrounds |
| success | `--color-success` | `#22c55e` | Done status, active project badge |
| success-subtle | `--color-success-subtle` | `#f0fdf4` | Success state backgrounds |

### Priority tokens

| Token | CSS variable | Light value | Tailwind equiv |
|---|---|---|---|
| priority-low | `--color-priority-low` | `#94a3b8` | slate-400 |
| priority-normal | `--color-priority-normal` | `#38bdf8` | sky-400 |
| priority-high | `--color-priority-high` | `#f59e0b` | amber-500 |
| priority-urgent | `--color-priority-urgent` | `#ef4444` | red-500 |

### Future theme switching

Adding a dark theme later requires only:

```css
[data-theme="dark"] {
  --color-canvas: #0f172a;
  --color-surface: #1e293b;
  /* ... redefine each token ... */
}
```

No component files need to change.

---

## 2. Typography

### Font

Install `@fontsource-variable/inter` and import it before the Tailwind import in `index.css`. Register as the default sans-serif via `--font-sans` in `@theme`.

```css
@import "@fontsource-variable/inter";
@import "tailwindcss";

@theme {
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  /* ... color tokens ... */
}
```

### Type scale

Three levels, replacing the current effectively-two-level scale:

| Level | Tailwind classes | Used for |
|---|---|---|
| Page title | `text-2xl font-semibold` | "Your Projects" heading, project name in header |
| Section header | `text-base font-semibold` | Milestone names (up from `text-sm`) |
| Body / task content | `text-sm font-medium` | Task titles (up from `text-sm` regular) |
| Metadata | `text-xs text-muted` | Dates, counts, status badges, assignee names |

`font-bold` is reserved for maximum-emphasis cases; `font-semibold` carries headings throughout.

---

## 3. Layout & Spacing

### Max-width

Both dashboard and project page content areas get a `max-w-6xl mx-auto` wrapper inside the existing `px-8` padding. This caps readable content at 1152px on wide monitors without changing layout structure.

### Spacing philosophy

Soft 8-point standard: all classes use multiples of 2 (`p-2`, `p-4`, `p-6`, `p-8`). We do not audit every existing spacing value for a grand normalization — only classes touched during the token sweep are updated. The inconsistencies are minor and a wholesale spacing rewrite risks regressions for little visible gain.

### Task row height

List view task rows: `py-2` → `py-2.5` for slightly more breathing room in dense milestone sections.

---

## 4. Component Mapping

Full class-level mapping for each component file. The `InlineEdit` component itself is unchanged — it passes `className` through from callers.

**Global rule:** All `font-bold` on headings and titles → `font-semibold`. The only exception would be a case where maximum-weight emphasis is genuinely needed, which doesn't exist in the current codebase.

**Max-width wrapper:** In `Dashboard.tsx`, the `<div className="px-8 py-6">` content div gains `max-w-6xl mx-auto`. In `Project.tsx`, the `<div className="px-8 py-4">` view content div and the `<div className="px-8 py-6 border-b ...">` header div each gain `max-w-6xl mx-auto`.

### `App.tsx` (loading spinners)
- `bg-slate-900` → `bg-canvas`
- Spinner: `border-emerald-500` → `border-accent`

### `Login.tsx`
- Page bg: `bg-slate-900` → `bg-canvas`
- Card: `bg-slate-800` → `bg-surface shadow-sm border border-border`
- Heading: `text-white` → `text-text`
- Subheading: `text-slate-400` → `text-muted`
- Inputs: `bg-slate-700 border-slate-600 text-white focus:border-emerald-500` → `bg-surface border-border text-text focus:border-accent`
- Labels: `text-slate-300` → `text-text`
- Submit button: `bg-emerald-500 hover:bg-emerald-600` → `bg-accent hover:bg-accent-hover`
- Error: `text-red-400 bg-red-400/10` → `text-danger bg-danger-subtle`

### `Dashboard.tsx`
- Page bg: `bg-slate-900` → `bg-canvas`
- Nav bar: `border-slate-800` → `border-border shadow-sm bg-surface`
- App name: `text-white` → `text-text`
- "Sign out": `text-slate-400 hover:text-white` → `text-muted hover:text-text`
- "Your Projects" heading: `text-white` → `text-text`
- "New Project" button: `bg-emerald-500 hover:bg-emerald-600` → `bg-accent hover:bg-accent-hover`
- Project cards: `bg-slate-800 hover:bg-slate-700` → `bg-surface hover:bg-surface-raised border border-border shadow-sm`
- Card project name: `text-white` → `text-text`
- Card description: `text-slate-400` → `text-muted`
- Card date (normal): `text-slate-400` → `text-muted`
- Card date (overdue): `text-red-400` → `text-danger`
- Card footer metadata: `text-slate-400` → `text-muted`
- Active status badge: `bg-emerald-500/20 text-emerald-400` → `bg-success-subtle text-success`
- Inactive status badge: `bg-slate-700 text-slate-400` → `bg-canvas border border-border text-muted`
- Empty state text: `text-slate-400` → `text-muted`
- Empty state link: `text-emerald-400` → `text-accent-muted`
- Modal backdrop: `bg-black/50` → `bg-text/40`
- Modal panel: `bg-slate-800` → `bg-surface border border-border shadow-xl`
- Modal heading: `text-white` (implicit) → `text-text`
- Modal inputs/textarea: same as Login inputs
- Cancel button: `text-slate-400` → `text-muted hover:text-text`

### `Project.tsx`
- Page bg: `bg-slate-900` → `bg-canvas`
- Header border: `border-slate-800` → `border-border`
- "← All Projects" link: `text-slate-400 hover:text-white` → `text-muted hover:text-accent-muted`
- Project name: `text-white` → `text-text`
- Project description: `text-slate-400` → `text-muted`
- Active tab: `bg-slate-700 text-white` → `bg-accent-subtle text-accent font-medium`
- Inactive tab: `text-slate-400 hover:text-white` → `text-muted hover:text-text`

### `ListView.tsx`
- Milestone section: `bg-slate-800/50 rounded-xl` → `bg-surface border border-border shadow-sm rounded-xl`
- Drag handle: `text-slate-600 hover:text-slate-400` → `text-border-strong hover:text-muted`
- Collapse toggle: `text-slate-400 hover:text-white` → `text-muted hover:text-text`
- Milestone name (InlineEdit className): `bg-transparent text-white font-semibold` → `bg-transparent text-text font-semibold text-base`
- Milestone date (normal): `text-slate-400` → `text-muted`
- Milestone date (overdue): `text-red-400` → `text-danger`
- Task count: `text-slate-500` → `text-muted`
- Task row hover: `hover:bg-slate-800` → `hover:bg-surface-raised`
- Task drag handle: `text-slate-700 hover:text-slate-500` → `text-border hover:text-muted`
- Checkbox: `accent-emerald-500` → `accent-accent`
- Task title button: `text-white hover:text-emerald-400` → `text-text font-medium hover:text-accent-muted`
- Priority dots map: `bg-slate-500 / bg-blue-500 / bg-amber-500 / bg-red-500` → `bg-priority-low / bg-priority-normal / bg-priority-high / bg-priority-urgent`
- Due date (normal): `text-slate-400` → `text-muted`
- Due date (overdue): `text-red-400` → `text-danger`
- Assignee avatars: `bg-slate-600 text-white border-slate-800` → `bg-border-strong text-text border-surface`
- "Add a task…" input: `text-slate-400 placeholder-slate-600` → `text-muted placeholder:text-border-strong`
- "+ Add milestone" button: `text-slate-400 hover:text-emerald-400` → `text-muted hover:text-accent-muted`
- Add milestone form input: `bg-slate-800 border-slate-600 focus:border-emerald-500` → `bg-surface border-border focus:border-accent`
- Add milestone submit: `bg-emerald-500` → `bg-accent`
- Empty state: `text-slate-400` → `text-muted`

### `KanbanBoard.tsx`
- Column bg: `bg-slate-800/50` → `bg-surface border border-border shadow-sm`
- Column `isOver` state: `bg-slate-700/50` → `bg-accent-subtle`
- Column heading: `text-white` → `text-text`
- Count badge: `bg-slate-700 text-slate-400` → `bg-canvas text-muted`
- "No tasks" placeholder: `text-slate-600` → `text-muted`

### `KanbanCard.tsx`
- Card: `bg-slate-800 hover:bg-slate-700` → `bg-canvas hover:bg-surface-raised border border-border shadow-sm`
- Card title: `text-white` → `text-text font-medium`
- Milestone badge: `bg-slate-700 text-slate-300` → `bg-accent-subtle text-accent-muted`
- Priority dots: same remap as ListView
- Due date (normal): `text-slate-400` → `text-muted`
- Due date (overdue): `text-red-400` → `text-danger`
- Assignee avatars: `bg-slate-600 text-white border-slate-800` → `bg-border-strong text-text border-surface`

### `TaskDetailModal.tsx`
- Backdrop: `bg-black/50` → `bg-text/40`
- Panel: `bg-slate-800` → `bg-surface border border-border shadow-xl`
- Title input: `text-white border-slate-600 focus:border-emerald-500` → `text-text border-border focus:border-accent`
- Description textarea: `bg-slate-700 text-white border-slate-600 focus:border-emerald-500` → `bg-canvas text-text border-border focus:border-accent`
- Field labels: `text-slate-400` → `text-muted`
- Status/Priority/Milestone selects: `bg-slate-700 text-white border-slate-600` → `bg-canvas text-text border-border`
- Due date input: `bg-slate-700 text-white border-slate-600` → `bg-canvas text-text border-border`
- Assignee chips: `bg-slate-700 text-white` → `bg-accent-subtle text-accent-muted`
- Remove assignee `×`: `text-slate-400 hover:text-white` → `text-muted hover:text-text`
- Assign dropdown: `bg-slate-700 text-white border-slate-600` → `bg-canvas text-text border-border`
- Divider: `border-slate-700` → `border-border`
- "Delete task" button: `text-red-400 hover:text-red-300` → `text-danger hover:text-danger`
- Delete confirmation text: `text-slate-400` → `text-muted`
- Close `×` button: `text-slate-400 hover:text-white` → `text-muted hover:text-text`

---

## 5. App Operations Cheat Sheet

A quick reference for running, building, and managing the app locally.

### Running locally (development)

Requires: Rust toolchain, Node.js 22+, `sqlx-cli`.

```bash
# One-time setup: create and migrate the database
export DATABASE_URL=sqlite:./todo.db
sqlx database create && sqlx migrate run

# Create a user (one-time or as needed)
cargo run -- user create <username> <email> <password>

# Terminal 1 — backend (API server on :3000)
DATABASE_URL=sqlite:./todo.db cargo run -- serve

# Terminal 2 — frontend dev server (UI on :5173, proxies /api to :3000)
cd frontend && npm run dev
```

Open **http://localhost:5173**

### Running with Docker Compose

```bash
# Start everything (builds images on first run, ~2–3 min)
docker compose up

# Rebuild after code changes
docker compose up --build

# Run in background
docker compose up -d

# Tail logs
docker compose logs -f app
```

Open **http://localhost:8080**. Default credentials: `testuser` / `changeme`.

### User management (local)

```bash
export DATABASE_URL=sqlite:./todo.db

cargo run -- user list
cargo run -- user create <username> <email> <password>
cargo run -- user set-password <username> <newpassword>
cargo run -- user delete <username>
```

### User management (Docker)

```bash
# Uses the same volume as the running app
docker compose run --rm init-user ./little-orderings user list
docker compose run --rm init-user ./little-orderings user create alice alice@example.com s3cr3t
docker compose run --rm init-user ./little-orderings user set-password alice newpass
docker compose run --rm init-user ./little-orderings user delete alice
```

### Frontend only

```bash
cd frontend

npm run dev        # dev server with hot reload
npm run build      # production build → frontend/dist/
npm test           # run test suite (Vitest)
npm run test:watch # watch mode
```

### Backend only

```bash
cargo build             # debug build
cargo build --release   # production build
cargo test              # run tests
cargo run -- serve      # start API server
```

### Environment variables (local .env file)

Create `frontend/.env.local` if you need to override the dev proxy target:
```
VITE_API_BASE=http://localhost:3000
```

Backend reads from environment or a `.env` file at the repo root:
```
DATABASE_URL=sqlite:./todo.db
SESSION_SECRET=any-long-random-string
HOST=127.0.0.1
PORT=3000
ALLOWED_ORIGIN=http://localhost:5173
RUST_LOG=info
```
