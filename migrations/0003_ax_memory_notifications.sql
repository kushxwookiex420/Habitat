-- Mission 09 additive schema for Ax memory and notification events.
--
-- Every statement is CREATE ... IF NOT EXISTS. Nothing here drops, renames or alters an existing
-- table, and no task table is touched. The repositories create the same objects on boot, so running
-- this file by hand is optional; it exists so a D1 console operator can create the schema before a
-- first deploy without running application code.

CREATE TABLE IF NOT EXISTS habitat_ax_memory (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  mem_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  provenance TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  confidence REAL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_memory_project_key
  ON habitat_ax_memory(project, mem_key);

CREATE TABLE IF NOT EXISTS habitat_ax_memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  project TEXT NOT NULL,
  mem_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  provenance TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  action TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habitat_ax_notifications (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  dedupe_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  ack_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_notifications_dedupe
  ON habitat_ax_notifications(dedupe_key);
