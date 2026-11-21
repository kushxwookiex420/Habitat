const API = "https://api.cloudflare.com/client/v4";

/**
 * Durable storage for universal command tasks.
 *
 * This is deliberately a separate table from habitat_tasks: the existing worker-task routes and
 * their records keep their own shape and status vocabulary, and a command objective must never
 * appear in them as an unknown status.
 */
export function createD1CommandTaskRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("D1 command storage requires CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID, and HABITAT_D1_API_TOKEN.");
  }
  const endpoint = `${API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params })
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.success !== true) {
      throw new Error(`D1 command query failed with HTTP ${response.status}; check D1 credentials, database ID, and schema.`);
    }
    return payload.result || [];
  }

  function decode(row) {
    try {
      const value = JSON.parse(row.record_json);
      return value && typeof value.id === "string" ? value : null;
    } catch { return null; }
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_command_tasks",

    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_command_tasks (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_command_tasks_status_updated_at ON habitat_command_tasks(status, updated_at DESC)");
      return { ok: true, adapter: "cloudflare-d1" };
    },

    async create(task) {
      if (!task || typeof task.id !== "string" || !task.id.trim()) throw new Error("A command task needs a non-empty id.");
      const updatedAt = String(task.updatedAt || task.createdAt || new Date().toISOString());
      await query("INSERT INTO habitat_command_tasks (id, record_json, status, updated_at) VALUES (?, ?, ?, ?)", [
        task.id, JSON.stringify(task), String(task.status || "queued"), updatedAt
      ]);
      return structuredClone(task);
    },

    async get(id) {
      const result = await query("SELECT record_json FROM habitat_command_tasks WHERE id = ? LIMIT 1", [String(id)]);
      return decode(result[0]?.results?.[0] || {});
    },

    async list({ limit = 50, status } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
      const result = status
        ? await query("SELECT record_json FROM habitat_command_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?", [String(status), safeLimit])
        : await query("SELECT record_json FROM habitat_command_tasks ORDER BY updated_at DESC LIMIT ?", [safeLimit]);
      return (result[0]?.results || []).map(decode).filter(Boolean);
    },

    async update(id, patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("A command update needs a patch object.");
      const current = await this.get(id);
      if (!current) return null;
      const next = { ...current, ...structuredClone(patch), id: current.id };
      const updatedAt = String(next.updatedAt || new Date().toISOString());
      await query("UPDATE habitat_command_tasks SET record_json = ?, status = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify(next), String(next.status || "queued"), updatedAt, current.id
      ]);
      return next;
    },

    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}
