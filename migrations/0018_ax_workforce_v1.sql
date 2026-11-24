-- Autonomous workforce v1: worker identity, durable leases, execution idempotency and a recovery journal.
--
-- Additive and idempotent, like every Habitat migration. Nothing here alters 0010: the agent record stays
-- the workforce's identity (specialty, adapter, capabilities, permissions). This migration adds the layer
-- that turns an in-memory assignment into a durable, exclusive right to execute:
--
--   habitat_ax_workforce_workers      registration state, availability, heartbeat
--   habitat_ax_workforce_leases       one active lease per task, with an expiry and an owner
--   habitat_ax_workforce_executions   at-most-once ledger for external operations
--   habitat_ax_workforce_recovery     append-only journal of expiries, reassignments and resumes
--
-- Two guarantees are enforced by the database rather than by an application check, because two replicas
-- can always interleave between two checks:
--
--   * at most one active lease per task — the partial unique index below. Two workers racing INSERT for
--     the same task reach the same index and exactly one wins.
--   * at most one execution per attempt — the primary key of the executions table. A retried request
--     reaches the same row and is refused instead of calling the external operation twice.
--
-- Lease rows and execution rows are never deleted: they are the audit trail that proves an owner held a
-- task, for how long, and what happened to it. Expiry marks state; it does not remove history.

CREATE TABLE IF NOT EXISTS habitat_ax_workforce_workers (
  worker_id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  specialty TEXT NOT NULL,
  adapter_id TEXT,
  capabilities_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'online' CHECK (state IN ('online', 'busy', 'draining', 'unavailable', 'deregistered')),
  accepting INTEGER NOT NULL DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  heartbeat_at TEXT,
  registered_at TEXT NOT NULL,
  deregistered_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  record_json TEXT NOT NULL
);

-- Health is derived from heartbeat age, so the lookup that lists live workers is the heartbeat index.
CREATE INDEX IF NOT EXISTS habitat_ax_workforce_workers_state
  ON habitat_ax_workforce_workers(state, heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS habitat_ax_workforce_leases (
  lease_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released', 'completed', 'expired', 'abandoned', 'uncertain')),
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  reason TEXT,
  record_json TEXT NOT NULL
);

-- The structural guarantee: one task, one live owner. Released/expired rows stay for history.
CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_workforce_leases_active_task
  ON habitat_ax_workforce_leases(task_id) WHERE state = 'active';

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_leases_worker
  ON habitat_ax_workforce_leases(worker_id, state);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_leases_expiry
  ON habitat_ax_workforce_leases(state, expires_at);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_leases_mission
  ON habitat_ax_workforce_leases(mission_id, acquired_at);

CREATE TABLE IF NOT EXISTS habitat_ax_workforce_executions (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  lease_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('inflight', 'succeeded', 'failed', 'uncertain')),
  result_json TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_executions_task
  ON habitat_ax_workforce_executions(mission_id, task_id, attempt);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_executions_state
  ON habitat_ax_workforce_executions(state, updated_at);

-- Append-only. A sequence column, not a timestamp, so two events in the same millisecond stay ordered.
CREATE TABLE IF NOT EXISTS habitat_ax_workforce_recovery (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  mission_id TEXT,
  task_id TEXT,
  worker_id TEXT,
  lease_id TEXT,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_recovery_mission
  ON habitat_ax_workforce_recovery(mission_id, seq);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_recovery_kind
  ON habitat_ax_workforce_recovery(kind, at);
