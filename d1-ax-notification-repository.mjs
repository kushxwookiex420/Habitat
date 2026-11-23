import { d1DatabaseEndpoint } from "./d1-command-task-repository.mjs";

/**
 * Durable notification storage on D1.
 *
 * One additive table, created with `IF NOT EXISTS`, never dropped or altered. The unique index on
 * `dedupe_key` is the idempotency boundary: two concurrent records of the same event cannot both
 * insert, and the loser reads the winner back instead of forking history.
 *
 * The row is an event record. `status` says what actually happened to it:
 *   recorded      written to the inbox (the only channel this deployment implements)
 *   pending       an external delivery is owed but not confirmed
 *   delivered     an external transport confirmed delivery
 *   failed        external delivery exhausted its bounded attempts
 *   acknowledged  the owner has read it
 */

export const NOTIFICATION_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS habitat_ax_notifications (" +
  "id TEXT PRIMARY KEY, project TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, " +
  "title TEXT NOT NULL, body TEXT NOT NULL, run_id TEXT, task_id TEXT, dedupe_key TEXT NOT NULL, " +
  "channel TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, " +
  "last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT, ack_at TEXT)";

export const NOTIFICATION_UNIQUE_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_notifications_dedupe ON habitat_ax_notifications(dedupe_key)";

export const NOTIFICATION_SCHEMA = Object.freeze([NOTIFICATION_TABLE_SQL, NOTIFICATION_UNIQUE_INDEX_SQL]);

function parseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    runId: row.run_id || null,
    taskId: row.task_id || null,
    dedupeKey: row.dedupe_key,
    channel: row.channel,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at || null,
    acknowledgedAt: row.ack_at || null
  };
}

export function createD1AxNotificationRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const endpoint = d1DatabaseEndpoint({ accountId, databaseId });

  async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiToken },
      body: JSON.stringify({ sql, params })
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Ax notifications: D1 returned a non-JSON response.");
    }
    if (!response.ok || payload?.success === false) {
      const message = payload?.errors?.[0]?.message || "D1 query failed with status " + response.status;
      throw new Error("Ax notifications: " + message);
    }
    return payload?.result?.[0]?.results || [];
  }

  async function readRow(id) {
    const rows = await query("SELECT * FROM habitat_ax_notifications WHERE id = ?", [id]);
    return parseRow(rows[0]);
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_ax_notifications",

    async initialize() {
      for (const statement of NOTIFICATION_SCHEMA) await query(statement);
      return { ok: true, statements: NOTIFICATION_SCHEMA.length };
    },

    /** Insert-if-absent by primary key and dedupe key. Always returns the stored row. */
    async create(notification) {
      if (!notification?.id || !notification?.dedupeKey) throw new Error("A notification needs an id and a dedupe key.");
      // RETURNING tells us whether this call inserted or whether the dedupe key already existed; a
      // follow-up read alone cannot distinguish the two when the id is deterministic.
      const inserted = await query(
        "INSERT INTO habitat_ax_notifications " +
          "(id, project, type, severity, title, body, run_id, task_id, dedupe_key, channel, status, attempts, " +
          "last_error, created_at, updated_at, delivered_at, ack_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(dedupe_key) DO NOTHING RETURNING id",
        [
          notification.id,
          notification.project || "habitat",
          notification.type,
          notification.severity,
          notification.title,
          notification.body,
          notification.runId || null,
          notification.taskId || null,
          notification.dedupeKey,
          notification.channel,
          notification.status,
          Number(notification.attempts || 0),
          notification.lastError || null,
          notification.createdAt,
          notification.updatedAt,
          notification.deliveredAt || null,
          notification.acknowledgedAt || null
        ]
      );
      const stored = await readRow(notification.id);
      const byDedupe = stored ? null : (await query("SELECT * FROM habitat_ax_notifications WHERE dedupe_key = ?", [notification.dedupeKey]))[0];
      const row = stored || parseRow(byDedupe);
      return { created: inserted.length > 0, notification: row || notification };
    },

    async get(id) {
      return readRow(String(id));
    },

    async list({ project = null, status = null, channel = null, limit = 50 } = {}) {
      const params = [];
      const clauses = [];
      if (project) {
        clauses.push("project = ?");
        params.push(String(project).toLowerCase());
      }
      if (status) {
        clauses.push("status = ?");
        params.push(String(status));
      }
      if (channel) {
        clauses.push("channel = ?");
        params.push(String(channel));
      }
      const max = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      const sql =
        "SELECT * FROM habitat_ax_notifications" +
        (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
        " ORDER BY created_at DESC LIMIT " + max;
      return (await query(sql, params)).map(parseRow).filter(Boolean);
    },

    async markDelivered({ id, attempts, at }) {
      await query(
        "UPDATE habitat_ax_notifications SET status = 'delivered', attempts = ?, delivered_at = ?, updated_at = ?, last_error = NULL WHERE id = ?",
        [Number(attempts || 0), at, at, String(id)]
      );
      return { ok: true, notification: await readRow(String(id)) };
    },

    async markFailed({ id, attempts, error, exhausted, at }) {
      await query(
        "UPDATE habitat_ax_notifications SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
        [exhausted ? "failed" : "pending", Number(attempts || 0), error || null, at, String(id)]
      );
      return { ok: true, notification: await readRow(String(id)) };
    },

    async acknowledge({ id, by, now }) {
      const existing = await readRow(String(id));
      if (!existing) return { ok: false, code: "notification_not_found" };
      await query(
        "UPDATE habitat_ax_notifications SET status = 'acknowledged', ack_at = ?, updated_at = ? WHERE id = ?",
        [now, now, String(id)]
      );
      return { ok: true, notification: await readRow(String(id)), by };
    },

    async stats({ project } = {}) {
      const rows = await query(
        "SELECT status, COUNT(*) AS total FROM habitat_ax_notifications WHERE project = ? GROUP BY status",
        [String(project || "").toLowerCase()]
      );
      const byStatus = Object.fromEntries(rows.map(row => [row.status, Number(row.total)]));
      return { project: String(project || "").toLowerCase(), byStatus, total: Object.values(byStatus).reduce((sum, n) => sum + n, 0) };
    }
  });
}
