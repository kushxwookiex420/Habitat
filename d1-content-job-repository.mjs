const API = "https://api.cloudflare.com/client/v4";

export function createD1ContentJobRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("D1 content-job storage requires CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID, and HABITAT_D1_API_TOKEN.");
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
      throw new Error(`D1 content-job query failed with HTTP ${response.status}; check D1 credentials, database ID, and schema.`);
    }
    return payload.result || [];
  }

  function decode(row) {
    try {
      const job = JSON.parse(row.record_json);
      return job && typeof job.id === "string" ? job : null;
    } catch { return null; }
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_content_jobs (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_content_jobs_updated_at ON habitat_content_jobs(updated_at DESC)");
      return { ok: true, adapter: "cloudflare-d1" };
    },
    async upsert(job) {
      if (!job || typeof job.id !== "string" || !job.id.trim()) {
        throw new Error("Content-job persistence requires a non-empty string id.");
      }
      const updatedAt = String(job.updatedAt || job.createdAt || new Date().toISOString());
      await query(
        "INSERT INTO habitat_content_jobs (id, record_json, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, status = excluded.status, updated_at = excluded.updated_at",
        [job.id, JSON.stringify(job), String(job.status || "queued"), updatedAt]
      );
      return structuredClone(job);
    },
    async get(id) {
      const result = await query("SELECT record_json FROM habitat_content_jobs WHERE id = ? LIMIT 1", [String(id)]);
      return decode(result[0]?.results?.[0] || {});
    },
    async list({ limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
      const result = await query("SELECT record_json FROM habitat_content_jobs ORDER BY updated_at DESC LIMIT ?", [safeLimit]);
      return (result[0]?.results || []).map(decode).filter(Boolean);
    },
    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}
