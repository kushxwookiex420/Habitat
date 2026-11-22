import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Persistence for Ax objectives.
 *
 * Two implementations, one contract: `create`, `update(record, token)`, `getRecord`, `list`.
 * Writes are compare-and-swap on the stored bytes, so a retried request, a cron worker and a
 * recovery pass cannot overwrite each other. The in-memory store implements the same contract so the
 * lifecycle can be tested without D1; it is never mounted as a production store.
 */

function sortNewest(records) {
  return records.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function decode(recordJson) {
  if (typeof recordJson !== "string") return null;
  try {
    const value = JSON.parse(recordJson);
    return value && typeof value.id === "string" ? value : null;
  } catch {
    return null;
  }
}

export function createMemoryObjectiveRepository({ records = [] } = {}) {
  const rows = new Map();
  for (const record of records) rows.set(record.id, JSON.stringify(record));

  return Object.freeze({
    adapter: "memory",
    durable: false,
    table: "habitat_ax_objectives",

    async initialize() {
      return { ok: true };
    },
    async create(record) {
      if (!record?.id) throw new Error("An objective needs an id.");
      const recordJson = JSON.stringify(record);
      if (rows.has(record.id)) {
        const existing = rows.get(record.id);
        return { created: false, objective: decode(existing), recordJson: existing };
      }
      rows.set(record.id, recordJson);
      return { created: true, objective: record, recordJson };
    },
    async update(record, expectedRecordJson) {
      if (!record?.id) throw new Error("An objective needs an id.");
      if (typeof expectedRecordJson !== "string" || !expectedRecordJson) throw new Error("An update needs the record it replaces.");
      const current = rows.get(record.id);
      if (current === undefined) return { ok: false, reason: "missing", objective: null, recordJson: null };
      if (current !== expectedRecordJson) return { ok: false, reason: "conflict", objective: decode(current), recordJson: current };
      const recordJson = JSON.stringify(record);
      rows.set(record.id, recordJson);
      return { ok: true, objective: record, recordJson };
    },
    async getRecord(id) {
      const recordJson = rows.get(String(id)) || null;
      return { objective: decode(recordJson), recordJson };
    },
    async list({ status = null, limit = 20 } = {}) {
      const limitSafe = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
      const all = [...rows.values()].map(decode).filter(Boolean);
      const filtered = status ? all.filter(record => record.status === status) : all;
      return sortNewest(filtered).slice(0, limitSafe);
    },
    _rows: rows
  });
}

export function createD1AxObjectiveRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  let initializing = null;

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_ax_objectives",

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          // Additive and idempotent only. No existing table is dropped, renamed or rewritten.
          await query("CREATE TABLE IF NOT EXISTS habitat_ax_objectives (id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_objectives_updated_at ON habitat_ax_objectives(updated_at DESC)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_objectives_status ON habitat_ax_objectives(status)");
          return { ok: true };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },

    async create(record) {
      if (!record?.id) throw new Error("An objective needs an id.");
      const recordJson = JSON.stringify(record);
      await query(
        "INSERT INTO habitat_ax_objectives (id, project, status, record_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        [record.id, String(record.project || "habitat"), String(record.status || "received"), recordJson, String(record.updatedAt || new Date().toISOString())]
      );
      const read = await query("SELECT record_json FROM habitat_ax_objectives WHERE id = ? LIMIT 1", [record.id]);
      const storedJson = read[0]?.results?.[0]?.record_json || recordJson;
      return { created: storedJson === recordJson, objective: decode(storedJson), recordJson: storedJson };
    },

    async update(record, expectedRecordJson) {
      if (!record?.id) throw new Error("An objective needs an id.");
      if (typeof expectedRecordJson !== "string" || !expectedRecordJson) throw new Error("An update needs the record it replaces.");
      const recordJson = JSON.stringify(record);
      const result = await query(
        "UPDATE habitat_ax_objectives SET project = ?, status = ?, record_json = ?, updated_at = ? WHERE id = ? AND record_json = ? RETURNING id",
        [String(record.project || "habitat"), String(record.status || "received"), recordJson, String(record.updatedAt || new Date().toISOString()), record.id, expectedRecordJson]
      );
      if ((result[0]?.results || []).length === 1) return { ok: true, objective: record, recordJson };
      const read = await query("SELECT record_json FROM habitat_ax_objectives WHERE id = ? LIMIT 1", [record.id]);
      const storedJson = read[0]?.results?.[0]?.record_json || null;
      return { ok: false, reason: storedJson ? "conflict" : "missing", objective: decode(storedJson), recordJson: storedJson };
    },

    async getRecord(id) {
      const result = await query("SELECT record_json FROM habitat_ax_objectives WHERE id = ? LIMIT 1", [String(id)]);
      const recordJson = result[0]?.results?.[0]?.record_json || null;
      return { objective: decode(recordJson), recordJson };
    },

    async list({ status = null, limit = 20 } = {}) {
      const limitSafe = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
      const result = status
        ? await query("SELECT record_json FROM habitat_ax_objectives WHERE status = ? ORDER BY updated_at DESC LIMIT ?", [String(status), limitSafe])
        : await query("SELECT record_json FROM habitat_ax_objectives ORDER BY updated_at DESC LIMIT ?", [limitSafe]);
      return (result[0]?.results || []).map(row => decode(row.record_json)).filter(Boolean);
    }
  });
}
