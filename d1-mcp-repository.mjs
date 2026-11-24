import { createD1RowQuery } from "./nexus-runtime.mjs";

/**
 * Persistent state for the OpenAI MCP Events adapter.
 *
 * Subscriptions, verification cache, retained events and delivery rows all live in D1 so a restart does
 * not lose a subscription, a cursor or a queued event. Signing secrets are stored only because delivery
 * must sign; no read path returns them.
 */

export const MCP_TABLES = Object.freeze([
  "habitat_ax_mcp_subscriptions",
  "habitat_ax_mcp_verifications",
  "habitat_ax_mcp_events",
  "habitat_ax_mcp_deliveries",
  "habitat_ax_mcp_delivery_leases"
]);

export const MCP_MIGRATION = "0015_ax_mcp_events";

export const MCP_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS habitat_ax_mcp_subscriptions (id TEXT PRIMARY KEY NOT NULL, principal TEXT NOT NULL, name TEXT NOT NULL, args_json TEXT NOT NULL, args_canonical TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, previous_secret TEXT, secret_grace_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, refresh_before TEXT, revoked_at TEXT, last_cursor INTEGER, verified_at TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_mcp_subscriptions_identity ON habitat_ax_mcp_subscriptions(principal, name, args_canonical, url)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_mcp_verifications (principal TEXT NOT NULL, url TEXT NOT NULL, verified_at TEXT NOT NULL, PRIMARY KEY (principal, url))",
  "CREATE TABLE IF NOT EXISTS habitat_ax_mcp_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, name TEXT NOT NULL, data_json TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_mcp_events_event_id ON habitat_ax_mcp_events(event_id)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_mcp_events_name_seq ON habitat_ax_mcp_events(name, seq)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_mcp_deliveries (id TEXT PRIMARY KEY NOT NULL, subscription_id TEXT NOT NULL, event_seq INTEGER NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_mcp_deliveries_identity ON habitat_ax_mcp_deliveries(subscription_id, event_id)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_mcp_deliveries_due ON habitat_ax_mcp_deliveries(status, next_attempt_at)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_mcp_delivery_leases (delivery_id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, expires_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_mcp_delivery_leases_expiry ON habitat_ax_mcp_delivery_leases(expires_at)"
]);

function parseSubscription(row, secretBox = null) {
  if (!row) return null;
  let args = {};
  try { args = JSON.parse(row.args_json || "{}"); } catch { args = {}; }
  const decode = (value, binding = "secret") => {
    if (!value) return null;
    if (!secretBox) return value;
    const result = secretBox.decrypt(value, { aad: "mcp:" + row.id + ":" + binding });
    return result.ok ? result.plaintext : null;
  };
  return {
    id: row.id,
    principal: row.principal,
    name: row.name,
    arguments: args,
    argsCanonical: row.args_canonical,
    url: row.url,
    secret: decode(row.secret, "secret"),
    secretUnreadable: Boolean(row.secret) && secretBox ? decode(row.secret, "secret") === null : false,
    previousSecret: decode(row.previous_secret, "previous"),
    secretGraceUntil: row.secret_grace_until || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    refreshBefore: row.refresh_before || null,
    revokedAt: row.revoked_at || null,
    lastCursor: row.last_cursor === null || row.last_cursor === undefined ? null : Number(row.last_cursor),
    verifiedAt: row.verified_at || null
  };
}

function parseEvent(row) {
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data_json || "{}"); } catch { data = {}; }
  return { seq: Number(row.seq), eventId: row.event_id, name: row.name, data, occurredAt: row.occurred_at, createdAt: row.created_at };
}

function parseDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventSeq: Number(row.event_seq),
    eventId: row.event_id,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at || null,
    lastError: row.last_error || null,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null
  };
}

export function createMcpRepository({ query, now = () => new Date().toISOString(), secretBox = null } = {}) {
  if (typeof query !== "function") throw new Error("The MCP repository needs a query function.");
  if (secretBox && typeof secretBox.encrypt !== "function") throw new Error("secretBox must provide encrypt/decrypt.");
  let initializing = null;

  return Object.freeze({
    durable: true,
    adapter: "sql",

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          for (const statement of MCP_DDL) await query(statement);
          return { ok: true, statements: MCP_DDL.length };
        })().catch(error => { initializing = null; throw error; });
      }
      return initializing;
    },

    async verifySchema() {
      const rows = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?)", MCP_TABLES);
      const present = new Set((rows || []).map(row => row.name));
      return { ok: MCP_TABLES.every(name => present.has(name)), missing: MCP_TABLES.filter(name => !present.has(name)) };
    },

    async saveSubscription(subscription) {
      const at = now();
      const encode = (value, binding) => {
        if (!value) return null;
        if (!secretBox) return value;
        const encrypted = secretBox.encrypt(value, { aad: "mcp:" + subscription.id + ":" + binding });
        if (!encrypted) throw new Error("secret_encryption_failed");
        return encrypted;
      };
      const secret = encode(subscription.secret, "secret");
      const previousSecret = encode(subscription.previousSecret, "previous");
      await query(
        "INSERT INTO habitat_ax_mcp_subscriptions (id, principal, name, args_json, args_canonical, url, secret, previous_secret, secret_grace_until, created_at, updated_at, refresh_before, revoked_at, last_cursor, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, previous_secret = excluded.previous_secret, secret_grace_until = excluded.secret_grace_until, updated_at = excluded.updated_at, refresh_before = excluded.refresh_before, revoked_at = NULL, last_cursor = excluded.last_cursor, verified_at = excluded.verified_at",
        [
          subscription.id, subscription.principal, subscription.name, JSON.stringify(subscription.arguments || {}),
          subscription.argsCanonical, subscription.url, secret, previousSecret,
          subscription.secretGraceUntil || null, subscription.createdAt || at, at, subscription.refreshBefore || null,
          subscription.lastCursor ?? null, subscription.verifiedAt || at
        ]
      );
      return this.getSubscription(subscription.id);
    },

    async getSubscription(id) {
      const rows = await query("SELECT * FROM habitat_ax_mcp_subscriptions WHERE id = ?", [String(id)]);
      return parseSubscription(rows?.[0], secretBox);
    },

    async findSubscription({ principal, name, argsCanonical, url }) {
      const rows = await query("SELECT * FROM habitat_ax_mcp_subscriptions WHERE principal = ? AND name = ? AND args_canonical = ? AND url = ?", [String(principal), String(name), String(argsCanonical), String(url)]);
      return parseSubscription(rows?.[0], secretBox);
    },

    async listSubscriptions({ activeOnly = false, limit = 100 } = {}) {
      const rows = activeOnly
        ? await query("SELECT * FROM habitat_ax_mcp_subscriptions WHERE revoked_at IS NULL ORDER BY created_at ASC LIMIT ?", [Math.max(1, Math.min(500, Number(limit) || 100))])
        : await query("SELECT * FROM habitat_ax_mcp_subscriptions ORDER BY created_at ASC LIMIT ?", [Math.max(1, Math.min(500, Number(limit) || 100))]);
      return (rows || []).map(row => parseSubscription(row, secretBox));
    },

    async revokeSubscription(id, { at = now() } = {}) {
      const rows = await query("UPDATE habitat_ax_mcp_subscriptions SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL", [at, at, String(id)]);
      return { ok: Number(rows?.[0]?.changes || 0) > 0 };
    },

    async expireSubscriptions({ at = now() } = {}) {
      const rows = await query("UPDATE habitat_ax_mcp_subscriptions SET revoked_at = ?, updated_at = ? WHERE revoked_at IS NULL AND refresh_before IS NOT NULL AND refresh_before <= ?", [at, at, String(at)]);
      return { ok: true, expired: Number(rows?.[0]?.changes || 0) };
    },

    async recordVerification({ principal, url, at = now() }) {
      await query("INSERT INTO habitat_ax_mcp_verifications (principal, url, verified_at) VALUES (?, ?, ?) ON CONFLICT(principal, url) DO UPDATE SET verified_at = excluded.verified_at", [String(principal), String(url), at]);
      return { ok: true };
    },

    async getVerification({ principal, url }) {
      const rows = await query("SELECT verified_at FROM habitat_ax_mcp_verifications WHERE principal = ? AND url = ?", [String(principal), String(url)]);
      return rows?.[0]?.verified_at || null;
    },

    async appendEvent({ eventId, name, data = {}, occurredAt = now() }) {
      const at = now();
      try {
        await query("INSERT INTO habitat_ax_mcp_events (event_id, name, data_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?)", [String(eventId), String(name), JSON.stringify(data), occurredAt, at]);
      } catch (error) {
        const rows = await query("SELECT * FROM habitat_ax_mcp_events WHERE event_id = ?", [String(eventId)]);
        if (!rows?.length) throw error;
        return { ok: true, created: false, event: parseEvent(rows[0]) };
      }
      const rows = await query("SELECT * FROM habitat_ax_mcp_events WHERE event_id = ?", [String(eventId)]);
      return { ok: true, created: true, event: parseEvent(rows[0]) };
    },

    async listEvents({ afterSeq = 0, name = null, limit = 200 } = {}) {
      const rows = name
        ? await query("SELECT * FROM habitat_ax_mcp_events WHERE seq > ? AND name = ? ORDER BY seq ASC LIMIT ?", [Number(afterSeq) || 0, String(name), Math.max(1, Math.min(500, Number(limit) || 200))])
        : await query("SELECT * FROM habitat_ax_mcp_events WHERE seq > ? ORDER BY seq ASC LIMIT ?", [Number(afterSeq) || 0, Math.max(1, Math.min(500, Number(limit) || 200))]);
      return (rows || []).map(parseEvent);
    },

    async eventBounds() {
      const rows = await query("SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq, COUNT(*) AS count FROM habitat_ax_mcp_events");
      return { minSeq: rows?.[0]?.minSeq === null || rows?.[0]?.minSeq === undefined ? null : Number(rows[0].minSeq), maxSeq: rows?.[0]?.maxSeq === null || rows?.[0]?.maxSeq === undefined ? null : Number(rows[0].maxSeq), count: Number(rows?.[0]?.count || 0) };
    },

    async enqueueDelivery({ subscriptionId, eventSeq, eventId, at = now() }) {
      const id = "dlv_" + String(subscriptionId).slice(-12) + "_" + eventSeq;
      try {
        await query("INSERT INTO habitat_ax_mcp_deliveries (id, subscription_id, event_seq, event_id, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)", [id, String(subscriptionId), Number(eventSeq), String(eventId), at, at, at]);
        return { ok: true, created: true, delivery: await this.getDelivery(id) };
      } catch (error) {
        const rows = await query("SELECT * FROM habitat_ax_mcp_deliveries WHERE subscription_id = ? AND event_id = ?", [String(subscriptionId), String(eventId)]);
        if (!rows?.length) throw error;
        return { ok: true, created: false, delivery: parseDelivery(rows[0]) };
      }
    },

    async getDelivery(id) {
      const rows = await query("SELECT * FROM habitat_ax_mcp_deliveries WHERE id = ?", [String(id)]);
      return parseDelivery(rows?.[0]);
    },

    async dueDeliveries({ at = now(), limit = 20 } = {}) {
      const rows = await query("SELECT d.* FROM habitat_ax_mcp_deliveries d LEFT JOIN habitat_ax_mcp_delivery_leases l ON l.delivery_id = d.id WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND (l.expires_at IS NULL OR l.expires_at <= ?) ORDER BY d.event_seq ASC LIMIT ?", [String(at), String(at), Math.max(1, Math.min(100, Number(limit) || 20))]);
      return (rows || []).map(parseDelivery);
    },

    /** At-most-one worker per delivery: the update only wins when no live lease exists. */
    async claimDelivery(id, { owner, leaseMs = 60_000, at = now() } = {}) {
      const expires = new Date(Date.parse(at) + Math.max(1000, Number(leaseMs) || 60_000)).toISOString();
      try {
        await query(
          "INSERT INTO habitat_ax_mcp_delivery_leases (delivery_id, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(delivery_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE habitat_ax_mcp_delivery_leases.expires_at <= ?",
          [String(id), String(owner || "worker"), expires, String(at)]
        );
      } catch {
        // A conflicting live lease leaves the row untouched; the owner comparison below decides.
      }
      const rows = await query("SELECT owner, expires_at FROM habitat_ax_mcp_delivery_leases WHERE delivery_id = ? AND expires_at > ?", [String(id), String(at)]);
      const claimed = rows?.[0]?.owner === String(owner || "worker");
      return { ok: true, claimed, delivery: await this.getDelivery(id) };
    },

    async markDelivered(id, { at = now() } = {}) {
      await query("UPDATE habitat_ax_mcp_deliveries SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, updated_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'", [at, at, String(id)]);
      await query("DELETE FROM habitat_ax_mcp_delivery_leases WHERE delivery_id = ?", [String(id)]);
      return this.getDelivery(id);
    },

    async markAttempt(id, { at = now(), nextAttemptAt, error = null } = {}) {
      await query("UPDATE habitat_ax_mcp_deliveries SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?, last_error = ? WHERE id = ? AND status = 'pending'", [nextAttemptAt || at, at, error ? String(error).slice(0, 300) : null, String(id)]);
      await query("DELETE FROM habitat_ax_mcp_delivery_leases WHERE delivery_id = ?", [String(id)]);
      return this.getDelivery(id);
    },

    async markDead(id, { at = now(), error = null } = {}) {
      await query("UPDATE habitat_ax_mcp_deliveries SET status = 'dead', attempts = attempts + 1, updated_at = ?, last_error = ? WHERE id = ? AND status = 'pending'", [at, error ? String(error).slice(0, 300) : null, String(id)]);
      await query("DELETE FROM habitat_ax_mcp_delivery_leases WHERE delivery_id = ?", [String(id)]);
      return this.getDelivery(id);
    },

    async updateCursor(subscriptionId, seq) {
      await query("UPDATE habitat_ax_mcp_subscriptions SET last_cursor = CASE WHEN last_cursor IS NULL OR last_cursor < ? THEN ? ELSE last_cursor END WHERE id = ?", [Number(seq) || 0, Number(seq) || 0, String(subscriptionId)]);
      return { ok: true };
    },

    async lastDeliveredSeq(subscriptionId) {
      const rows = await query("SELECT MAX(event_seq) AS seq FROM habitat_ax_mcp_deliveries WHERE subscription_id = ? AND status = 'delivered'", [String(subscriptionId)]);
      const value = rows?.[0]?.seq;
      return value === null || value === undefined ? null : Number(value);
    },

    async listDeliveries({ subscriptionId = null, limit = 100 } = {}) {
      const rows = subscriptionId
        ? await query("SELECT * FROM habitat_ax_mcp_deliveries WHERE subscription_id = ? ORDER BY event_seq ASC LIMIT ?", [String(subscriptionId), Math.max(1, Math.min(500, Number(limit) || 100))])
        : await query("SELECT * FROM habitat_ax_mcp_deliveries ORDER BY event_seq ASC LIMIT ?", [Math.max(1, Math.min(500, Number(limit) || 100))]);
      return (rows || []).map(parseDelivery);
    }
  });
}

export function createD1McpRepository({ accountId, databaseId, apiToken, fetchImpl, secretBox = null } = {}) {
  return createMcpRepository({
    query: createD1RowQuery({ accountId, databaseId, apiToken, fetchImpl }),
    secretBox
  });
}
