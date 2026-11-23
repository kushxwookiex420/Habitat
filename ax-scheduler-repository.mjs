import { DatabaseSync } from "node:sqlite";
import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Durable scheduler tick state.
 *
 * One row (`primary`) holds the last start, last success, last status and the current lease. The
 * lease is the overlap guard: an invocation that cannot take an unexpired lease returns
 * `tick_overlap` and does no work. The D1 implementation uses a revision CAS so two triggers cannot
 * both believe they won.
 */

function emptyState() {
  return {
    lease: null,
    lastStartAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    lastDetail: null,
    lastTickId: null,
    tickCount: 0,
    failures: 0
  };
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

export function createMemorySchedulerRepository({ state = null } = {}) {
  let current = { ...emptyState(), ...(state || {}) };

  return Object.freeze({
    adapter: "memory",
    durable: false,
    table: "habitat_ax_scheduler",
    async initialize() {
      return { ok: true };
    },
    async acquire({ tickId, owner, ttlMs, nowMs }) {
      const now = Number(nowMs);
      if (current.lease && Date.parse(current.lease.expiresAt) > now) {
        return { ok: false, code: "tick_overlap", lease: clone(current.lease) };
      }
      const startedAt = new Date(now).toISOString();
      current.lease = {
        tickId,
        owner: String(owner || "manual").slice(0, 80),
        startedAt,
        expiresAt: new Date(now + Math.max(1_000, Number(ttlMs) || 60_000)).toISOString()
      };
      current.lastStartAt = startedAt;
      current.lastTickId = tickId;
      current.tickCount += 1;
      return { ok: true, lease: clone(current.lease), tickCount: current.tickCount };
    },
    async heartbeat({ tickId, ttlMs, nowMs, progress = null }) {
      if (!current.lease || current.lease.tickId !== tickId) return { ok: false, code: "lease_lost" };
      current.lease.expiresAt = new Date(Number(nowMs) + Math.max(1_000, Number(ttlMs) || 60_000)).toISOString();
      current.lease.progress = progress ? String(progress).slice(0, 200) : current.lease.progress || null;
      return { ok: true, lease: clone(current.lease) };
    },
    async complete({ tickId, status, detail, nowIso }) {
      if (!current.lease || current.lease.tickId !== tickId) return { ok: false, code: "lease_lost" };
      current.lease = null;
      current.lastStatus = String(status || "ok").slice(0, 40);
      current.lastDetail = detail ? String(detail).slice(0, 500) : null;
      if (current.lastStatus !== "failed") current.lastSuccessAt = nowIso;
      else current.failures += 1;
      return { ok: true };
    },
    async fail({ tickId, error, nowIso }) {
      if (current.lease && current.lease.tickId === tickId) current.lease = null;
      current.lastStatus = "failed";
      current.lastDetail = String(error || "tick failed").slice(0, 500);
      current.failures += 1;
      return { ok: true };
    },
    async status() {
      return clone(current);
    },
    snapshot() {
      return clone(current);
    }
  });
}

/**
 * Durable scheduler state in a local SQLite file.
 *
 * This exists for the multi-process adversarial harness: separate Node processes really contend for
 * one row. It is not mounted as a production store; Cloudflare D1 remains the production adapter.
 * `BEGIN IMMEDIATE` plus the revision CAS makes acquire/heartbeat/complete serializable across
 * processes, and a stale lease holder loses its write after a takeover.
 */
export function createSqliteSchedulerRepository({ filename = null } = {}) {
  if (!filename) throw new Error("The SQLite scheduler harness needs a filename.");
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout = 5000");
  // WAL setup itself takes a lock, so tolerate another process doing it first.
  try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* another process is initializing */ }
  let initialized = false;

  function initializeSync() {
    if (initialized) return;
    db.exec("CREATE TABLE IF NOT EXISTS habitat_ax_scheduler (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO habitat_ax_scheduler (id, record_json, revision, lease_expires_at, updated_at) VALUES ('primary', ?, 0, NULL, ?) ON CONFLICT(id) DO NOTHING")
      .run(JSON.stringify(emptyState()), new Date().toISOString());
    initialized = true;
  }

  function readSync() {
    initializeSync();
    const row = db.prepare("SELECT record_json, revision FROM habitat_ax_scheduler WHERE id = 'primary' LIMIT 1").get();
    return row ? { state: JSON.parse(row.record_json), revision: Number(row.revision) } : null;
  }

  function transact(fn) {
    initializeSync();
    db.exec("BEGIN IMMEDIATE");
    try {
      const outcome = fn();
      db.exec("COMMIT");
      return outcome;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  function writeSync(state, revision, leaseExpiresAt, updatedAt) {
    const result = db.prepare("UPDATE habitat_ax_scheduler SET record_json = ?, revision = revision + 1, lease_expires_at = ?, updated_at = ? WHERE id = 'primary' AND revision = ? RETURNING revision")
      .all(JSON.stringify(state), leaseExpiresAt, updatedAt, revision);
    return result.length === 1;
  }

  return Object.freeze({
    adapter: "sqlite-harness",
    durable: true,
    table: "habitat_ax_scheduler",
    async initialize() { initializeSync(); return { ok: true }; },
    async acquire({ tickId, owner, ttlMs, nowMs }) {
      return transact(() => {
        const row = readSync();
        if (!row) throw new Error("scheduler_state_missing");
        const now = Number(nowMs);
        if (row.state.lease && Date.parse(row.state.lease.expiresAt) > now) {
          return { ok: false, code: "tick_overlap", lease: clone(row.state.lease) };
        }
        const state = { ...emptyState(), ...row.state };
        const startedAt = new Date(now).toISOString();
        state.lease = {
          tickId,
          owner: String(owner || "manual").slice(0, 80),
          startedAt,
          expiresAt: new Date(now + Math.max(1_000, Number(ttlMs) || 60_000)).toISOString()
        };
        state.lastStartAt = startedAt;
        state.lastTickId = tickId;
        state.tickCount = Number(state.tickCount || 0) + 1;
        const written = writeSync(state, row.revision, state.lease.expiresAt, startedAt);
        return written ? { ok: true, lease: clone(state.lease), tickCount: state.tickCount } : { ok: false, code: "tick_overlap", lease: null };
      });
    },
    async heartbeat({ tickId, ttlMs, nowMs, progress = null }) {
      return transact(() => {
        const row = readSync();
        if (!row || !row.state.lease || row.state.lease.tickId !== tickId) return { ok: false, code: "lease_lost" };
        const state = row.state;
        state.lease.expiresAt = new Date(Number(nowMs) + Math.max(1_000, Number(ttlMs) || 60_000)).toISOString();
        if (progress) state.lease.progress = String(progress).slice(0, 200);
        return writeSync(state, row.revision, state.lease.expiresAt, new Date().toISOString())
          ? { ok: true, lease: clone(state.lease) }
          : { ok: false, code: "lease_lost" };
      });
    },
    async complete({ tickId, status, detail, nowIso }) {
      return transact(() => {
        const row = readSync();
        if (!row || !row.state.lease || row.state.lease.tickId !== tickId) return { ok: false, code: "lease_lost" };
        const state = row.state;
        state.lease = null;
        state.lastStatus = String(status || "ok").slice(0, 40);
        state.lastDetail = detail ? String(detail).slice(0, 500) : null;
        if (state.lastStatus !== "failed") state.lastSuccessAt = nowIso;
        else state.failures = Number(state.failures || 0) + 1;
        return writeSync(state, row.revision, null, nowIso) ? { ok: true } : { ok: false, code: "lease_lost" };
      });
    },
    async fail({ tickId, error, nowIso }) {
      return transact(() => {
        const row = readSync();
        if (!row) return { ok: false };
        const state = { ...emptyState(), ...row.state };
        if (state.lease && state.lease.tickId === tickId) state.lease = null;
        state.lastStatus = "failed";
        state.lastDetail = String(error || "tick failed").slice(0, 500);
        state.failures = Number(state.failures || 0) + 1;
        writeSync(state, row.revision, null, nowIso);
        return { ok: true };
      });
    },
    async status() {
      return clone(readSync()?.state || emptyState());
    },
    close() { try { db.close(); } catch { /* already closed */ } }
  });
}

export function createD1SchedulerRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  let initializing = null;

  function decode(recordJson) {
    if (typeof recordJson !== "string") return null;
    try {
      return JSON.parse(recordJson);
    } catch {
      return null;
    }
  }

  async function readRow() {
    const result = await query("SELECT record_json, revision FROM habitat_ax_scheduler WHERE id = 'primary' LIMIT 1");
    const row = result[0]?.results?.[0] || null;
    return row ? { state: decode(row.record_json) || emptyState(), revision: Number(row.revision || 0) } : null;
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: "habitat_ax_scheduler",
    initialize() {
      if (!initializing) {
        initializing = (async () => {
          await query("CREATE TABLE IF NOT EXISTS habitat_ax_scheduler (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, updated_at TEXT NOT NULL)");
          await query("INSERT INTO habitat_ax_scheduler (id, record_json, revision, lease_expires_at, updated_at) VALUES ('primary', ?, 0, NULL, ?) ON CONFLICT(id) DO NOTHING", [JSON.stringify(emptyState()), new Date().toISOString()]);
          return { ok: true };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    },
    async acquire({ tickId, owner, ttlMs, nowMs }) {
      await this.initialize();
      const now = Number(nowMs);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const row = await readRow();
        if (!row) throw new Error("scheduler_state_missing");
        if (row.state.lease && Date.parse(row.state.lease.expiresAt) > now) {
          return { ok: false, code: "tick_overlap", lease: clone(row.state.lease) };
        }
        const state = { ...emptyState(), ...row.state };
        const startedAt = new Date(now).toISOString();
        state.lease = {
          tickId,
          owner: String(owner || "manual").slice(0, 80),
          startedAt,
          expiresAt: new Date(now + Math.max(1_000, Number(ttlMs) || 60_000)).toISOString()
        };
        state.lastStartAt = startedAt;
        state.lastTickId = tickId;
        state.tickCount = Number(state.tickCount || 0) + 1;
        const result = await query(
          "UPDATE habitat_ax_scheduler SET record_json = ?, revision = revision + 1, lease_expires_at = ?, updated_at = ? WHERE id = 'primary' AND revision = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?) RETURNING revision",
          [JSON.stringify(state), state.lease.expiresAt, startedAt, row.revision, startedAt]
        );
        if ((result[0]?.results || []).length === 1) return { ok: true, lease: clone(state.lease), tickCount: state.tickCount };
      }
      return { ok: false, code: "tick_overlap", lease: null };
    },
    async heartbeat({ tickId, ttlMs, nowMs, progress = null }) {
      await this.initialize();
      const row = await readRow();
      if (!row || !row.state.lease || row.state.lease.tickId !== tickId) return { ok: false, code: "lease_lost" };
      const state = row.state;
      state.lease.expiresAt = new Date(Number(nowMs) + Math.max(1_000, Number(ttlMs) || 60_000)).toISOString();
      if (progress) state.lease.progress = String(progress).slice(0, 200);
      const result = await query(
        "UPDATE habitat_ax_scheduler SET record_json = ?, revision = revision + 1, lease_expires_at = ?, updated_at = ? WHERE id = 'primary' AND revision = ? RETURNING revision",
        [JSON.stringify(state), state.lease.expiresAt, new Date().toISOString(), row.revision]
      );
      return (result[0]?.results || []).length === 1 ? { ok: true, lease: clone(state.lease) } : { ok: false, code: "lease_lost" };
    },
    async complete({ tickId, status, detail, nowIso }) {
      await this.initialize();
      const row = await readRow();
      if (!row || !row.state.lease || row.state.lease.tickId !== tickId) return { ok: false, code: "lease_lost" };
      const state = row.state;
      state.lease = null;
      state.lastStatus = String(status || "ok").slice(0, 40);
      state.lastDetail = detail ? String(detail).slice(0, 500) : null;
      if (state.lastStatus !== "failed") state.lastSuccessAt = nowIso;
      else state.failures = Number(state.failures || 0) + 1;
      const result = await query(
        "UPDATE habitat_ax_scheduler SET record_json = ?, revision = revision + 1, lease_expires_at = NULL, updated_at = ? WHERE id = 'primary' AND revision = ? RETURNING revision",
        [JSON.stringify(state), nowIso, row.revision]
      );
      return (result[0]?.results || []).length === 1 ? { ok: true } : { ok: false, code: "lease_lost" };
    },
    async fail({ tickId, error, nowIso }) {
      await this.initialize();
      const row = await readRow();
      if (!row) return { ok: false };
      const state = { ...emptyState(), ...row.state };
      if (state.lease && state.lease.tickId === tickId) state.lease = null;
      state.lastStatus = "failed";
      state.lastDetail = String(error || "tick failed").slice(0, 500);
      state.failures = Number(state.failures || 0) + 1;
      await query(
        "UPDATE habitat_ax_scheduler SET record_json = ?, revision = revision + 1, lease_expires_at = NULL, updated_at = ? WHERE id = 'primary' AND revision = ?",
        [JSON.stringify(state), nowIso, row.revision]
      );
      return { ok: true };
    },
    async status() {
      await this.initialize();
      const row = await readRow();
      return row ? row.state : emptyState();
    }
  });
}
