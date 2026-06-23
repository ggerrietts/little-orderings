# Little Orderings — Design Improvement Checklist

Organized into phases. Each phase is a coherent unit of work with a clear before/after. See `design-review.md` for the full rationale behind each item.

---

## Phases

- [x] **Phase 1 — Quick Wins**
- [ ] **Phase 2 — Visual Foundation** (theme tokens, light theme, font, accent, layout) ← current
- [ ] **Phase 3 — Missing CRUD** (project & milestone editing and deletion)
- [ ] **Phase 4 — Kanban & Navigation** (add task, filters, back link, empty states)
- [ ] **Phase 5 — Interaction Polish** (auto-save feedback, icons, drag handles, delete flow)
- [ ] **Phase 6 — Accessibility** (focus-visible styles, form labels)
- [ ] **Phase 7 — Feature Gaps** (search, My Tasks, activity log, labels, progress bars)

---

## Phase 1 — Quick Wins

Small, self-contained changes. Each is a few lines of code. No design system changes required.

- [x] **N1** Add a "← All Projects" link to the project page header (back to dashboard)
- [x] **P2** Add an × close button to the top-right corner of the task detail modal
- [x] **P3** Replace `window.confirm()` on task delete with an inline confirmation (expand button to "[Cancel] [Delete]" row)
- [x] **P5** Add `hover:underline` to the milestone name span so click-to-edit is discoverable
- [x] **K3** Give empty Kanban columns a `min-h-32` and a "No tasks" placeholder text
- [x] **A3** Add `title="Low priority"` / `"Normal priority"` / etc. to priority dot spans
- [x] **T5** Shrink the login page app name from `text-3xl` to `text-2xl`
- [x] **A2** Add `<label>` elements to the Create Project modal inputs (name, description, target date)
