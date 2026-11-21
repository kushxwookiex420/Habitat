import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Durable store for Ax orchestration runs.
 *
 * A run is not a task: it records the objective, the plan the model produced, the cost it incurred
 * and the ids of the tasks it submitted. Tasks keep living in habitat_command_tasks and are never
 * duplicated here.
 *
 * Every write is a compare-and-swap on the exact stored bytes. Two drivers (a retried request and a
 * cron worker, or two cron invocations) cannot silently overwrite each other: the loser is told it
 * lost and must re-read. That is what keeps a late reconciliation from resurrecting an older state.
 */
export function createD1AxRunRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  // One initializer per repository, shared by every concurrent request. A second caller awaits the
  // first attempt instead of firing duplicate DDL; a failed attempt is retried by the next caller.
  let initializing = null;

  function decode(row) {
    if (!row || typeof row.record_json !== "string") return null;
    try {
      const value = JSON.parse(row.record_json);
      return value && typeof value.id === "string" ? value : null;
    } catch { return null; }
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_ax_runs",

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          // Additive and idempotent only. Never drop, rename or rewrite an existing table.
          await query("CREATE TABLE IF NOT EXISTS habitat_ax_runs (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_runs_updated_at ON habitat_ax_runs(updated_at DESC)");
          return { ok: true };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },

    /**
     * Insert a new run. If another process already created this id, nothing is written and the
     * existing record is returned with created:false, so both callers continue from one state.
     */
    async create(run) {
      if (!run || typeof run.id !== "string" || !run.id) throw new Error("A run needs an id.");
      const recordJson = JSON.stringify(run);
      await query(
        "INSERT INTO habitat_ax_runs (id, record_json, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        [run.id, recordJson, String(run.status || "unknown"), String(run.updatedAt || new Date().toISOString())]
      );
      const read = await query("SELECT record_json FROM habitat_ax_runs WHERE id = ? LIMIT 1", [run.id]);
      const storedJson = read[0]?.results?.[0]?.record_json || recordJson;
      return { created: storedJson === recordJson, run: decode({ record_json: storedJson }), recordJson: storedJson };
    },

    /** Compare-and-swap: writes only if the stored bytes are still the ones the caller read. */
    async update(run, expectedRecordJson) {
      if (!run || typeof run.id !== "string" || !run.id) throw new Error("A run needs an id.");
      if (typeof expectedRecordJson !== "string" || !expectedRecordJson) throw new Error("A run update needs the exact record it is replacing.");
      const recordJson = JSON.stringify(run);
      const result = await query(
        "UPDATE habitat_ax_runs SET record_json = ?, status = ?, updated_at = ? WHERE id = ? AND record_json = ? RETURNING id",
        [recordJson, String(run.status || "unknown"), String(run.updatedAt || new Date().toISOString()), run.id, expectedRecordJson]
      );
      const rows = result[0]?.results || [];
      if (rows.length === 1) return { ok: true, run: decode({ record_json: recordJson }), recordJson };
      const read = await query("SELECT record_json FROM habitat_ax_runs WHERE id = ? LIMIT 1", [run.id]);
      const storedJson = read[0]?.results?.[0]?.record_json || null;
      return { ok: false, reason: storedJson ? "conflict" : "missing", run: decode({ record_json: storedJson }), recordJson: storedJson };
    },

    async getRecord(id) {
      const result = await query("SELECT record_json FROM habitat_ax_runs WHERE id = ? LIMIT 1", [String(id)]);
      const recordJson = result[0]?.results?.[0]?.record_json || null;
      return { run: decode({ record_json: recordJson }), recordJson };
    },

    async get(id) {
      const result = await query("SELECT record_json FROM habitat_ax_runs WHERE id = ? LIMIT 1", [String(id)]);
      return decode(result[0]?.results?.[0] || {});
    },

    async list({ limit = 20 } = {}) {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
      const result = await query("SELECT record_json FROM habitat_ax_runs ORDER BY updated_at DESC LIMIT ?", [safeLimit]);
      return (result[0]?.results || []).map(decode).filter(Boolean);
    }
  });
}
