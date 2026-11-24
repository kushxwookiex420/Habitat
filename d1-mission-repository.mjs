import { createD1RowQuery } from "./nexus-runtime.mjs";

/**
 * Durable mission store.
 *
 * Same `query(sql, params)` contract as the workforce repository, so D1 in a deployment and
 * `node:sqlite` in tests run identical SQL. Writes are compare-and-swap on `version`; the event log is
 * append-only and ordered by sequence, not timestamp.
 *
 * `initialize()` is for tests and local development. The runtime calls `verifySchema()` instead and
 * refuses to start when the mission or nonce tables are absent, because a web process must not migrate.
 *
 * Approval nonces live in their own table (0017) with the nonce as primary key. That primary key, not an
 * application check, is the final replay boundary: concurrent instances racing one attestation reach the
 * same INSERT and exactly one succeeds. `nonceUsed()` is an indexed equality lookup, no JSON scanning.
 */

export const MISSION_TABLE_NAMES = Object.freeze([
  "habitat_ax_missions",
  "habitat_ax_mission_events",
  "habitat_ax_approval_nonces"
]);

export const NONCE_TABLE = "habitat_ax_approval_nonces";

export const MISSION_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS habitat_ax_missions (id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_missions_status ON habitat_ax_missions(status, updated_at DESC)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_mission_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_mission_events_mission ON habitat_ax_mission_events(mission_id, seq)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_approval_nonces (nonce TEXT PRIMARY KEY NOT NULL, key_id TEXT, mission_id TEXT NOT NULL, approval_id TEXT, task_id TEXT, decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')), issued_at TEXT, expires_at TEXT, consumed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'consumed' CHECK (status IN ('consumed', 'revoked', 'expired', 'released')), revoked_at TEXT, revoke_reason TEXT)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_approval_nonces_mission ON habitat_ax_approval_nonces(mission_id, consumed_at DESC)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_approval_nonces_approval ON habitat_ax_approval_nonces(approval_id)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_approval_nonces_expiry ON habitat_ax_approval_nonces(status, expires_at)"
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
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" + MISSION_TABLE_NAMES.map(() => "?").join(", ") + ")",
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

    /** Indexed replay lookup. The registry is authoritative; a nonce is spent once its row exists. */
    async nonceUsed(nonce) {
      const rows = await query("SELECT 1 AS used FROM " + NONCE_TABLE + " WHERE nonce = ? LIMIT 1", [String(nonce)]);
      return (rows || []).length > 0;
    },

    /**
     * Consume an approval nonce. The primary key is the replay boundary: a duplicate INSERT raises on both
     * SQLite and D1, and no second decision can pass. Returns `replayed` without throwing for duplicates;
     * any other failure propagates so the caller can fail closed.
     */
    async consumeNonce(entry = {}) {
      const nonce = String(entry.nonce || "");
      if (!nonce) return { ok: false, code: "owner_attestation_invalid" };
      const at = now();
      try {
        await query(
          "INSERT INTO " + NONCE_TABLE + " (nonce, key_id, mission_id, approval_id, task_id, decision, issued_at, expires_at, consumed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed')",
          [
            nonce,
            entry.keyId ? String(entry.keyId).slice(0, 64) : null,
            String(entry.missionId || ""),
            entry.approvalId ? String(entry.approvalId).slice(0, 200) : null,
            entry.taskId ? String(entry.taskId).slice(0, 120) : null,
            entry.decision === "reject" ? "reject" : "approve",
            entry.issuedAt ? String(entry.issuedAt) : null,
            entry.expiresAt ? String(entry.expiresAt) : null,
            at
          ]
        );
        return { ok: true, nonce, consumedAt: at };
      } catch (error) {
        // A unique violation is the replay answer. Anything else (binding lost, storage failure) must be
        // told apart from it, because "storage unavailable" is not "already used".
        let existing = null;
        try {
          const rows = await query("SELECT nonce FROM " + NONCE_TABLE + " WHERE nonce = ? LIMIT 1", [nonce]);
          existing = (rows || []).length > 0;
        } catch {
          throw error;
        }
        if (existing) return { ok: false, code: "owner_attestation_replayed" };
        throw error;
      }
    },

    /**
     * Compensating rollback: the registry row is written before the mission approval so uniqueness decides
     * races. If the mission write then fails, the freshly consumed row is deleted so a retry is possible.
     * Only a still-`consumed` row is released; a revocation or expiry state is not undone.
     */
    async releaseNonce(nonce) {
      const rows = await query(
        "DELETE FROM " + NONCE_TABLE + " WHERE nonce = ? AND status = 'consumed' RETURNING nonce",
        [String(nonce)]
      );
      return { ok: true, released: (rows || []).length > 0 };
    },

    /** Mark the registry row behind one approval as revoked. The mission record remains authoritative. */
    async revokeNonce({ missionId, approvalId = null, taskId = null, reason = null } = {}) {
      const at = now();
      const rows = await query(
        "UPDATE " + NONCE_TABLE + " SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE mission_id = ? AND status = 'consumed' AND " +
          (approvalId ? "approval_id = ?" : "task_id = ?") + " RETURNING nonce",
        approvalId
          ? [at, reason ? String(reason).slice(0, 200) : null, String(missionId), String(approvalId)]
          : [at, reason ? String(reason).slice(0, 200) : null, String(missionId), String(taskId)]
      );
      return { ok: true, revoked: (rows || []).map((row) => row.nonce) };
    },

    /** Expiry cleanup: mark, never delete, so an expired attestation still cannot be replayed. */
    async expireNonces(before) {
      const rows = await query(
        "UPDATE " + NONCE_TABLE + " SET status = 'expired' WHERE status = 'consumed' AND expires_at IS NOT NULL AND expires_at <= ? RETURNING nonce",
        [String(before)]
      );
      return { ok: true, expired: (rows || []).length };
    },

    async nonceRecord(nonce) {
      const rows = await query("SELECT * FROM " + NONCE_TABLE + " WHERE nonce = ?", [String(nonce)]);
      return rows?.[0] || null;
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
