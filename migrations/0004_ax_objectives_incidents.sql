-- Mission 10 additive schema: durable objectives and operational incidents.
--
-- Every statement is CREATE ... IF NOT EXISTS. No existing table is dropped, renamed or altered,
-- and no task or memory table is touched. The repositories create the same objects on boot, so
-- running this file by hand is optional; it exists for an operator who wants the schema in place
-- before the first deploy that uses it.

CREATE TABLE IF NOT EXISTS habitat_ax_objectives (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_objectives_updated_at ON habitat_ax_objectives(updated_at DESC);
CREATE INDEX IF NOT EXISTS habitat_ax_objectives_status ON habitat_ax_objectives(status);

CREATE TABLE IF NOT EXISTS habitat_ax_incidents (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_incidents_fingerprint ON habitat_ax_incidents(fingerprint);
CREATE INDEX IF NOT EXISTS habitat_ax_incidents_created_at ON habitat_ax_incidents(created_at DESC);
