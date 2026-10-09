const API = "https://api.cloudflare.com/client/v4";

export function createD1TaskRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("D1 task storage requires CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID, and HABITAT_D1_API_TOKEN.");
  }
  const endpoint = `${API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params })
    });
    const payload = await response.json();
    if (!response.ok || payload?.success !== true) {
      throw new Error(`D1 query failed with HTTP ${response.status}; check D1 credentials, database ID, and schema.`);
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
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_tasks (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_tasks_status_updated_at ON habitat_tasks(status, updated_at DESC)");
      return { ok: true, adapter: "cloudflare-d1" };
    },
    async create(task) {
      if (!task || typeof task.id !== "string" || !task.id.trim()) throw new Error("Task creation requires a non-empty string id.");
      const updatedAt = String(task.updatedAt || task.createdAt || new Date().toISOString());
      await query("INSERT INTO habitat_tasks (id, record_json, status, updated_at) VALUES (?, ?, ?, ?)", [
        task.id, JSON.stringify(task), String(task.status || "queued"), updatedAt
      ]);
      return structuredClone(task);
    },
    async get(id) {
      const result = await query("SELECT record_json FROM habitat_tasks WHERE id = ? LIMIT 1", [String(id)]);
      return decode(result[0]?.results?.[0] || {});
    },
    async list({ limit = 100, status } = {}) {
      const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
      const result = status
        ? await query("SELECT record_json FROM habitat_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?", [String(status), safeLimit])
        : await query("SELECT record_json FROM habitat_tasks ORDER BY updated_at DESC LIMIT ?", [safeLimit]);
      return (result[0]?.results || []).map(decode).filter(Boolean);
    },
    async update(id, patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Task update requires a patch object.");
      const current = await this.get(id);
      if (!current) return null;
      const next = { ...current, ...structuredClone(patch), id: current.id };
      const updatedAt = String(next.updatedAt || new Date().toISOString());
      await query("UPDATE habitat_tasks SET record_json = ?, status = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify(next), String(next.status || "queued"), updatedAt, current.id
      ]);
      return next;
    },
    async delete(id) {
      const result = await query("DELETE FROM habitat_tasks WHERE id = ?", [String(id)]);
      return Number(result[0]?.meta?.changes || 0) > 0;
    },
    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}
