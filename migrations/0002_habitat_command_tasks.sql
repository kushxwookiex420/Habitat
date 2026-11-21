-- Universal command tasks live in their own table so the existing worker-task routes and their
-- records keep their shape and status vocabulary. Applied automatically on first command request.
CREATE TABLE IF NOT EXISTS habitat_command_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS habitat_command_tasks_status_updated_at
  ON habitat_command_tasks(status, updated_at DESC);
