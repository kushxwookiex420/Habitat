import { createD1Query } from "./nexus-runtime.mjs";

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
  "habitat_ax_mcp_deliveries"
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
  "CREATE INDEX IF NOT EXISTS habitat_ax_mcp_deliveries_due ON habitat_ax_mcp_deliveries(status, next_attempt_at)"
]);

function parseSubscription(row) {
  if (!row) return null;
  let args = {};
  try { args = JSON.parse(row.args_json || "{}"); } catch { args = {}; }
  return {
    id: row.id,
    principal: row.principal,
    name: row.name,
    arguments: args,
    argsCanonical: row.args_canonical,
    url: row.url,
    secret: row.secret,
    previousSecret: row.previous_secret || null,
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
    lastError: row.last_error || null
  };
}

export function createMcpRepository({ query, now = () => new Date().toISOString() } = {}) {
  if (typeof query !== "function") throw new Error("The MCP repository needs a query function.");
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
      const rows = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)", MCP_TABLES);
      const present = new Set((rows || []).map(row => row.name));
      return { ok: MCP_TABLES.every(name => present.has(name)), missing: MCP_TABLES.filter(name => !present.has(name)) };
    },

    async saveSubscription(subscription) {
      const at = now();
      await query(
        "INSERT INTO habitat_ax_mcp_subscriptions (id, principal, name, args_json, args_canonical, url, secret, previous_secret, secret_grace_until, created_at, updated_at, refresh_before, revoked_at, last_cursor, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, previous_secret = excluded.previous_secret, secret_grace_until = excluded.secret_grace_until, updated_at = excluded.updated_at, refresh_before = excluded.refresh_before, revoked_at = NULL, last_cursor = excluded.last_cursor, verified_at = excluded.verified_at",
        [
          subscription.id, subscription.principal, subscription.name, JSON.stringify(subscription.arguments || {}),
          subscription.argsCanonical, subscription.url, subscription.secret, subscription.previousSecret || null,
          subscription.secretGraceUntil || null, subscription.createdAt || at, at, subscription.refreshBefore || null,
          subscription.lastCursor ?? null, subscription.verifiedAt || at
        ]
      );
      return this.getSubscription(subscription.id);
    },

    async getSubscription(id) {
      const rows = await query("SELECT * FROM habitat_ax_mcp_subscriptions WHERE id = ?", [String(id)]);
      return parseSubscription(rows?.[0]);
    },

    async findSubscription({ principal, name, argsCanonical, url }) {
      const rows = await query("SELECT * FROM habitat_ax_mcp_subscriptions WHERE principal = ? AND name = ? AND args_canonical = ? AND url = ?", [String(principal), String(name), String(argsCanonical), String(url)]);
      return parseSubscription(rows?.[0]);
    },

    async listSubscriptions({ activeOnly = false, limit = 100 } = {}) {
      const rows = activeOnly
        ? await query("SELECT * FROM habitat_ax_mcp_subscriptions WHERE revoked_at IS NULL ORDER BY created_at ASC LIMIT ?", [Math.max(1, Math.min(500, Number(limit) || 100))])
        : await query("SELECT * FROM habitat_ax_mcp_subscriptions ORDER BY created_at ASC LIMIT ?", [Math.max(1, Math.min(500, Number(limit) || 100))]);
      return (rows || []).map(parseSubscription);
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
      const rows = await query("SELECT * FROM habitat_ax_mcp_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY event_seq ASC LIMIT ?", [String(at), Math.max(1, Math.min(100, Number(limit) || 20))]);
      return (rows || []).map(parseDelivery);
    },

    async markDelivered(id, { at = now() } = {}) {
      await query("UPDATE habitat_ax_mcp_deliveries SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, updated_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'", [at, at, String(id)]);
      return this.getDelivery(id);
    },

    async markAttempt(id, { at = now(), nextAttemptAt, error = null } = {}) {
      await query("UPDATE habitat_ax_mcp_deliveries SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?, last_error = ? WHERE id = ? AND status = 'pending'", [nextAttemptAt || at, at, error ? String(error).slice(0, 300) : null, String(id)]);
      return this.getDelivery(id);
    },

    async markDead(id, { at = now(), error = null } = {}) {
      await query("UPDATE habitat_ax_mcp_deliveries SET status = 'dead', attempts = attempts + 1, updated_at = ?, last_error = ? WHERE id = ? AND status = 'pending'", [at, error ? String(error).slice(0, 300) : null, String(id)]);
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

export function createD1McpRepository({ accountId, databaseId, apiToken, fetchImpl } = {}) {
  return createMcpRepository({ query: createD1Query({ accountId, databaseId, apiToken, fetchImpl }) });
}
