const API = "https://api.cloudflare.com/client/v4";

/**
 * Fenced transition: one conditional UPDATE. It succeeds only when the row is still 'working' and
 * still carries the expected fence and claimedBy, so a stale worker cannot overwrite a newer claim
 * even if it checked ownership a moment earlier. This is the authoritative check; worker-side
 * checks are only a fast path.
 */
/**
 * Unfenced legacy update: one conditional UPDATE. The row must still be unfenced and still carry
 * the status the caller read, so a claim that lands after the SELECT turns the write into a no-op.
 * The SELECT is only used to merge the patch; this statement is the security boundary.
 */
export const COMMAND_TASK_UNFENCED_UPDATE_SQL =
  "UPDATE habitat_command_tasks SET record_json = ?, status = ?, updated_at = ? " +
  "WHERE id = ? AND status = ? " +
  "AND json_extract(record_json, '$.fence') IS NULL " +
  "AND record_json = ? RETURNING record_json";

export const COMMAND_TASK_FENCED_SQL =
  "UPDATE habitat_command_tasks SET record_json = ?, status = ?, updated_at = ? " +
  "WHERE id = ? AND status = ? " +
  "AND json_extract(record_json, '$.fence') IS ? " +
  "AND json_extract(record_json, '$.claimedBy') IS ? RETURNING record_json";

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
      // Read the exact stored bytes: they become the optimistic-concurrency token, so two legacy
      // writers that read the same version cannot both win.
      const read = await query("SELECT record_json FROM habitat_command_tasks WHERE id = ? LIMIT 1", [String(id)]);
      const original = read[0]?.results?.[0]?.record_json;
      if (!original) return null;
      const current = decode({ record_json: original });
      if (!current) throw new Error("A command record could not be decoded; refusing to update.");
      if (current.fence) {
        throw new Error("Refusing to overwrite a fenced command task; use transition() with the current fence.");
      }
      const expectedStatus = String(current.status || "queued");
      const next = { ...current, ...structuredClone(patch), id: current.id };
      const updatedAt = String(next.updatedAt || new Date().toISOString());
      const result = await query(COMMAND_TASK_UNFENCED_UPDATE_SQL, [
        JSON.stringify(next),
        String(next.status || "queued"),
        updatedAt,
        current.id,
        expectedStatus,
        original
      ]);
      const stored = decode(result[0]?.results?.[0] || {});
      if (!stored) {
        // Fence appeared (claim), status changed, or another legacy writer committed first.
        throw new Error("Refusing to update a command task that changed while it was being updated (concurrent claim or stale write).");
      }
      return stored;
    },

    /**
     * Atomic fenced transition. Returns the stored record, or null when the expectation no longer
     * holds (stale claim, already terminal, changed owner). Never writes on a mismatch.
     */
    async transition(id, { expect, next } = {}) {
      if (!expect || typeof expect !== "object") throw new Error("A fenced command transition needs an expect object.");
      if (!next || typeof next !== "object") throw new Error("A fenced command transition needs the next record.");
      const at = String(next.updatedAt || new Date().toISOString());
      const result = await query(COMMAND_TASK_FENCED_SQL, [
        JSON.stringify({ ...next, id: String(id) }),
        String(next.status || "working"),
        at,
        String(id),
        String(expect.status || "working"),
        expect.fence ?? null,
        expect.claimedBy ?? null
      ]);
      return decode(result[0]?.results?.[0] || {});
    },

    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}
