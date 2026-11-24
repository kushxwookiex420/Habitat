import { createD1RowQuery } from "./nexus-runtime.mjs";

/**
 * Durable mission store.
 *
 * Same `query(sql, params)` contract as the workforce repository, so D1 in a deployment and
 * `node:sqlite` in tests run identical SQL. Writes are compare-and-swap on `version`; the event log is
 * append-only and ordered by sequence, not timestamp.
 *
 * `initialize()` is for tests and local development. The runtime calls `verifySchema()` instead and
 * refuses to start when migration 0011 is absent, because a web process must not migrate a database.
 */

export const MISSION_TABLE_NAMES = Object.freeze(["habitat_ax_missions", "habitat_ax_mission_events"]);

export const MISSION_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS habitat_ax_missions (id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_missions_status ON habitat_ax_missions(status, updated_at DESC)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_mission_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_mission_events_mission ON habitat_ax_mission_events(mission_id, seq)"
]);

function parse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function createMissionRepository({ query, now = () => new Date().toISOString() } = {}) {
  if (typeof query !== "function") throw new Error("The mission repository needs a query function.");
  let initializing = null;

  return Object.freeze({
    adapter: "sql",
    durable: true,

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          for (const statement of MISSION_DDL) await query(statement);
          return { ok: true, statements: MISSION_DDL.length };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },

    async verifySchema() {
      const rows = await query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        MISSION_TABLE_NAMES
      );
      const present = new Set((rows || []).map(row => row.name));
      return {
        ok: MISSION_TABLE_NAMES.every(name => present.has(name)),
        missing: MISSION_TABLE_NAMES.filter(name => !present.has(name)),
        expected: MISSION_TABLE_NAMES.length
      };
    },

    /** Insert once. A duplicate submission returns the stored record rather than creating another. */
    async create(record) {
      const at = now();
      // Check first as well as relying on the primary key: duplicate detection must not depend on how a
      // particular driver reports a constraint error.
      const existing = await this.get(record.id);
      if (existing) return { created: false, record: existing.record || null, version: existing.record?.version ?? null };
      let inserted = false;
      try {
        // A duplicate id raises on both SQLite and D1; that is how a duplicate submission is detected
        // without trusting a RETURNING shape that differs between drivers.
        await query(
          "INSERT INTO habitat_ax_missions (id, project, status, version, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [record.id, record.project, record.status, Number(record.version) || 1, JSON.stringify(record), record.createdAt || at, record.updatedAt || at]
        );
        inserted = true;
      } catch (error) {
        const stored = await this.get(record.id);
        if (!stored) throw error;
      }
      const stored = await this.get(record.id);
      return { created: inserted, record: stored?.record || null, version: stored?.record?.version ?? null };
    },

    async get(id) {
      const rows = await query("SELECT version, record_json FROM habitat_ax_missions WHERE id = ?", [String(id)]);
      const row = rows?.[0];
      const record = row ? parse(row.record_json) : null;
      return record ? { record, version: Number(row.version) } : null;
    },

    async save(record, expectedVersion) {
      const at = now();
      const nextVersion = Number(expectedVersion) + 1;
      const rows = await query(
        "UPDATE habitat_ax_missions SET status = ?, version = ?, record_json = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING version",
        [record.status, nextVersion, JSON.stringify({ ...record, version: nextVersion, updatedAt: at }), at, record.id, Number(expectedVersion)]
      );
      if ((rows || []).length === 1) return { ok: true, version: nextVersion, record: { ...record, version: nextVersion, updatedAt: at } };
      const current = await this.get(record.id);
      return { ok: false, code: current ? "mission_conflict" : "mission_missing", current };
    },

    async list({ status = null, limit = 50 } = {}) {
      const bound = Math.max(1, Math.min(100, Number(limit) || 50));
      const rows = status
        ? await query("SELECT record_json FROM habitat_ax_missions WHERE status = ? ORDER BY updated_at DESC LIMIT ?", [String(status), bound])
        : await query("SELECT record_json FROM habitat_ax_missions ORDER BY updated_at DESC LIMIT ?", [bound]);
      return (rows || []).map(row => parse(row.record_json)).filter(Boolean);
    },

    async appendEvent(missionId, type, payload = {}) {
      await query(
        "INSERT INTO habitat_ax_mission_events (mission_id, at, type, payload_json) VALUES (?, ?, ?, ?)",
        [String(missionId), now(), String(type), JSON.stringify(payload)]
      );
      return { ok: true };
    },

    async events(missionId, { limit = 200 } = {}) {
      const rows = await query(
        "SELECT seq, at, type, payload_json FROM habitat_ax_mission_events WHERE mission_id = ? ORDER BY seq ASC LIMIT ?",
        [String(missionId), Math.max(1, Math.min(500, Number(limit) || 200))]
      );
      return (rows || []).map(row => ({ seq: Number(row.seq), at: row.at, type: row.type, ...(parse(row.payload_json) || {}) }));
    },

    async counts() {
      const rows = await query("SELECT status, COUNT(*) AS total FROM habitat_ax_missions GROUP BY status");
      const byStatus = {};
      for (const row of rows || []) byStatus[row.status] = Number(row.total);
      return { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
    }
  });
}

export function createD1MissionRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1RowQuery({ accountId, databaseId, apiToken, fetchImpl });
  return Object.freeze({ ...createMissionRepository({ query }), adapter: "cloudflare-d1" });
}
