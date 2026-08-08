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
--
-- task_assignments.task_id REFERENCES tasks(id) ON DELETE CASCADE, and this
-- app always runs with foreign_keys=ON (including while migrations run —
-- src/db.rs sets the pragma on the connection options used for both).
-- SQLite's DROP TABLE performs an implicit "delete every row" on the table
-- being dropped when foreign_keys is on, which fires ON DELETE CASCADE on
-- any table that references it — so dropping the old `tasks` table
-- directly would silently wipe every row of task_assignments. To avoid
-- that, task_assignments is rebuilt in lockstep with tasks below, and the
-- old task_assignments table is dropped BEFORE the old tasks table: once
-- nothing references the old tasks table anymore, dropping it has nothing
-- left to cascade into.
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

-- Rebuild task_assignments too, referencing tasks_new. Its rows still
-- reference valid task ids either way, since tasks_new's ids are copied
-- verbatim from tasks above.
CREATE TABLE task_assignments_new (
    task_id     INTEGER NOT NULL REFERENCES tasks_new(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, user_id)
);

INSERT INTO task_assignments_new (task_id, user_id, assigned_at)
SELECT task_id, user_id, assigned_at FROM task_assignments;

-- Drop the child table (task_assignments) before the parent (tasks) —
-- nothing references task_assignments itself, so this drop is
-- unconditionally safe. Once it's gone, nothing references the old tasks
-- table either, so dropping tasks next is also safe.
DROP TABLE task_assignments;
DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE task_assignments_new RENAME TO task_assignments;

-- Rebuilding both tables drops their indexes and triggers along with
-- them — recreate all of them (idx_tasks_milestone and
-- idx_task_assignments_user from migration 001, tasks_updated_at from
-- migration 002).
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_task_assignments_user ON task_assignments(user_id);

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
