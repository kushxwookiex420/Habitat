CREATE TABLE IF NOT EXISTS habitat_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS habitat_tasks_status_updated_at
  ON habitat_tasks(status, updated_at DESC);
