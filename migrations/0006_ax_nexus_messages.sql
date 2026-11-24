-- Mission 14 additive schema: the durable Ax <-> NEXUS message channel.
--
-- Every statement is CREATE ... IF NOT EXISTS. Nothing existing is dropped, renamed or altered,
-- and no task, memory, objective or device table is touched. The repository creates the same
-- objects on boot, so applying this file by hand is optional; it exists so an operator can put the
-- schema in place before the first deploy that uses it.
--
-- A row is one message. A thread is the set of rows sharing correlation_id, ordered by created_at.
-- `record_json` is the full record and is also the optimistic-concurrency token for every update.

CREATE TABLE IF NOT EXISTS habitat_ax_messages (
  id TEXT PRIMARY KEY NOT NULL,
  project TEXT NOT NULL,
  from_origin TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_messages_correlation
  ON habitat_ax_messages(correlation_id, created_at);

CREATE INDEX IF NOT EXISTS habitat_ax_messages_status_updated
  ON habitat_ax_messages(status, updated_at);

CREATE INDEX IF NOT EXISTS habitat_ax_messages_origin_created
  ON habitat_ax_messages(from_origin, created_at);
