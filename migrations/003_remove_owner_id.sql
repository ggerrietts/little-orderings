-- Remove the redundant owner_id column from projects.
-- Ownership is authoritative in project_members (role = 'owner');
-- owner_id was never used in queries and would drift on ownership transfer.
ALTER TABLE projects DROP COLUMN owner_id;
