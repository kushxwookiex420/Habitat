import { createD1RowQuery } from "./nexus-runtime.mjs";

/**
 * Durable store for workforce v1.
 *
 * The repository takes a `query(sql, params)` function, so the same SQL runs against Cloudflare D1 in a
 * deployment and against `node:sqlite` in a test. The DDL mirrors `migrations/0018_ax_workforce_v1.sql`;
 * the migration file is the canonical record, and `initialize()` is only used by tests and local tools.
 * A running web process calls `verifySchema()` and refuses to start when the tables are absent.
 *
 * Two writes are deliberately single statements, so the database decides the race:
 *
 *   createLease        INSERT; the partial unique index allows one `active` row per task
 *   beginExecution     INSERT; the primary key allows one row per attempt
 *
 * `finishExecution` and `renewLease` are conditional updates: a stale owner that wakes up after its lease
 * expired must fail, not silently extend a grant that no longer exists.
 */

export const WORKFORCE_V1_MIGRATION = "0018_ax_workforce_v1";

export const WORKFORCE_V1_TABLE_NAMES = Object.freeze([
  "habitat_ax_workforce_workers",
  "habitat_ax_workforce_leases",
  "habitat_ax_workforce_executions",
  "habitat_ax_workforce_recovery"
]);

/** 0019. Checked separately: a database with 0018 but not 0019 still runs the workforce. */
export const WORKFORCE_IDENTITY_MIGRATION = "0019_ax_workforce_identity";

export const WORKFORCE_IDENTITY_TABLE_NAMES = Object.freeze([
  "habitat_ax_workforce_credentials",
  "habitat_ax_workforce_auth_nonces",
  "habitat_ax_workforce_operations",
  "habitat_ax_workforce_reassignments"
]);

export const OPERATION_STATES = Object.freeze(["unknown", "confirmed_success", "confirmed_failure", "not_executed"]);
export const CREDENTIAL_STATES = Object.freeze(["active", "rotated", "revoked"]);

export const LEASE_STATES = Object.freeze(["active", "released", "completed", "expired", "abandoned", "uncertain"]);
export const EXECUTION_STATES = Object.freeze(["inflight", "succeeded", "failed", "uncertain"]);
export const WORKER_STATES = Object.freeze(["online", "busy", "draining", "unavailable", "deregistered"]);

export const WORKFORCE_V1_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_workers (worker_id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, specialty TEXT NOT NULL, adapter_id TEXT, capabilities_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'online' CHECK (state IN ('online', 'busy', 'draining', 'unavailable', 'deregistered')), accepting INTEGER NOT NULL DEFAULT 1, max_concurrent INTEGER NOT NULL DEFAULT 1, heartbeat_at TEXT, registered_at TEXT NOT NULL, deregistered_at TEXT, revision INTEGER NOT NULL DEFAULT 1, record_json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_workers_state ON habitat_ax_workforce_workers(state, heartbeat_at DESC)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_leases (lease_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, mission_id TEXT NOT NULL, worker_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'released', 'completed', 'expired', 'abandoned', 'uncertain')), attempt INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT, acquired_at TEXT NOT NULL, renewed_at TEXT, expires_at TEXT NOT NULL, released_at TEXT, reason TEXT, record_json TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_workforce_leases_active_task ON habitat_ax_workforce_leases(task_id) WHERE state = 'active'",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_leases_worker ON habitat_ax_workforce_leases(worker_id, state)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_leases_expiry ON habitat_ax_workforce_leases(state, expires_at)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_leases_mission ON habitat_ax_workforce_leases(mission_id, acquired_at)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_executions (idempotency_key TEXT PRIMARY KEY NOT NULL, mission_id TEXT NOT NULL, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, lease_id TEXT, attempt INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL CHECK (state IN ('inflight', 'succeeded', 'failed', 'uncertain')), result_json TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_executions_task ON habitat_ax_workforce_executions(mission_id, task_id, attempt)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_executions_state ON habitat_ax_workforce_executions(state, updated_at)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_recovery (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, mission_id TEXT, task_id TEXT, worker_id TEXT, lease_id TEXT, detail_json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_recovery_mission ON habitat_ax_workforce_recovery(mission_id, seq)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_recovery_kind ON habitat_ax_workforce_recovery(kind, at)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_credentials (credential_id TEXT PRIMARY KEY NOT NULL, worker_id TEXT NOT NULL, label TEXT NOT NULL, secret_key TEXT NOT NULL, scopes_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')), created_at TEXT NOT NULL, expires_at TEXT, grace_until TEXT, revoked_at TEXT, revoke_reason TEXT, rotated_to TEXT, last_used_at TEXT, record_json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_credentials_worker ON habitat_ax_workforce_credentials(worker_id, status)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_credentials_expiry ON habitat_ax_workforce_credentials(status, expires_at)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_auth_nonces (credential_id TEXT NOT NULL, nonce TEXT NOT NULL, operation TEXT NOT NULL, at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (credential_id, nonce))",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_auth_nonces_expiry ON habitat_ax_workforce_auth_nonces(expires_at)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_operations (idempotency_key TEXT PRIMARY KEY NOT NULL, mission_id TEXT NOT NULL, task_id TEXT NOT NULL, worker_id TEXT, provider TEXT, provider_reference TEXT, state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'confirmed_success', 'confirmed_failure', 'not_executed')), proof_json TEXT, inspected_at TEXT, inspected_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_operations_state ON habitat_ax_workforce_operations(state, updated_at)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_operations_reference ON habitat_ax_workforce_operations(provider, provider_reference)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workforce_reassignments (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, mission_id TEXT NOT NULL, task_id TEXT NOT NULL, from_worker TEXT, to_worker TEXT, lease_id TEXT, reason TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('requeue', 'hold_uncertain', 'abandon', 'completed')), detail_json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workforce_reassignments_mission ON habitat_ax_workforce_reassignments(mission_id, seq)"
]);

function parse(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowsOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * How many rows a write actually touched. Cloudflare D1 returns the RETURNING rows; the SQLite shims used
 * in tests return `[{ changes }]`. Both shapes answer the same question.
 */
export function affected(rows) {
  const list = rowsOf(rows);
  if (list.length === 0) return 0;
  const first = list[0];
  if (first && typeof first === "object" && Object.prototype.hasOwnProperty.call(first, "changes")) {
    // A row returned by RETURNING can carry a `changes` column only when the caller asked for it; the shim
    // is the case that matters here.
    return Number(first.changes || 0);
  }
  return list.length;
}

function workerFrom(row) {
  const stored = parse(row.record_json, null);
  return stored || {
    id: row.worker_id,
    label: row.label,
    specialty: row.specialty,
    adapterId: row.adapter_id || null,
    capabilities: parse(row.capabilities_json, []),
    state: row.state,
    accepting: Number(row.accepting) !== 0,
    maxConcurrent: Number(row.max_concurrent) || 1,
    heartbeatAt: row.heartbeat_at || null,
    registeredAt: row.registered_at,
    deregisteredAt: row.deregistered_at || null,
    revision: Number(row.revision) || 1
  };
}

function leaseFrom(row) {
  // Columns are authoritative. `expireLeases` is a single sweeping UPDATE and cannot rewrite the JSON of
  // every matched row cheaply, so reading the stored JSON first would report a swept lease as still active
  // — the exact mistake that lets a dead owner's lease look like a live one.
  const stored = parse(row.record_json, null) || {};
  return {
    ...stored,
    leaseId: row.lease_id,
    taskId: row.task_id,
    missionId: row.mission_id,
    workerId: row.worker_id,
    state: row.state,
    attempt: Number(row.attempt) || 1,
    idempotencyKey: row.idempotency_key || stored.idempotencyKey || null,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at || null,
    expiresAt: row.expires_at,
    releasedAt: row.released_at || null,
    reason: row.reason || null
  };
}

function operationFrom(row) {
  return {
    idempotencyKey: row.idempotency_key,
    missionId: row.mission_id,
    taskId: row.task_id,
    workerId: row.worker_id || null,
    provider: row.provider || null,
    providerReference: row.provider_reference || null,
    state: row.state,
    proof: parse(row.proof_json, null),
    inspectedAt: row.inspected_at || null,
    inspectedBy: row.inspected_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function executionFrom(row) {
  return {
    idempotencyKey: row.idempotency_key,
    missionId: row.mission_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    leaseId: row.lease_id || null,
    attempt: Number(row.attempt) || 1,
    state: row.state,
    result: parse(row.result_json, null),
    startedAt: row.started_at,
    updatedAt: row.updated_at
  };
}

export function createWorkforceV1Repository({ query, now = () => new Date().toISOString() } = {}) {
  if (typeof query !== "function") throw new Error("The workforce v1 repository needs a query function.");
  let initializing = null;

  return Object.freeze({
    adapter: "sql",
    durable: true,

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          for (const statement of WORKFORCE_V1_DDL) await query(statement);
          return { ok: true, statements: WORKFORCE_V1_DDL.length };
        })().catch((error) => { initializing = null; throw error; });
      }
      return initializing;
    },

    /** Read-only. Never creates a table: applying a migration is an operator action. */
    async verifySchema() {
      const rows = await query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" + WORKFORCE_V1_TABLE_NAMES.map(() => "?").join(", ") + ")",
        WORKFORCE_V1_TABLE_NAMES
      );
      const present = new Set(rowsOf(rows).map((row) => row.name));
      return {
        ok: WORKFORCE_V1_TABLE_NAMES.every((name) => present.has(name)),
        missing: WORKFORCE_V1_TABLE_NAMES.filter((name) => !present.has(name)),
        expected: WORKFORCE_V1_TABLE_NAMES.length,
        migration: WORKFORCE_V1_MIGRATION
      };
    },

    async verifyIdentitySchema() {
      const rows = await query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" + WORKFORCE_IDENTITY_TABLE_NAMES.map(() => "?").join(", ") + ")",
        WORKFORCE_IDENTITY_TABLE_NAMES
      );
      const present = new Set(rowsOf(rows).map((row) => row.name));
      return {
        ok: WORKFORCE_IDENTITY_TABLE_NAMES.every((name) => present.has(name)),
        missing: WORKFORCE_IDENTITY_TABLE_NAMES.filter((name) => !present.has(name)),
        expected: WORKFORCE_IDENTITY_TABLE_NAMES.length,
        migration: WORKFORCE_IDENTITY_MIGRATION
      };
    },

    /* ── worker identity ─────────────────────────────────────────────────────────────────────────── */

    async saveWorker(worker) {
      await query(
        "INSERT INTO habitat_ax_workforce_workers (worker_id, label, specialty, adapter_id, capabilities_json, state, accepting, max_concurrent, heartbeat_at, registered_at, deregistered_at, revision, record_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id) DO UPDATE SET label = excluded.label, specialty = excluded.specialty, adapter_id = excluded.adapter_id, capabilities_json = excluded.capabilities_json, state = excluded.state, accepting = excluded.accepting, max_concurrent = excluded.max_concurrent, heartbeat_at = excluded.heartbeat_at, deregistered_at = excluded.deregistered_at, revision = excluded.revision, record_json = excluded.record_json",
        [
          worker.id,
          worker.label,
          worker.specialty,
          worker.adapterId || null,
          JSON.stringify(worker.capabilities || []),
          worker.state,
          worker.accepting === false ? 0 : 1,
          Number(worker.maxConcurrent) || 1,
          worker.heartbeatAt || null,
          worker.registeredAt || now(),
          worker.deregisteredAt || null,
          Number(worker.revision) || 1,
          JSON.stringify(worker)
        ]
      );
      return { ok: true };
    },

    async getWorker(id) {
      const rows = await query("SELECT * FROM habitat_ax_workforce_workers WHERE worker_id = ?", [String(id)]);
      const row = rowsOf(rows)[0];
      return row ? workerFrom(row) : null;
    },

    async listWorkers({ limit = 200 } = {}) {
      const rows = await query("SELECT * FROM habitat_ax_workforce_workers ORDER BY worker_id LIMIT ?", [Math.max(1, Math.min(500, Number(limit) || 200))]);
      return rowsOf(rows).map(workerFrom);
    },

    /* ── leases ─────────────────────────────────────────────────────────────────────────────────── */

    /**
     * Insert a lease. A unique violation means the task already has a live owner; the caller re-reads the
     * row to report who holds it. Any other failure propagates, because "storage unavailable" is not
     * "somebody else owns it" and must not be reported as one.
     */
    async createLease(lease) {
      try {
        await query(
          "INSERT INTO habitat_ax_workforce_leases (lease_id, task_id, mission_id, worker_id, state, attempt, idempotency_key, acquired_at, renewed_at, expires_at, released_at, reason, record_json) " +
          "VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, NULL, NULL, ?)",
          [
            lease.leaseId,
            lease.taskId,
            lease.missionId,
            lease.workerId,
            Number(lease.attempt) || 1,
            lease.idempotencyKey || null,
            lease.acquiredAt,
            lease.expiresAt,
            JSON.stringify(lease)
          ]
        );
        return { ok: true, lease };
      } catch (error) {
        const holder = await this.activeLeaseForTask(lease.taskId).catch(() => null);
        if (holder) return { ok: false, code: "lease_held", holder };
        const existing = await this.getLease(lease.leaseId).catch(() => null);
        if (existing) return { ok: false, code: "lease_id_reused", holder: existing };
        throw error;
      }
    },

    async getLease(leaseId) {
      const rows = await query("SELECT * FROM habitat_ax_workforce_leases WHERE lease_id = ?", [String(leaseId)]);
      const row = rowsOf(rows)[0];
      return row ? leaseFrom(row) : null;
    },

    async activeLeaseForTask(taskId) {
      const rows = await query("SELECT * FROM habitat_ax_workforce_leases WHERE task_id = ? AND state = 'active' LIMIT 1", [String(taskId)]);
      const row = rowsOf(rows)[0];
      return row ? leaseFrom(row) : null;
    },

    async listLeases({ state = null, missionId = null, workerId = null, taskId = null, limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (state) { where.push("state = ?"); params.push(String(state)); }
      if (missionId) { where.push("mission_id = ?"); params.push(String(missionId)); }
      if (workerId) { where.push("worker_id = ?"); params.push(String(workerId)); }
      if (taskId) { where.push("task_id = ?"); params.push(String(taskId)); }
      params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
      const rows = await query(
        "SELECT * FROM habitat_ax_workforce_leases " + (where.length ? "WHERE " + where.join(" AND ") + " " : "") + "ORDER BY acquired_at DESC LIMIT ?",
        params
      );
      return rowsOf(rows).map(leaseFrom);
    },

    /**
     * Conditional: a lease that already expired, or that belongs to another worker, cannot be extended.
     * `expires_at > now` is part of the predicate, so a partitioned worker that wakes up late cannot
     * revive a grant another worker may already hold.
     */
    async renewLease({ leaseId, workerId, expiresAt, renewedAt }) {
      const current = await this.getLease(leaseId);
      if (!current) return { ok: false, code: "unknown_lease" };
      if (current.workerId !== String(workerId)) return { ok: false, code: "lease_not_owned" };
      if (current.state !== "active") return { ok: false, code: "lease_not_active" };
      const next = { ...current, expiresAt, renewedAt };
      const rows = await query(
        "UPDATE habitat_ax_workforce_leases SET expires_at = ?, renewed_at = ?, record_json = ? " +
        "WHERE lease_id = ? AND worker_id = ? AND state = 'active' AND expires_at > ? RETURNING lease_id",
        [expiresAt, renewedAt, JSON.stringify(next), String(leaseId), String(workerId), renewedAt]
      );
      if (affected(rows) === 0) return { ok: false, code: "lease_expired" };
      return { ok: true, lease: next, expiresAt };
    },

    /** Conditional release. Only the owner of a live lease may close it. */
    async releaseLease({ leaseId, workerId, state, releasedAt, reason = null }) {
      const current = await this.getLease(leaseId);
      if (!current) return { ok: false, code: "unknown_lease" };
      if (current.workerId !== String(workerId)) return { ok: false, code: "lease_not_owned" };
      if (current.state !== "active") return { ok: false, code: "lease_not_active", lease: current };
      const next = { ...current, state, releasedAt, reason };
      const rows = await query(
        "UPDATE habitat_ax_workforce_leases SET state = ?, released_at = ?, reason = ?, record_json = ? WHERE lease_id = ? AND worker_id = ? AND state = 'active' RETURNING lease_id",
        [state, releasedAt, reason, JSON.stringify(next), String(leaseId), String(workerId)]
      );
      if (affected(rows) === 0) return { ok: false, code: "lease_not_active" };
      return { ok: true, lease: next };
    },

    /** Mark every live lease past its expiry. One statement, so two sweeps cannot both "claim" a lease. */
    async expireLeases({ at, limit = 100 } = {}) {
      const rows = await query(
        "UPDATE habitat_ax_workforce_leases SET state = 'expired', released_at = ?, reason = 'lease_expired' " +
        "WHERE state = 'active' AND expires_at <= ? RETURNING lease_id, task_id, mission_id, worker_id, attempt, expires_at",
        [String(at), String(at)]
      );
      const records = rowsOf(rows);
      if (records.length > 0 && records[0].lease_id) {
        return { ok: true, expired: records.map((row) => ({ leaseId: row.lease_id, taskId: row.task_id, missionId: row.mission_id, workerId: row.worker_id, attempt: Number(row.attempt) || 1, expiresAt: row.expires_at })) };
      }
      // A driver that does not return the RETURNING rows still reports the change count.
      return { ok: true, expired: [], expiredCount: affected(rows) };
    },

    /* ── execution ledger ──────────────────────────────────────────────────────────────────────── */

    /**
     * Claim one attempt. The primary key is the at-most-once boundary: a duplicate request reaches the same
     * row and is reported back instead of reaching an external operation twice.
     */
    async beginExecution(entry) {
      try {
        await query(
          "INSERT INTO habitat_ax_workforce_executions (idempotency_key, mission_id, task_id, worker_id, lease_id, attempt, state, result_json, started_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'inflight', NULL, ?, ?)",
          [
            entry.idempotencyKey,
            entry.missionId,
            entry.taskId,
            entry.workerId,
            entry.leaseId || null,
            Number(entry.attempt) || 1,
            entry.at,
            entry.at
          ]
        );
        return { ok: true, execution: { ...entry, state: "inflight", result: null, startedAt: entry.at, updatedAt: entry.at } };
      } catch (error) {
        const existing = await this.getExecution(entry.idempotencyKey).catch(() => null);
        if (existing) return { ok: false, code: "already_exists", execution: existing };
        throw error;
      }
    },

    async getExecution(idempotencyKey) {
      const rows = await query("SELECT * FROM habitat_ax_workforce_executions WHERE idempotency_key = ?", [String(idempotencyKey)]);
      const row = rowsOf(rows)[0];
      return row ? executionFrom(row) : null;
    },

    async listExecutions({ missionId = null, taskId = null, state = null, leaseId = null, limit = 50 } = {}) {
      const where = [];
      const params = [];
      if (missionId) { where.push("mission_id = ?"); params.push(String(missionId)); }
      if (taskId) { where.push("task_id = ?"); params.push(String(taskId)); }
      if (state) { where.push("state = ?"); params.push(String(state)); }
      if (leaseId) { where.push("lease_id = ?"); params.push(String(leaseId)); }
      params.push(Math.max(1, Math.min(500, Number(limit) || 50)));
      const rows = await query(
        "SELECT * FROM habitat_ax_workforce_executions " + (where.length ? "WHERE " + where.join(" AND ") + " " : "") + "ORDER BY started_at ASC LIMIT ?",
        params
      );
      return rowsOf(rows).map(executionFrom);
    },

    /** Only an in-flight attempt can be finished. A settled row is history and is never rewritten. */
    async finishExecution({ idempotencyKey, state, result = null, at }) {
      const rows = await query(
        "UPDATE habitat_ax_workforce_executions SET state = ?, result_json = ?, updated_at = ? WHERE idempotency_key = ? AND state = 'inflight' RETURNING idempotency_key",
        [state, result === null ? null : JSON.stringify(result), String(at), String(idempotencyKey)]
      );
      if (affected(rows) === 0) {
        const current = await this.getExecution(idempotencyKey);
        return { ok: false, code: current ? "execution_already_settled" : "execution_missing", execution: current };
      }
      return { ok: true, execution: await this.getExecution(idempotencyKey) };
    },

    /**
     * Reconciliation only. An `uncertain` attempt is settled by an owner decision backed by provider
     * evidence, never by a retry. Only `uncertain -> succeeded|failed` is allowed here; `inflight` goes
     * through `finishExecution` instead.
     */
    async settleUncertainExecution({ idempotencyKey, state, result = null, at }) {
      if (!["succeeded", "failed"].includes(state)) return { ok: false, code: "execution_state_invalid" };
      const rows = await query(
        "UPDATE habitat_ax_workforce_executions SET state = ?, result_json = ?, updated_at = ? WHERE idempotency_key = ? AND state = 'uncertain' RETURNING idempotency_key",
        [state, result === null ? null : JSON.stringify(result), String(at), String(idempotencyKey)]
      );
      if (affected(rows) === 0) {
        const current = await this.getExecution(idempotencyKey);
        return { ok: false, code: current ? "execution_not_uncertain" : "execution_missing", execution: current };
      }
      return { ok: true, execution: await this.getExecution(idempotencyKey) };
    },

    /* ── worker credentials ───────────────────────────────────────────────────────────────────── */

    async saveCredential(credential) {
      await query(
        "INSERT INTO habitat_ax_workforce_credentials (credential_id, worker_id, label, secret_key, scopes_json, status, created_at, expires_at, grace_until, revoked_at, revoke_reason, rotated_to, last_used_at, record_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(credential_id) DO UPDATE SET label = excluded.label, status = excluded.status, expires_at = excluded.expires_at, grace_until = excluded.grace_until, revoked_at = excluded.revoked_at, revoke_reason = excluded.revoke_reason, rotated_to = excluded.rotated_to, last_used_at = excluded.last_used_at, record_json = excluded.record_json",
        [
          credential.credentialId,
          credential.workerId,
          credential.label,
          credential.secretKey,
          JSON.stringify(credential.scopes || []),
          credential.status,
          credential.createdAt,
          credential.expiresAt || null,
          credential.graceUntil || null,
          credential.revokedAt || null,
          credential.revokeReason || null,
          credential.rotatedTo || null,
          credential.lastUsedAt || null,
          JSON.stringify(credential.record || credential)
        ]
      );
      return { ok: true };
    },

    async getCredential(credentialId) {
      const rows = await query("SELECT * FROM habitat_ax_workforce_credentials WHERE credential_id = ?", [String(credentialId)]);
      const row = rowsOf(rows)[0];
      if (!row) return null;
      return {
        credentialId: row.credential_id,
        workerId: row.worker_id,
        label: row.label,
        secretKey: row.secret_key,
        scopes: parse(row.scopes_json, []),
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at || null,
        graceUntil: row.grace_until || null,
        revokedAt: row.revoked_at || null,
        revokeReason: row.revoke_reason || null,
        rotatedTo: row.rotated_to || null,
        lastUsedAt: row.last_used_at || null
      };
    },

    async listCredentials({ workerId = null, status = null, limit = 100 } = {}) {
      const where = [];
      const params = [];
      if (workerId) { where.push("worker_id = ?"); params.push(String(workerId)); }
      if (status) { where.push("status = ?"); params.push(String(status)); }
      params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      const rows = await query(
        "SELECT credential_id, worker_id, label, scopes_json, status, created_at, expires_at, grace_until, revoked_at, revoke_reason, rotated_to, last_used_at FROM habitat_ax_workforce_credentials " +
        (where.length ? "WHERE " + where.join(" AND ") + " " : "") + "ORDER BY created_at DESC LIMIT ?",
        params
      );
      return rowsOf(rows).map((row) => ({
        credentialId: row.credential_id,
        workerId: row.worker_id,
        label: row.label,
        scopes: parse(row.scopes_json, []),
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at || null,
        graceUntil: row.grace_until || null,
        revokedAt: row.revoked_at || null,
        revokeReason: row.revoke_reason || null,
        rotatedTo: row.rotated_to || null,
        lastUsedAt: row.last_used_at || null
      }));
    },

    /** Single-use nonce. The composite primary key decides a replay race. */
    async useWorkerNonce({ credentialId, nonce, operation, at, expiresAt }) {
      try {
        await query(
          "INSERT INTO habitat_ax_workforce_auth_nonces (credential_id, nonce, operation, at, expires_at) VALUES (?, ?, ?, ?, ?)",
          [String(credentialId), String(nonce), String(operation), String(at), String(expiresAt)]
        );
        return { ok: true };
      } catch (error) {
        const rows = await query(
          "SELECT nonce FROM habitat_ax_workforce_auth_nonces WHERE credential_id = ? AND nonce = ? LIMIT 1",
          [String(credentialId), String(nonce)]
        ).catch(() => null);
        if (rows === null) throw error;
        if (rowsOf(rows).length > 0) return { ok: false, code: "worker_request_replayed" };
        throw error;
      }
    },

    /* ── provider operations and reconciliation ───────────────────────────────────────────── */

    async saveOperation(operation) {
      const at = operation.at;
      await query(
        "INSERT INTO habitat_ax_workforce_operations (idempotency_key, mission_id, task_id, worker_id, provider, provider_reference, state, proof_json, inspected_at, inspected_by, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET " +
        "provider = COALESCE(excluded.provider, provider), provider_reference = COALESCE(excluded.provider_reference, provider_reference), " +
        "worker_id = COALESCE(excluded.worker_id, worker_id), updated_at = excluded.updated_at, " +
        // A settled verdict is never downgraded back to `unknown` by a later observation. A settled verdict
        // may still be *refined* by an owner (confirmed_failure -> not_executed with proof), because the
        // alternative is an operator who cannot correct a wrong decision.
        "state = CASE WHEN excluded.state = 'unknown' AND habitat_ax_workforce_operations.state <> 'unknown' THEN habitat_ax_workforce_operations.state ELSE excluded.state END, " +
        "proof_json = CASE WHEN excluded.state = 'unknown' AND habitat_ax_workforce_operations.state <> 'unknown' THEN habitat_ax_workforce_operations.proof_json ELSE COALESCE(excluded.proof_json, habitat_ax_workforce_operations.proof_json) END, " +
        "inspected_at = COALESCE(excluded.inspected_at, inspected_at), inspected_by = COALESCE(excluded.inspected_by, inspected_by)",
        [
          operation.idempotencyKey,
          operation.missionId,
          operation.taskId,
          operation.workerId || null,
          operation.provider || null,
          operation.providerReference || null,
          OPERATION_STATES.includes(operation.state) ? operation.state : "unknown",
          operation.proof === undefined || operation.proof === null ? null : JSON.stringify(operation.proof),
          operation.inspectedAt || null,
          operation.inspectedBy || null,
          operation.createdAt || at,
          at
        ]
      );
      return { ok: true, operation: await this.getOperation(operation.idempotencyKey) };
    },

    async getOperation(idempotencyKey) {
      const rows = await query("SELECT * FROM habitat_ax_workforce_operations WHERE idempotency_key = ?", [String(idempotencyKey)]);
      const row = rowsOf(rows)[0];
      return row ? operationFrom(row) : null;
    },

    async listOperations({ state = null, missionId = null, limit = 100 } = {}) {
      const where = [];
      const params = [];
      if (state) { where.push("state = ?"); params.push(String(state)); }
      if (missionId) { where.push("mission_id = ?"); params.push(String(missionId)); }
      params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      const rows = await query(
        "SELECT * FROM habitat_ax_workforce_operations " + (where.length ? "WHERE " + where.join(" AND ") + " " : "") + "ORDER BY updated_at DESC LIMIT ?",
        params
      );
      return rowsOf(rows).map(operationFrom);
    },

    /* ── reassignment ledger ─────────────────────────────────────────────────────────────────── */

    async recordReassignment(entry) {
      await query(
        "INSERT INTO habitat_ax_workforce_reassignments (at, mission_id, task_id, from_worker, to_worker, lease_id, reason, decision, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          entry.at || now(),
          String(entry.missionId),
          String(entry.taskId),
          entry.fromWorker || null,
          entry.toWorker || null,
          entry.leaseId || null,
          String(entry.reason || "unknown"),
          String(entry.decision || "requeue"),
          JSON.stringify(entry.detail || {})
        ]
      );
      return { ok: true };
    },

    async listReassignments({ missionId = null, limit = 100 } = {}) {
      const params = [];
      let where = "";
      if (missionId) { where = "WHERE mission_id = ? "; params.push(String(missionId)); }
      params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      const rows = await query(
        "SELECT seq, at, mission_id, task_id, from_worker, to_worker, lease_id, reason, decision, detail_json FROM habitat_ax_workforce_reassignments " + where + "ORDER BY seq DESC LIMIT ?",
        params
      );
      return rowsOf(rows).map((row) => ({
        seq: Number(row.seq),
        at: row.at,
        missionId: row.mission_id,
        taskId: row.task_id,
        fromWorker: row.from_worker || null,
        toWorker: row.to_worker || null,
        leaseId: row.lease_id || null,
        reason: row.reason,
        decision: row.decision,
        detail: parse(row.detail_json, {})
      }));
    },

    /* ── recovery journal ─────────────────────────────────────────────────────────────────────── */

    async appendRecovery(entries = []) {
      for (const entry of entries) {
        await query(
          "INSERT INTO habitat_ax_workforce_recovery (at, kind, mission_id, task_id, worker_id, lease_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            entry.at || now(),
            String(entry.kind || "unknown"),
            entry.missionId || null,
            entry.taskId || null,
            entry.workerId || null,
            entry.leaseId || null,
            JSON.stringify(entry.detail || {})
          ]
        );
      }
      return { ok: true, appended: entries.length };
    },

    async listRecovery({ missionId = null, kind = null, limit = 100 } = {}) {
      const where = [];
      const params = [];
      if (missionId) { where.push("mission_id = ?"); params.push(String(missionId)); }
      if (kind) { where.push("kind = ?"); params.push(String(kind)); }
      params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      const rows = await query(
        "SELECT seq, at, kind, mission_id, task_id, worker_id, lease_id, detail_json FROM habitat_ax_workforce_recovery " +
        (where.length ? "WHERE " + where.join(" AND ") + " " : "") + "ORDER BY seq DESC LIMIT ?",
        params
      );
      return rowsOf(rows).map((row) => ({
        seq: Number(row.seq),
        at: row.at,
        kind: row.kind,
        missionId: row.mission_id || null,
        taskId: row.task_id || null,
        workerId: row.worker_id || null,
        leaseId: row.lease_id || null,
        detail: parse(row.detail_json, {})
      }));
    },

    /* ── aggregates for monitoring ───────────────────────────────────────────────────────────── */

    async workerCounts() {
      const states = await query("SELECT state, COUNT(*) AS total FROM habitat_ax_workforce_workers GROUP BY state");
      const byState = {};
      for (const row of rowsOf(states)) byState[row.state] = Number(row.total);
      const leasing = await query(
        "SELECT worker_id, COUNT(*) AS total, MAX(COALESCE(renewed_at, acquired_at)) AS last_activity FROM habitat_ax_workforce_leases WHERE state = 'active' GROUP BY worker_id"
      );
      const activeByWorker = {};
      const lastActivityByWorker = {};
      for (const row of rowsOf(leasing)) {
        activeByWorker[row.worker_id] = Number(row.total);
        lastActivityByWorker[row.worker_id] = row.last_activity || null;
      }
      return { byState, activeByWorker, lastActivityByWorker, total: Object.values(byState).reduce((sum, value) => sum + value, 0) };
    },

    async leaseCounts() {
      const rows = await query("SELECT state, COUNT(*) AS total FROM habitat_ax_workforce_leases GROUP BY state");
      const byState = {};
      for (const row of rowsOf(rows)) byState[row.state] = Number(row.total);
      const totals = await query("SELECT COUNT(*) AS total, COALESCE(SUM(attempt - 1), 0) AS retries FROM habitat_ax_workforce_leases");
      const row = rowsOf(totals)[0] || {};
      return { byState, total: Number(row.total || 0), retries: Number(row.retries || 0) };
    },

    async executionCounts() {
      const rows = await query("SELECT state, COUNT(*) AS total FROM habitat_ax_workforce_executions GROUP BY state");
      const byState = {};
      for (const row of rowsOf(rows)) byState[row.state] = Number(row.total);
      const distinct = await query("SELECT COUNT(DISTINCT mission_id || '/' || task_id) AS tasks FROM habitat_ax_workforce_executions WHERE state IN ('failed', 'uncertain')");
      return { byState, failedTasks: Number(rowsOf(distinct)[0]?.tasks || 0), total: Object.values(byState).reduce((sum, value) => sum + value, 0) };
    },

    async recoveryCounts() {
      const rows = await query("SELECT kind, COUNT(*) AS total FROM habitat_ax_workforce_recovery GROUP BY kind");
      const byKind = {};
      for (const row of rowsOf(rows)) byKind[row.kind] = Number(row.total);
      return { byKind, total: Object.values(byKind).reduce((sum, value) => sum + value, 0) };
    },

    /** Mission spans come from the lease table: the first acquisition and the last release of real work. */
    async missionSpans({ limit = 50 } = {}) {
      const rows = await query(
        "SELECT mission_id, MIN(acquired_at) AS started_at, MAX(COALESCE(released_at, expires_at)) AS ended_at, COUNT(*) AS leases " +
        "FROM habitat_ax_workforce_leases GROUP BY mission_id ORDER BY started_at DESC LIMIT ?",
        [Math.max(1, Math.min(200, Number(limit) || 50))]
      );
      return rowsOf(rows).map((row) => ({
        missionId: row.mission_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        leases: Number(row.leases || 0)
      }));
    },

    async expiringLeases({ at, before, limit = 50 } = {}) {
      const rows = await query(
        "SELECT * FROM habitat_ax_workforce_leases WHERE state = 'active' AND expires_at > ? AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?",
        [String(at), String(before), Math.max(1, Math.min(200, Number(limit) || 50))]
      );
      return rowsOf(rows).map(leaseFrom);
    }
  });
}

export function createD1WorkforceV1Repository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1RowQuery({ accountId, databaseId, apiToken, fetchImpl });
  const repository = createWorkforceV1Repository({ query });
  return Object.freeze({ ...repository, adapter: "cloudflare-d1" });
}
