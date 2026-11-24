-- Durable workforce: adapters, agent records, assignments, results and an append-only audit trail.
--
-- Additive and idempotent only. Nothing here drops, renames or rewrites an existing table, so
-- re-applying the whole migration set is a no-op rather than an error.
--
-- Why these tables exist rather than a JSON blob per agent: assignment state is queried (what is
-- active, who is loaded, which task already has a live assignment), and a partial unique index is what
-- makes "one active assignment per task" a database guarantee instead of a hopeful convention.

CREATE TABLE IF NOT EXISTS habitat_ax_worker_adapters (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  replaceable INTEGER NOT NULL,
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habitat_ax_workers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  specialty TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  health_status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_workers_specialty
  ON habitat_ax_workers(specialty, health_status);

CREATE TABLE IF NOT EXISTS habitat_ax_worker_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  workspace_key TEXT,
  attempts INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One live assignment per task: a retried intake, a restarted process or two schedulers racing cannot
-- create a second worker for the same task. Released/handed-off rows stay for history.
CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_worker_assignments_active_task
  ON habitat_ax_worker_assignments(task_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS habitat_ax_worker_assignments_agent
  ON habitat_ax_worker_assignments(agent_id, state);

CREATE TABLE IF NOT EXISTS habitat_ax_worker_results (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  verifier_agent_id TEXT,
  status TEXT NOT NULL,
  approval_state TEXT NOT NULL,
  record_json TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_worker_results_task
  ON habitat_ax_worker_results(task_id, at DESC);

-- Append-only. A sequence column, not a timestamp, so the order of two events in the same millisecond
-- is still deterministic.
CREATE TABLE IF NOT EXISTS habitat_ax_worker_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_worker_audit_action
  ON habitat_ax_worker_audit(action, seq);
