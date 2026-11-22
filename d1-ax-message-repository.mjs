import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Persistence for the Ax <-> NEXUS message channel.
 *
 * One row per message; a thread is the set of rows sharing a correlation id. The record is written
 * as JSON and every update is compare-and-swap on the stored bytes, so an acknowledgement, a
 * progress note and a completion arriving out of order cannot overwrite one another.
 *
 * Two implementations, one contract: `create`, `getRecord`, `update`, `list`, `countSince`.
 * The in-memory store exists so the channel can be tested without D1; it is never mounted as a
 * production store.
 */

function sortOldest(records) {
  return records.slice().sort((a, b) => {
    const left = String(a.createdAt || "");
    const right = String(b.createdAt || "");
    if (left !== right) return left.localeCompare(right);
    return String(a.id).localeCompare(String(b.id));
  });
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

export function createMemoryMessageRepository({ records = [] } = {}) {
  const rows = new Map();
  for (const record of records) rows.set(record.id, JSON.stringify(record));

  return Object.freeze({
    adapter: "memory",
    durable: false,
    table: "habitat_ax_messages",

    async initialize() {
      return { ok: true };
    },

    async create(record) {
      if (!record?.id) throw new Error("A message needs an id.");
      if (rows.has(record.id)) {
        return { created: false, message: decode(rows.get(record.id)) };
      }
      rows.set(record.id, JSON.stringify(record));
      return { created: true, message: record };
    },

    async getRecord(id) {
      const recordJson = rows.get(String(id)) || null;
      return { message: decode(recordJson), recordJson };
    },

    async update(record, expectedRecordJson) {
      if (!record?.id) throw new Error("A message needs an id.");
      if (typeof expectedRecordJson !== "string" || !expectedRecordJson) {
        throw new Error("A message update needs the record it replaces.");
      }
      const current = rows.get(record.id);
      if (current === undefined) return { ok: false, reason: "missing", message: null, recordJson: null };
      if (current !== expectedRecordJson) {
        return { ok: false, reason: "conflict", message: decode(current), recordJson: current };
      }
      rows.set(record.id, JSON.stringify(record));
      return { ok: true, message: record, recordJson: JSON.stringify(record) };
    },

    async list({ status = null, correlationId = null, from = null, project = null, since = null, limit = 50, order = "newest" } = {}) {
      const limitSafe = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
      let all = [...rows.values()].map(decode).filter(Boolean);
      if (status) all = all.filter(record => record.status === status);
      if (correlationId) all = all.filter(record => record.correlationId === correlationId);
      if (from) all = all.filter(record => record.from === from);
      if (project) all = all.filter(record => record.project === project);
      if (since) all = all.filter(record => String(record.createdAt || "") >= String(since));
      const ordered = order === "oldest"
        ? sortOldest(all)
        : all.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return ordered.slice(0, limitSafe);
    },

    async countSince({ from, since, status = null } = {}) {
      return (await this.list({ from, since, status, limit: 200, order: "oldest" })).length;
    },

    _rows: rows
  });
}

export function createD1AxMessageRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  let initializing = null;

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_ax_messages",

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          // Additive and idempotent only; no existing table is dropped, renamed or rewritten.
          await query("CREATE TABLE IF NOT EXISTS habitat_ax_messages (id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, from_origin TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, correlation_id TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_messages_correlation ON habitat_ax_messages(correlation_id, created_at)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_messages_status_updated ON habitat_ax_messages(status, updated_at)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_messages_origin_created ON habitat_ax_messages(from_origin, created_at)");
          return { ok: true };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },

    async create(record) {
      if (!record?.id) throw new Error("A message needs an id.");
      const recordJson = JSON.stringify(record);
      await query(
        "INSERT INTO habitat_ax_messages (id, project, from_origin, kind, status, correlation_id, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        [
          record.id,
          String(record.project || "habitat"),
          String(record.from || "ax"),
          String(record.kind || "note"),
          String(record.status || "queued"),
          String(record.correlationId || ""),
          recordJson,
          String(record.createdAt || new Date().toISOString()),
          String(record.updatedAt || record.createdAt || new Date().toISOString())
        ]
      );
      const read = await query("SELECT record_json FROM habitat_ax_messages WHERE id = ? LIMIT 1", [record.id]);
      const storedJson = read[0]?.results?.[0]?.record_json || recordJson;
      return { created: storedJson === recordJson, message: decode(storedJson) };
    },

    async getRecord(id) {
      const result = await query("SELECT record_json FROM habitat_ax_messages WHERE id = ? LIMIT 1", [String(id)]);
      const recordJson = result[0]?.results?.[0]?.record_json || null;
      return { message: decode(recordJson), recordJson };
    },

    async update(record, expectedRecordJson) {
      if (!record?.id) throw new Error("A message needs an id.");
      if (typeof expectedRecordJson !== "string" || !expectedRecordJson) {
        throw new Error("A message update needs the record it replaces.");
      }
      const recordJson = JSON.stringify(record);
      const result = await query(
        "UPDATE habitat_ax_messages SET status = ?, kind = ?, correlation_id = ?, record_json = ?, updated_at = ? WHERE id = ? AND record_json = ? RETURNING id",
        [
          String(record.status || "queued"),
          String(record.kind || "note"),
          String(record.correlationId || ""),
          recordJson,
          String(record.updatedAt || new Date().toISOString()),
          record.id,
          expectedRecordJson
        ]
      );
      if ((result[0]?.results || []).length === 1) return { ok: true, message: record, recordJson };
      const read = await query("SELECT record_json FROM habitat_ax_messages WHERE id = ? LIMIT 1", [record.id]);
      const storedJson = read[0]?.results?.[0]?.record_json || null;
      return { ok: false, reason: storedJson ? "conflict" : "missing", message: decode(storedJson), recordJson: storedJson };
    },

    async list({ status = null, correlationId = null, from = null, project = null, since = null, limit = 50, order = "newest" } = {}) {
      const limitSafe = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
      const clauses = [];
      const params = [];
      if (status) { clauses.push("status = ?"); params.push(String(status)); }
      if (correlationId) { clauses.push("correlation_id = ?"); params.push(String(correlationId)); }
      if (from) { clauses.push("from_origin = ?"); params.push(String(from)); }
      if (project) { clauses.push("project = ?"); params.push(String(project)); }
      if (since) { clauses.push("created_at >= ?"); params.push(String(since)); }
      const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      const direction = order === "oldest" ? "ASC" : "DESC";
      const sortColumn = order === "oldest" ? "created_at" : "updated_at";
      const result = await query(
        "SELECT record_json FROM habitat_ax_messages" + where + " ORDER BY " + sortColumn + " " + direction + ", id " + direction + " LIMIT ?",
        [...params, limitSafe]
      );
      return (result[0]?.results || []).map(row => decode(row.record_json)).filter(Boolean);
    },

    async countSince({ from, since, status = null } = {}) {
      const clauses = ["from_origin = ?", "created_at >= ?"];
      const params = [String(from || ""), String(since || "1970-01-01T00:00:00.000Z")];
      if (status) { clauses.push("status = ?"); params.push(String(status)); }
      const result = await query(
        "SELECT COUNT(*) AS n FROM habitat_ax_messages WHERE " + clauses.join(" AND "),
        params
      );
      return Number(result[0]?.results?.[0]?.n || 0);
    }
  });
}
