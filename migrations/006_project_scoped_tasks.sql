-- Tasks become project-scoped directly; milestone becomes an optional tag
-- rather than a required container. sort_order changes from per-milestone
-- to project-wide.

-- Add project_id nullable first (SQLite can't add a NOT NULL column
-- without a static default; this needs a computed backfill instead).
ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id);

UPDATE tasks
SET project_id = (SELECT project_id FROM milestones WHERE milestones.id = tasks.milestone_id);

-- Rebuild the table to: make project_id NOT NULL, make milestone_id
-- nullable, and change milestone_id's delete behavior from CASCADE to SET
-- NULL (deleting a milestone should untag its tasks, not delete them).
-- SQLite's ALTER TABLE can't change a column's nullability or foreign key
-- clause in place, so this needs the standard rebuild pattern.
CREATE TABLE tasks_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'todo',
    priority     TEXT NOT NULL DEFAULT 'normal',
    due_date     DATE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tasks_new (id, project_id, milestone_id, title, description, status,
                        priority, due_date, sort_order, created_by, created_at, updated_at)
SELECT id, project_id, milestone_id, title, description, status,
       priority, due_date, sort_order, created_by, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- Rebuilding the table drops its indexes and triggers along with it —
-- recreate them (index from migration 001, trigger from migration 002).
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TRIGGER tasks_updated_at
AFTER UPDATE ON tasks
BEGIN
    UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Renumber sort_order project-wide. Every task at this point still has a
-- milestone (this migration runs before any task can exist without one),
-- so order by each task's milestone's own sort_order, then the task's old
-- per-milestone sort_order, then id — this reproduces today's
-- milestone-grouped visual order as the initial flat project-wide order.
WITH ranked AS (
    SELECT t.id,
           ROW_NUMBER() OVER (
               PARTITION BY t.project_id
               ORDER BY m.sort_order, t.sort_order, t.id
           ) - 1 AS new_order
    FROM tasks t
    JOIN milestones m ON m.id = t.milestone_id
)
UPDATE tasks
SET sort_order = (SELECT new_order FROM ranked WHERE ranked.id = tasks.id)
WHERE id IN (SELECT id FROM ranked);
