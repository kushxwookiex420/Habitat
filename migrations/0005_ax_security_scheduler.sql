-- Mission 11 additive schema: append-only security events and the scheduler tick lease.
--
-- Every statement is CREATE ... IF NOT EXISTS. Nothing existing is dropped, renamed or altered.
-- The repositories create the same objects on boot; this file exists for an operator who wants the
-- schema in place before the first deploy that uses it.

CREATE TABLE IF NOT EXISTS habitat_ax_security_events (
  id TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor TEXT,
  device_id TEXT,
  objective_id TEXT,
  run_id TEXT,
  task_id TEXT,
  correlation_id TEXT,
  record_json TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_security_events_seq
  ON habitat_ax_security_events(seq);
CREATE INDEX IF NOT EXISTS habitat_ax_security_events_created_at
  ON habitat_ax_security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS habitat_ax_security_events_category
  ON habitat_ax_security_events(category, seq DESC);

CREATE TABLE IF NOT EXISTS habitat_ax_scheduler (
  id TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL
);
