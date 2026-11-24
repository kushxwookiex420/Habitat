import { createD1RowQuery } from "./nexus-runtime.mjs";

/**
 * Connection-monitor storage: heartbeat state, a durable event queue and delivery history.
 *
 * The queue is append-only in practice: events are inserted once by dedupe key, then move through
 * pending → delivered → acknowledged, or pending → dead after bounded attempts. Nothing is deleted, so
 * an accepted event cannot silently vanish.
 */

export const HEARTBEAT_TABLES = Object.freeze([
  "habitat_ax_heartbeat_state",
  "habitat_ax_heartbeat_events",
  "habitat_ax_heartbeat_deliveries"
]);

export const HEARTBEAT_MIGRATION = "0013_ax_heartbeat";

export const HEARTBEAT_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS habitat_ax_heartbeat_state (integration TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, last_beat_at TEXT, last_seen_at TEXT, last_delivery_at TEXT, last_ack_at TEXT, missed_beats INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, detail_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_heartbeat_events (id TEXT PRIMARY KEY NOT NULL, integration TEXT NOT NULL, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL, priority INTEGER NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT, acknowledged_at TEXT, last_error TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_heartbeat_events_dedupe ON habitat_ax_heartbeat_events(dedupe_key)",
  "CREATE INDEX IF NOT EXISTS habitat_ax_heartbeat_events_pending ON habitat_ax_heartbeat_events(status, priority, created_at)",
  "CREATE TABLE IF NOT EXISTS habitat_ax_heartbeat_deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, channel TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, detail_json TEXT NOT NULL)"
]);

function parseState(row) {
  if (!row) return null;
  let detail = {};
  try { detail = JSON.parse(row.detail_json || "{}"); } catch { detail = {}; }
  return {
    integration: row.integration,
    status: row.status,
    lastBeatAt: row.last_beat_at || null,
    lastSeenAt: row.last_seen_at || null,
    lastDeliveryAt: row.last_delivery_at || null,
    lastAckAt: row.last_ack_at || null,
    missedBeats: Number(row.missed_beats) || 0,
    failures: Number(row.failures) || 0,
    detail
  };
}

function parseEvent(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || "{}"); } catch { payload = {}; }
  return {
    id: row.id,
    integration: row.integration,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    priority: Number(row.priority) || 5,
    payload,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at || null,
    acknowledgedAt: row.acknowledged_at || null,
    lastError: row.last_error || null
  };
}

export function createHeartbeatRepository({ query, now = () => new Date().toISOString() } = {}) {
  if (typeof query !== "function") throw new Error("The heartbeat repository needs a query function.");
  let initializing = null;

  return Object.freeze({
    durable: true,
    adapter: "sql",

    initialize() {
      if (!initializing) {
        initializing = (async () => {
          for (const statement of HEARTBEAT_DDL) await query(statement);
          return { ok: true, statements: HEARTBEAT_DDL.length };
        })().catch(error => { initializing = null; throw error; });
      }
      return initializing;
    },

    async verifySchema() {
      const rows = await query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
        HEARTBEAT_TABLES
      );
      const present = new Set((rows || []).map(row => row.name));
      return { ok: HEARTBEAT_TABLES.every(name => present.has(name)), missing: HEARTBEAT_TABLES.filter(name => !present.has(name)) };
    },

    async getState(integration) {
      const rows = await query("SELECT * FROM habitat_ax_heartbeat_state WHERE integration = ?", [String(integration)]);
      return parseState(rows?.[0]);
    },

    async saveState(state) {
      await query(
        "INSERT INTO habitat_ax_heartbeat_state (integration, status, last_beat_at, last_seen_at, last_delivery_at, last_ack_at, missed_beats, failures, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(integration) DO UPDATE SET status = excluded.status, last_beat_at = excluded.last_beat_at, last_seen_at = excluded.last_seen_at, last_delivery_at = excluded.last_delivery_at, last_ack_at = excluded.last_ack_at, missed_beats = excluded.missed_beats, failures = excluded.failures, detail_json = excluded.detail_json",
        [
          String(state.integration),
          String(state.status || "unknown"),
          state.lastBeatAt || null,
          state.lastSeenAt || null,
          state.lastDeliveryAt || null,
          state.lastAckAt || null,
          Number(state.missedBeats) || 0,
          Number(state.failures) || 0,
          JSON.stringify(state.detail || {})
        ]
      );
      return this.getState(state.integration);
    },

    async enqueueEvent({ id, integration = "chatgpt", kind, dedupeKey, payload = {}, priority = 5 } = {}) {
      const at = now();
      try {
        await query(
          "INSERT INTO habitat_ax_heartbeat_events (id, integration, kind, dedupe_key, priority, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
          [id, integration, kind, dedupeKey, Number(priority) || 5, JSON.stringify(payload), at, at]
        );
        const rows = await query("SELECT * FROM habitat_ax_heartbeat_events WHERE id = ?", [id]);
        return { ok: true, created: true, event: parseEvent(rows?.[0]) };
      } catch (error) {
        // Duplicate dedupe key: this event was already queued by an earlier beat.
        const rows = await query("SELECT * FROM habitat_ax_heartbeat_events WHERE dedupe_key = ?", [dedupeKey]);
        if (!rows?.length) throw error;
        return { ok: true, created: false, event: parseEvent(rows[0]) };
      }
    },

    async pendingEvents({ integration = "chatgpt", limit = 20 } = {}) {
      const rows = await query(
        "SELECT * FROM habitat_ax_heartbeat_events WHERE integration = ? AND status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT ?",
        [String(integration), Math.max(1, Math.min(50, Number(limit) || 20))]
      );
      return (rows || []).map(parseEvent);
    },

    async listEvents({ integration = "chatgpt", limit = 50, status = null } = {}) {
      const rows = status
        ? await query("SELECT * FROM habitat_ax_heartbeat_events WHERE integration = ? AND status = ? ORDER BY created_at DESC LIMIT ?", [String(integration), String(status), Math.max(1, Math.min(200, Number(limit) || 50))])
        : await query("SELECT * FROM habitat_ax_heartbeat_events WHERE integration = ? ORDER BY created_at DESC LIMIT ?", [String(integration), Math.max(1, Math.min(200, Number(limit) || 50))]);
      return (rows || []).map(parseEvent);
    },

    async event(id) {
      const rows = await query("SELECT * FROM habitat_ax_heartbeat_events WHERE id = ?", [String(id)]);
      return parseEvent(rows?.[0]);
    },

    async markAttempt(id, { error = null, at = now() } = {}) {
      await query("UPDATE habitat_ax_heartbeat_events SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'", [error ? String(error).slice(0, 300) : null, at, String(id)]);
      return this.event(id);
    },

    async markDelivered(id, { at = now() } = {}) {
      await query("UPDATE habitat_ax_heartbeat_events SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, updated_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'", [at, at, String(id)]);
      return this.event(id);
    },

    async markDead(id, { at = now(), error = null } = {}) {
      await query("UPDATE habitat_ax_heartbeat_events SET status = 'dead', attempts = attempts + 1, updated_at = ?, last_error = ? WHERE id = ? AND status = 'pending'", [at, error ? String(error).slice(0, 300) : null, String(id)]);
      return this.event(id);
    },

    async markAcknowledged(ids, { at = now() } = {}) {
      let changed = 0;
      for (const id of ids) {
        const result = await query(
          "UPDATE habitat_ax_heartbeat_events SET status = 'acknowledged', acknowledged_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'delivered')",
          [at, at, String(id)]
        );
        changed += Number(result?.[0]?.changes || 0);
      }
      return { ok: true, acknowledged: changed, requested: ids.length };
    },

    async recordDelivery({ eventId = null, channel, status, detail = {} } = {}) {
      await query(
        "INSERT INTO habitat_ax_heartbeat_deliveries (event_id, channel, status, at, detail_json) VALUES (?, ?, ?, ?, ?)",
        [eventId, String(channel || "webhook"), String(status), now(), JSON.stringify(detail)]
      );
    },

    async listDeliveries({ limit = 50 } = {}) {
      const rows = await query("SELECT * FROM habitat_ax_heartbeat_deliveries ORDER BY seq DESC LIMIT ?", [Math.max(1, Math.min(200, Number(limit) || 50))]);
      return (rows || []).map(row => ({
        id: row.seq, eventId: row.event_id, channel: row.channel, status: row.status, at: row.at, detail: JSON.parse(row.detail_json || "{}")
      }));
    },

    async counts({ integration = "chatgpt" } = {}) {
      const rows = await query("SELECT status, COUNT(*) AS count FROM habitat_ax_heartbeat_events WHERE integration = ? GROUP BY status", [String(integration)]);
      return Object.fromEntries((rows || []).map(row => [row.status, Number(row.count) || 0]));
    }
  });
}

export function createD1HeartbeatRepository({ accountId, databaseId, apiToken, fetchImpl } = {}) {
  return createHeartbeatRepository({
    query: createD1RowQuery({ accountId, databaseId, apiToken, fetchImpl })
  });
}
