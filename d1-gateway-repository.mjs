import { createD1RowQuery } from "./nexus-runtime.mjs";

/**
 * Gateway storage: integration identities, single-use nonces and an append-only audit.
 *
 * Tokens are stored as SHA-256 hashes. `useNonce` is a database-level replay guard: the insert either
 * creates the row or returns nothing, so two concurrent requests with the same nonce cannot both win.
 */

export const GATEWAY_TABLE_NAMES = Object.freeze([
  "habitat_ax_gateway_clients",
  "habitat_ax_gateway_nonces",
  "habitat_ax_gateway_audit"
]);

export const GATEWAY_RATE_TABLE = "habitat_ax_gateway_rate_limits";
export const GATEWAY_RATE_MIGRATION = "0014_ax_gateway_rate_limits";

export const GATEWAY_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS habitat_ax_gateway_clients (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_gateway_clients_token ON habitat_ax_gateway_clients(token_hash)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_gateway_nonces (client_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (client_id, nonce))",
  "CREATE TABLE IF NOT EXISTS habitat_ax_gateway_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, at TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, outcome TEXT NOT NULL, detail_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_gateway_rate_limits (client_id TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (client_id, window_start))"
]);

function parseClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    tokenHash: row.token_hash,
    scopes: String(row.scopes || "").split(" ").filter(Boolean),
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    lastUsedAt: row.last_used_at || null
  };
}

export function createGatewayRepository({ query, now = () => new Date().toISOString() } = {}) {
  if (typeof query !== "function") throw new Error("The gateway repository needs a query function.");
  let initializing = null;

  return Object.freeze({
    durable: true,
    adapter: "sql",

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          for (const statement of GATEWAY_DDL) await query(statement);
          return { ok: true, statements: GATEWAY_DDL.length };
        })().catch(error => { initializing = null; throw error; });
      }
      return initializing;
    },

    async verifySchema() {
      const rows = await query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
        GATEWAY_TABLE_NAMES
      );
      const present = new Set((rows || []).map(row => row.name));
      return { ok: GATEWAY_TABLE_NAMES.every(name => present.has(name)), missing: GATEWAY_TABLE_NAMES.filter(name => !present.has(name)) };
    },

    async createClient({ id, label, tokenHash, scopes, expiresAt = null } = {}) {
      await query(
        "INSERT INTO habitat_ax_gateway_clients (id, label, token_hash, scopes, created_at, expires_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(id) DO NOTHING",
        [id, label, tokenHash, scopes.join(" "), now(), expiresAt]
      );
      return this.getClient(id);
    },

    async getClient(id) {
      const rows = await query("SELECT * FROM habitat_ax_gateway_clients WHERE id = ?", [String(id)]);
      return parseClient(rows?.[0]);
    },

    async listClients() {
      const rows = await query("SELECT * FROM habitat_ax_gateway_clients ORDER BY created_at ASC");
      return (rows || []).map(parseClient);
    },

    async revokeClient(id, { at = now(), reason = null } = {}) {
      const rows = await query(
        "UPDATE habitat_ax_gateway_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id",
        [at, String(id)]
      );
      if (!(rows || []).length) return { ok: false, code: "client_not_found_or_already_revoked" };
      await this.appendAudit({ clientId: id, method: "ADMIN", path: "client:revoke", status: 200, outcome: "revoked", detail: { reason } });
      return { ok: true };
    },

    /**
     * Shared, database-backed fixed-window rate limiting. Atomic increment means two gateway instances
     * on the same database enforce one combined budget instead of one budget each.
     */
    async consumeRateLimit({ clientId, windowMs = 60_000, max = 60, at = Date.now() } = {}) {
      const windowStart = Math.floor(Number(at) / Math.max(1000, Number(windowMs) || 60_000));
      try {
        await query(
          "INSERT INTO habitat_ax_gateway_rate_limits (client_id, window_start, count) VALUES (?, ?, 1) ON CONFLICT(client_id, window_start) DO UPDATE SET count = count + 1",
          [String(clientId), windowStart]
        );
        const rows = await query("SELECT count FROM habitat_ax_gateway_rate_limits WHERE client_id = ? AND window_start = ?", [String(clientId), windowStart]);
        const count = Number(rows?.[0]?.count || 0);
        return { ok: count <= Number(max), shared: true, count, windowStart };
      } catch (error) {
        // A deployment without migration 0014 keeps the in-memory limiter instead of refusing all traffic.
        return { ok: true, shared: false, error: String(error?.message || error).slice(0, 160) };
      }
    },

    async verifyRateLimitSchema() {
      const rows = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [GATEWAY_RATE_TABLE]);
      return { ok: (rows || []).length === 1, missing: (rows || []).length === 1 ? [] : [GATEWAY_RATE_TABLE] };
    },

    async touchClient(id, at = now()) {
      await query("UPDATE habitat_ax_gateway_clients SET last_used_at = ? WHERE id = ?", [at, String(id)]);
    },

    /** Returns `{ ok: true }` once per nonce; a repeat returns `{ ok: false, code: "nonce_replayed" }`. */
    async useNonce(clientId, nonce, expiresAt) {
      try {
        await query(
          "INSERT INTO habitat_ax_gateway_nonces (client_id, nonce, expires_at) VALUES (?, ?, ?)",
          [String(clientId), String(nonce), String(expiresAt)]
        );
        return { ok: true };
      } catch (error) {
        if (!/unique|constraint|already exists/i.test(String(error?.message || error))) throw error;
        const existing = await query("SELECT expires_at FROM habitat_ax_gateway_nonces WHERE client_id = ? AND nonce = ?", [String(clientId), String(nonce)]);
        return { ok: false, code: "nonce_replayed", expiresAt: existing?.[0]?.expires_at || null };
      }
    },

    async pruneNonces(at = now()) {
      await query("DELETE FROM habitat_ax_gateway_nonces WHERE expires_at <= ?", [String(at)]);
      return { ok: true };
    },

    async appendAudit({ clientId = null, method = "?", path = "?", status = 0, outcome = "unknown", detail = {} } = {}) {
      await query(
        "INSERT INTO habitat_ax_gateway_audit (client_id, at, method, path, status, outcome, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [clientId, now(), method, path, Number(status) || 0, outcome, JSON.stringify(detail)]
      );
      return { ok: true };
    },

    async listAudit({ limit = 100 } = {}) {
      const rows = await query(
        "SELECT seq, client_id, at, method, path, status, outcome, detail_json FROM habitat_ax_gateway_audit ORDER BY seq DESC LIMIT ?",
        [Math.max(1, Math.min(500, Number(limit) || 100))]
      );
      return (rows || []).map(row => ({
        seq: Number(row.seq), clientId: row.client_id, at: row.at, method: row.method, path: row.path,
        status: Number(row.status), outcome: row.outcome,
        detail: (() => { try { return JSON.parse(row.detail_json || "{}"); } catch { return {}; } })()
      }));
    },

    async counts() {
      const rows = await query("SELECT (SELECT COUNT(*) FROM habitat_ax_gateway_clients) AS clients, (SELECT COUNT(*) FROM habitat_ax_gateway_audit) AS audit");
      return { clients: Number(rows?.[0]?.clients || 0), audit: Number(rows?.[0]?.audit || 0) };
    }
  });
}

export function createD1GatewayRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1RowQuery({ accountId, databaseId, apiToken, fetchImpl });
  return Object.freeze({ ...createGatewayRepository({ query }), adapter: "cloudflare-d1" });
}
