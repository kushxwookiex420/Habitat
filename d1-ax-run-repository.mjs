import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Durable store for Ax orchestration runs.
 *
 * A run is not a task: it records the objective, the plan the model produced, the cost it incurred
 * and the ids of the tasks it submitted. Tasks keep living in habitat_command_tasks and are never
 * duplicated here.
 */
export function createD1AxRunRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });

  function decode(row) {
    try {
      const value = JSON.parse(row.record_json);
      return value && typeof value.id === "string" ? value : null;
    } catch { return null; }
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_ax_runs",

    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_ax_runs (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_ax_runs_updated_at ON habitat_ax_runs(updated_at DESC)");
      return { ok: true };
    },

    async save(run) {
      if (!run || typeof run.id !== "string" || !run.id) throw new Error("A run needs an id.");
      await query(
        "INSERT INTO habitat_ax_runs (id, record_json, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, status = excluded.status, updated_at = excluded.updated_at",
        [run.id, JSON.stringify(run), String(run.status || "unknown"), String(run.updatedAt || new Date().toISOString())]
      );
      return structuredClone(run);
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
