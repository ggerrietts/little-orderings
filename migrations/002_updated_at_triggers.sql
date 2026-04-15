-- Automatically maintain updated_at on projects, milestones, and tasks.
-- Without these triggers, any UPDATE that omits the updated_at assignment
-- silently leaves a stale timestamp.

CREATE TRIGGER projects_updated_at
AFTER UPDATE ON projects
BEGIN
    UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER milestones_updated_at
AFTER UPDATE ON milestones
BEGIN
    UPDATE milestones SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER tasks_updated_at
AFTER UPDATE ON tasks
BEGIN
    UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
