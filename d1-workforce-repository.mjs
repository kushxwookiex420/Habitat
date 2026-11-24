import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Durable store for the workforce.
 *
 * The repository takes a `query(sql, params)` function, so the same code runs against Cloudflare D1 in
 * a deployment and against `node:sqlite` in a test. The DDL is the same statements as
 * `migrations/0010_ax_workforce.sql`; the migration file is the canonical record and `initialize()`
 * re-applies it idempotently, which is what makes a fresh database and a migrated one converge.
 *
 * Writes are upserts keyed by id, so replaying a mutation after a crash cannot duplicate a row. The one
 * structural guarantee is enforced by the database: a partial unique index allows at most one `active`
 * assignment per task.
 */

export const WORKFORCE_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS habitat_ax_worker_adapters (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL, replaceable INTEGER NOT NULL, registered_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_workers (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, specialty TEXT NOT NULL, adapter_id TEXT NOT NULL, revision INTEGER NOT NULL, health_status TEXT NOT NULL, record_json TEXT NOT NULL, added_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_workers_specialty ON habitat_ax_workers(specialty, health_status)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_worker_assignments (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, state TEXT NOT NULL, workspace_key TEXT, attempts INTEGER NOT NULL, record_json TEXT NOT NULL, assigned_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_worker_assignments_active_task ON habitat_ax_worker_assignments(task_id) WHERE state = 'active'",
  "CREATE INDEX IF NOT EXISTS habitat_ax_worker_assignments_agent ON habitat_ax_worker_assignments(agent_id, state)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_worker_results (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, verifier_agent_id TEXT, status TEXT NOT NULL, approval_state TEXT NOT NULL, record_json TEXT NOT NULL, at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_worker_results_task ON habitat_ax_worker_results(task_id, at DESC)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_worker_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_worker_audit_action ON habitat_ax_worker_audit(action, seq)"
]);

function parse(value, fallback) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export const APPROVAL_STATES = Object.freeze(["required", "approved", "rejected", "not_required"]);

export function createWorkforceRepository({ query, now = () => new Date().toISOString() } = {}) {
  if (typeof query !== "function") throw new Error("The workforce repository needs a query function.");

  let initializing = null;

  return Object.freeze({
    adapter: "sql",
    durable: true,

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          for (const statement of WORKFORCE_DDL) await query(statement);
          return { ok: true, statements: WORKFORCE_DDL.length };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },

    async saveAdapter(adapter) {
      await query(
        "INSERT INTO habitat_ax_worker_adapters (id, kind, description, replaceable, registered_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, description = excluded.description, replaceable = excluded.replaceable",
        [adapter.id, adapter.kind, adapter.description || "", adapter.replaceable === false ? 0 : 1, adapter.registeredAt || now()]
      );
      return { ok: true };
    },

    async listAdapters() {
      const rows = await query("SELECT id, kind, description, replaceable, registered_at FROM habitat_ax_worker_adapters ORDER BY id");
      return (rows || []).map(row => ({
        id: row.id,
        kind: row.kind,
        description: row.description,
        replaceable: Number(row.replaceable) !== 0,
        registeredAt: row.registered_at
      }));
    },

    async saveAgent(agent) {
      const at = now();
      await query(
        "INSERT INTO habitat_ax_workers (id, name, specialty, adapter_id, revision, health_status, record_json, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, specialty = excluded.specialty, adapter_id = excluded.adapter_id, revision = excluded.revision, health_status = excluded.health_status, record_json = excluded.record_json, updated_at = excluded.updated_at",
        [agent.id, agent.name, agent.specialty, agent.adapterId, Number(agent.revision) || 1, agent.health?.status || "unknown", JSON.stringify(agent), agent.addedAt || at, at]
      );
      return { ok: true };
    },

    async listAgents() {
      const rows = await query("SELECT record_json FROM habitat_ax_workers ORDER BY id");
      return (rows || []).map(row => parse(row.record_json, null)).filter(Boolean);
    },

    async deleteAgent(id) {
      await query("DELETE FROM habitat_ax_workers WHERE id = ?", [id]);
      return { ok: true };
    },

    async saveAssignment(assignment) {
      const at = now();
      await query(
        "INSERT INTO habitat_ax_worker_assignments (id, task_id, agent_id, state, workspace_key, attempts, record_json, assigned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET state = excluded.state, attempts = excluded.attempts, record_json = excluded.record_json, workspace_key = excluded.workspace_key, updated_at = excluded.updated_at",
        [assignment.id, assignment.taskId, assignment.agentId, assignment.state, assignment.workspaceKey || null, Number(assignment.attempts) || 1, JSON.stringify(assignment), assignment.assignedAt || at, at]
      );
      return { ok: true };
    },

    async listAssignments({ state = null, limit = 500 } = {}) {
      const rows = state
        ? await query("SELECT record_json FROM habitat_ax_worker_assignments WHERE state = ? ORDER BY assigned_at ASC LIMIT ?", [state, Number(limit) || 500])
        : await query("SELECT record_json FROM habitat_ax_worker_assignments ORDER BY assigned_at ASC LIMIT ?", [Number(limit) || 500]);
      return (rows || []).map(row => parse(row.record_json, null)).filter(Boolean);
    },

    async saveResult(result) {
      const approvalState = APPROVAL_STATES.includes(result.approvalState)
        ? result.approvalState
        : result.approvalRequired === true ? "required" : "not_required";
      await query(
        "INSERT INTO habitat_ax_worker_results (id, task_id, agent_id, verifier_agent_id, status, approval_state, record_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET status = excluded.status, approval_state = excluded.approval_state, record_json = excluded.record_json",
        [result.id, result.taskId, result.agentId, result.verifierAgentId || null, result.status, approvalState, JSON.stringify({ ...result, approvalState }), result.at || now()]
      );
      return { ok: true, approvalState };
    },

    async listResults({ status = null, limit = 500 } = {}) {
      const rows = status
        ? await query("SELECT record_json FROM habitat_ax_worker_results WHERE status = ? ORDER BY at ASC LIMIT ?", [status, Number(limit) || 500])
        : await query("SELECT record_json FROM habitat_ax_worker_results ORDER BY at ASC LIMIT ?", [Number(limit) || 500]);
      return (rows || []).map(row => parse(row.record_json, null)).filter(Boolean);
    },

    /** Record an owner decision. Approval is a separate act from verification, by design. */
    async setApproval({ resultId, state, by = "owner" } = {}) {
      if (!APPROVAL_STATES.includes(state)) return { ok: false, code: "approval_state_invalid" };
      const rows = await query("SELECT record_json FROM habitat_ax_worker_results WHERE id = ?", [resultId]);
      const existing = parse(rows?.[0]?.record_json, null);
      if (!existing) return { ok: false, code: "unknown_result" };
      const next = { ...existing, approvalState: state, approvedBy: by, approvedAt: now() };
      await query(
        "UPDATE habitat_ax_worker_results SET approval_state = ?, record_json = ? WHERE id = ?",
        [state, JSON.stringify(next), resultId]
      );
      return { ok: true, result: next };
    },

    async appendAudit(entries = []) {
      for (const entry of entries) {
        await query(
          "INSERT INTO habitat_ax_worker_audit (at, action, payload_json) VALUES (?, ?, ?)",
          [entry.at || now(), String(entry.action || "unknown"), JSON.stringify(entry)]
        );
      }
      return { ok: true, appended: entries.length };
    },

    async listAudit({ limit = 1000 } = {}) {
      const rows = await query("SELECT seq, at, action, payload_json FROM habitat_ax_worker_audit ORDER BY seq ASC LIMIT ?", [Number(limit) || 1000]);
      return (rows || []).map(row => ({ seq: Number(row.seq), ...parse(row.payload_json, { at: row.at, action: row.action }) }));
    },

    async counts() {
      const rows = await query(
        "SELECT (SELECT COUNT(*) FROM habitat_ax_workers) AS agents, " +
        "(SELECT COUNT(*) FROM habitat_ax_worker_assignments) AS assignments, " +
        "(SELECT COUNT(*) FROM habitat_ax_worker_results) AS results, " +
        "(SELECT COUNT(*) FROM habitat_ax_worker_audit) AS audit"
      );
      const row = rows?.[0] || {};
      return { agents: Number(row.agents || 0), assignments: Number(row.assignments || 0), results: Number(row.results || 0), audit: Number(row.audit || 0) };
    }
  });
}

/** Cloudflare D1 binding for the same repository. */
export function createD1WorkforceRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  const repository = createWorkforceRepository({ query });
  return Object.freeze({ ...repository, adapter: "cloudflare-d1" });
}
