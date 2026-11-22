import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Durable incident history.
 *
 * An incident is a durable record of an operational finding — what was observed, why it matters,
 * what safe action was attempted and whether the verification passed. Incidents are deduplicated by
 * fingerprint, so a monitor that runs every minute on the same broken dependency updates one row
 * instead of flooding the history with duplicates.
 */

function decode(recordJson) {
  if (typeof recordJson !== "string") return null;
  try {
    const value = JSON.parse(recordJson);
    return value && typeof value.id === "string" ? value : null;
  } catch {
    return null;
  }
}

export function createMemoryIncidentRepository({ records = [] } = {}) {
  const rows = new Map();
  for (const record of records) rows.set(record.id, JSON.stringify(record));
  const byFingerprint = () => {
    const map = new Map();
    for (const json of rows.values()) {
      const record = decode(json);
      if (record) map.set(record.fingerprint, record.id);
    }
    return map;
  };

  return Object.freeze({
    adapter: "memory",
    durable: false,
    async initialize() {
      return { ok: true };
    },
    async create(record) {
      const recordJson = JSON.stringify(record);
      const existingId = byFingerprint().get(record.fingerprint);
      if (existingId) {
        const existing = rows.get(existingId);
        return { created: false, incident: decode(existing), recordJson: existing };
      }
      rows.set(record.id, recordJson);
      return { created: true, incident: record, recordJson };
    },
    async update(record, expectedRecordJson) {
      const current = rows.get(record.id);
      if (current === undefined) return { ok: false, reason: "missing", incident: null, recordJson: null };
      if (current !== expectedRecordJson) return { ok: false, reason: "conflict", incident: decode(current), recordJson: current };
      const recordJson = JSON.stringify(record);
      rows.set(record.id, recordJson);
      return { ok: true, incident: record, recordJson };
    },
    async getRecord(id) {
      const recordJson = rows.get(String(id)) || null;
      return { incident: decode(recordJson), recordJson };
    },
    async getByFingerprint(fingerprint) {
      const id = byFingerprint().get(String(fingerprint));
      const recordJson = id ? rows.get(id) : null;
      return { incident: decode(recordJson), recordJson };
    },
    async list({ status = null, limit = 50 } = {}) {
      const limitSafe = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      return [...rows.values()]
        .map(decode)
        .filter(Boolean)
        .filter(record => (status ? record.status === status : true))
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, limitSafe);
    }
  });
}

export function createD1AxIncidentRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  let initializing = null;

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    initialize() {
      if (!initializing) {
        initializing = (async () => {
          await query("CREATE TABLE IF NOT EXISTS habitat_ax_incidents (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
          await query("CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_incidents_fingerprint ON habitat_ax_incidents(fingerprint)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_incidents_created_at ON habitat_ax_incidents(created_at DESC)");
          return { ok: true };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },
    async create(record) {
      const recordJson = JSON.stringify(record);
      await query(
        "INSERT INTO habitat_ax_incidents (id, fingerprint, kind, severity, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO NOTHING",
        [record.id, record.fingerprint, record.kind, record.severity, recordJson, record.createdAt, record.updatedAt]
      );
      const read = await query("SELECT record_json FROM habitat_ax_incidents WHERE fingerprint = ? LIMIT 1", [record.fingerprint]);
      const stored = read[0]?.results?.[0]?.record_json || recordJson;
      return { created: stored === recordJson, incident: decode(stored), recordJson: stored };
    },
    async update(record, expectedRecordJson) {
      const recordJson = JSON.stringify(record);
      const result = await query(
        "UPDATE habitat_ax_incidents SET severity = ?, record_json = ?, updated_at = ? WHERE id = ? AND record_json = ? RETURNING id",
        [record.severity, recordJson, record.updatedAt, record.id, expectedRecordJson]
      );
      if ((result[0]?.results || []).length === 1) return { ok: true, incident: record, recordJson };
      const read = await query("SELECT record_json FROM habitat_ax_incidents WHERE id = ? LIMIT 1", [record.id]);
      const stored = read[0]?.results?.[0]?.record_json || null;
      return { ok: false, reason: stored ? "conflict" : "missing", incident: decode(stored), recordJson: stored };
    },
    async getRecord(id) {
      const result = await query("SELECT record_json FROM habitat_ax_incidents WHERE id = ? LIMIT 1", [String(id)]);
      const recordJson = result[0]?.results?.[0]?.record_json || null;
      return { incident: decode(recordJson), recordJson };
    },
    async getByFingerprint(fingerprint) {
      const result = await query("SELECT record_json FROM habitat_ax_incidents WHERE fingerprint = ? LIMIT 1", [String(fingerprint)]);
      const recordJson = result[0]?.results?.[0]?.record_json || null;
      return { incident: decode(recordJson), recordJson };
    },
    async list({ status = null, limit = 50 } = {}) {
      const limitSafe = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      const result = status
        ? await query("SELECT record_json FROM habitat_ax_incidents WHERE record_json LIKE ? ORDER BY created_at DESC LIMIT ?", ['%"status":"' + String(status) + '"%', limitSafe])
        : await query("SELECT record_json FROM habitat_ax_incidents ORDER BY created_at DESC LIMIT ?", [limitSafe]);
      return (result[0]?.results || []).map(row => decode(row.record_json)).filter(Boolean);
    }
  });
}
