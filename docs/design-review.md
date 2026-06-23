# Little Orderings — Design Review

*June 2026. Input from a UX critique agent and a visual design critique agent, synthesized into a change catalog.*

---

## Background

This review was conducted after completing the frontend MVP (Tasks 1–12 of `plans/2026-05-15-frontend-mvp.md`). The app is functional but has not had a design pass. Two independent review agents evaluated the codebase: one focused on UX workflow and interaction quality, one on visual design and the path toward a light slate-blue theme.

---

## Summary Findings

Both agents converged on the same top-level problems:

1. **Missing CRUD operations** make the app feel unfinished. Projects and milestones cannot be edited or deleted from the UI. Users are one mistyped name away from a permanent CLI fix.
2. **Auto-save with no feedback** is the single biggest interaction trust issue. Every field in the task modal saves silently; users cannot confirm their edits persisted.
3. **Emerald accent + dark theme** are coherent internally but wrong for the desired direction. Moving to a light slate-blue theme requires a CSS token layer first, or the refactor becomes a component-by-component grep.
4. **The Kanban board is read-only** — no task creation, no milestone filter, no meaningful empty states.
5. **No navigation back to the dashboard** from a project page.

---

## Change Catalog

Items are numbered with a category prefix. Priority: HIGH / MEDIUM / LOW. ×2 = flagged by both agents.

### C — Critical Missing CRUD

| ID | Description | Priority |
|----|-------------|----------|
| C1 | Project editing — name, description, status, target date editable from project page header | HIGH ×2 |
| C2 | Milestone deletion — ⋯ overflow menu with Delete; warn when tasks exist | HIGH |
| C3 | Milestone field editing — description, status, target date (beyond just name) | MEDIUM |
| C4 | Project archive/close — change status from dashboard; filter to hide archived | LOW |

### N — Navigation & Wayfinding

| ID | Description | Priority |
|----|-------------|----------|
| N1 | Back-to-dashboard link on project page | HIGH ×2 |
| N2 | Breadcrumb: All Projects / Project Name | MEDIUM |

### P — Interaction Polish & Feedback

| ID | Description | Priority |
|----|-------------|----------|
| P1 | Auto-save confirmation in task modal (field border flash or "All changes saved" status line) | HIGH ×2 |
| P2 | Explicit × close button on task modal | HIGH ×2 |
| P3 | Replace `window.confirm()` on task delete with in-modal confirmation or undo toast | HIGH ×2 |
| P4 | Add-task input needs submit button or submit-on-blur with non-empty guard | MEDIUM |
| P5 | Milestone name inline-edit affordance: `hover:underline` or pencil hint | MEDIUM ×2 |
| P6 | Task drag handles always visible at muted opacity; milestone handles consistent with task handles | MEDIUM ×2 |
| P7 | Replace ⠿ and ▶/▼ with SVG grip icon and animated chevron | MEDIUM ×2 |
| P8 | Inline-edit (milestones) vs. modal-edit (tasks) inconsistency — add pencil affordance to teach the gesture | MEDIUM |
| P9 | Keyboard shortcut for new task (N key when not in an input) | LOW |

### K — Kanban Gaps

| ID | Description | Priority |
|----|-------------|----------|
| K1 | Add task from Kanban — "Add card" at column bottom, status pre-filled, milestone required | HIGH |
| K2 | Milestone filter dropdown on Kanban header | MEDIUM |
| K3 | Empty Kanban column min-height + "No tasks" placeholder | MEDIUM ×2 |
| K4 | Cancelled tasks: "N tasks hidden — show" toggle or muted Cancelled column | MEDIUM |
| K5 | Cross-milestone drag in List view (or prominent move via task modal) | MEDIUM |
| K6 | Milestone badge colored red on Kanban card when milestone is overdue | LOW |

### V — Visual Foundation

| ID | Description | Priority |
|----|-------------|----------|
| V1 | CSS custom property token layer via Tailwind v4 `@theme` (`--color-bg`, `--color-surface`, `--color-border`, `--color-accent`, `--color-text-*`) | HIGH |
| V2 | Light theme palette: `slate-100` bg, `white` surface, `slate-200` borders, `indigo-600` accent | HIGH |
| V3 | Load Inter via fontsource at weights 400/500/600/700 | HIGH |
| V4 | Swap emerald accent → indigo across all components (buttons, focus rings, checkboxes, spinner) | HIGH |
| V5 | Max-width: `max-w-6xl mx-auto` wrapper on dashboard and project page content | HIGH |
| V6 | Priority color ramp: `slate-400` (low) → `sky-400` (normal) → `amber-500` (high) → `red-500` (urgent) | MEDIUM |
| V7 | Status badge rework: opaque tinted chips (`bg-indigo-100 text-indigo-700`) for light backgrounds | MEDIUM |

### T — Typography & Layout

| ID | Description | Priority |
|----|-------------|----------|
| T1 | Three-level type scale: `text-xl font-semibold` pages, `text-base font-semibold` sections, `text-sm` body | MEDIUM |
| T2 | Task titles promoted to `font-medium` to distinguish primary content from metadata | MEDIUM |
| T3 | Consistent padding on 8-point grid across nav, header, modal, columns | MEDIUM |
| T4 | Task row height: `py-2` → `py-2.5` or `py-3` | LOW |
| T5 | Login title: `text-3xl` → `text-2xl` | LOW |

### A — Accessibility

| ID | Description | Priority |
|----|-------------|----------|
| A1 | `focus-visible:ring-2` on all interactive elements; remove bare `focus:outline-none` | HIGH |
| A2 | Label all CreateProjectModal inputs (match TaskDetailModal pattern) | MEDIUM |
| A3 | Priority dot `title` attribute ("High priority", etc.) | LOW |
| A4 | Custom checkbox component for consistent cross-browser rendering | LOW |

### F — Feature Gaps (future phases)

| ID | Description | Priority |
|----|-------------|----------|
| F1 | Task search / real-time filter within a project | HIGH |
| F2 | "My Tasks" cross-project view on dashboard or top nav | HIGH |
| F3 | Activity log on tasks: field-change history + freeform comments | MEDIUM |
| F4 | Task labels/tags: freeform, create-on-type, color-coded | MEDIUM |
| F5 | Milestone progress bar (completed / total tasks) in header and on dashboard cards | MEDIUM |
| F6 | Task checklist / subtasks as interactive Markdown checkboxes in description | LOW |
| F7 | User password-change UI (currently admin CLI only) | LOW |

---

## Visual Direction Statement

*(From the visual design agent)*

Anchor the palette in `slate-100` page background, `white` card surfaces, and `slate-200` borders. Use **indigo-600** (`#4f46e5`) as the primary interactive accent — it reads as "slate blue" in practice and pairs cleanly with cool neutrals at WCAG AA contrast. Load **Inter** at four weights and establish a three-level heading scale. Introduce a CSS custom property token layer via Tailwind v4's `@theme` block immediately, so a dark-mode theme can later be added by redefining those tokens under `[data-theme="dark"]` without touching component markup. Preserve the auto-save + inline-edit paradigm (correct for a focused tool) but add a brief "Saved" transition on field borders to make the model legible.
