import { createD1Query } from "./nexus-runtime.mjs";
import { eventHash, verifyEventChain } from "./ax-security-events.mjs";

/**
 * Append-only storage for security events.
 *
 * The interface has `append`, `list`, `chain`, `head` and `stats` — and no update or delete. Sequence
 * numbers are assigned inside the store, not by the caller, so concurrent appends cannot fork the
 * chain. The D1 implementation relies on a UNIQUE(seq) constraint: a racing insert loses and retries
 * from the new head instead of overwriting an event.
 */

export function createMemorySecurityEventRepository({ records = [] } = {}) {
  const rows = [];
  let tail = Promise.resolve();

  for (const record of records) {
    const last = rows[rows.length - 1] || null;
    const seq = Number(record.seq) || rows.length + 1;
    const prevHash = record.prevHash ?? (last ? last.hash : null);
    const normalized = { ...record, seq, prevHash, hash: record.hash || eventHash(prevHash, { ...record, seq }) };
    rows.push(normalized);
  }

  async function appendLocked(event) {
    const previous = rows[rows.length - 1] || null;
    const seq = previous ? previous.seq + 1 : 1;
    const prevHash = previous ? previous.hash : null;
    const record = { ...event, seq, prevHash };
    record.hash = eventHash(prevHash, record);
    rows.push(record);
    return record;
  }

  function sortNewest(items) {
    return items.slice().sort((a, b) => b.seq - a.seq);
  }

  return Object.freeze({
    adapter: "memory",
    durable: false,
    table: "habitat_ax_security_events",
    async initialize() {
      return { ok: true };
    },
    append(event) {
      const run = tail.then(() => appendLocked(event));
      tail = run.catch(() => {});
      return run;
    },
    async list({ category = null, severity = null, beforeSeq = null, limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      return sortNewest(rows
        .filter(row => (category ? row.category === category : true))
        .filter(row => (severity ? row.severity === severity : true))
        .filter(row => (beforeSeq === null || beforeSeq === undefined ? true : row.seq < Number(beforeSeq))))
        .slice(0, safeLimit);
    },
    async chain({ limit = 500 } = {}) {
      const safeLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)));
      return rows.slice(-safeLimit);
    },
    async head() {
      return rows[rows.length - 1] || null;
    },
    async stats() {
      return { total: rows.length, headSeq: rows.length ? rows[rows.length - 1].seq : 0 };
    },
    verify() {
      return verifyEventChain(rows);
    },
    _rows: rows
  });
}

export function createD1AxSecurityEventRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  let initializing = null;

  function decode(recordJson) {
    if (typeof recordJson !== "string") return null;
    try {
      const value = JSON.parse(recordJson);
      return value && typeof value.id === "string" ? value : null;
    } catch {
      return null;
    }
  }

  async function readHead() {
    const result = await query("SELECT record_json FROM habitat_ax_security_events ORDER BY seq DESC LIMIT 1");
    return decode(result[0]?.results?.[0]?.record_json);
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_ax_security_events",
    initialize() {
      if (!initializing) {
        initializing = (async () => {
          await query("CREATE TABLE IF NOT EXISTS habitat_ax_security_events (id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, outcome TEXT NOT NULL, actor TEXT, device_id TEXT, objective_id TEXT, run_id TEXT, task_id TEXT, correlation_id TEXT, record_json TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL, created_at TEXT NOT NULL)");
          await query("CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_security_events_seq ON habitat_ax_security_events(seq)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_security_events_created_at ON habitat_ax_security_events(created_at DESC)");
          await query("CREATE INDEX IF NOT EXISTS habitat_ax_security_events_category ON habitat_ax_security_events(category, seq DESC)");
          return { ok: true };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },
    async append(event) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const head = await readHead();
        const seq = head ? head.seq + 1 : 1;
        const prevHash = head ? head.hash : null;
        const record = { ...event, seq, prevHash };
        record.hash = eventHash(prevHash, record);
        try {
          await query(
            "INSERT INTO habitat_ax_security_events (id, seq, category, severity, outcome, actor, device_id, objective_id, run_id, task_id, correlation_id, record_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [record.id, record.seq, record.category, record.severity, record.outcome, record.actor, record.deviceId, record.objectiveId, record.runId, record.taskId, record.correlationId, JSON.stringify(record), record.prevHash, record.hash, record.createdAt]
          );
          return record;
        } catch (error) {
          // A concurrent append won the sequence. Re-read the head and rebuild the link.
          if (attempt === 3) throw error;
        }
      }
      throw new Error("security_sequence_contention");
    },
    async list({ category = null, severity = null, beforeSeq = null, limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      const clauses = [];
      const params = [];
      if (category) { clauses.push("category = ?"); params.push(String(category)); }
      if (severity) { clauses.push("severity = ?"); params.push(String(severity)); }
      if (beforeSeq !== null && beforeSeq !== undefined) { clauses.push("seq < ?"); params.push(Number(beforeSeq)); }
      params.push(safeLimit);
      const result = await query(
        "SELECT record_json FROM habitat_ax_security_events" + (clauses.length ? " WHERE " + clauses.join(" AND ") : "") + " ORDER BY seq DESC LIMIT ?",
        params
      );
      return (result[0]?.results || []).map(row => decode(row.record_json)).filter(Boolean);
    },
    async chain({ limit = 500 } = {}) {
      const safeLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)));
      const result = await query(
        "SELECT record_json FROM habitat_ax_security_events ORDER BY seq DESC LIMIT ?",
        [safeLimit]
      );
      return (result[0]?.results || []).map(row => decode(row.record_json)).filter(Boolean).reverse();
    },
    async head() {
      return readHead();
    },
    async stats() {
      const result = await query("SELECT COUNT(*) AS total, MAX(seq) AS head FROM habitat_ax_security_events");
      return { total: Number(result[0]?.results?.[0]?.total || 0), headSeq: Number(result[0]?.results?.[0]?.head || 0) };
    }
  });
}
