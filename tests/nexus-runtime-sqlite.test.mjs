import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  NEXUS_CLAIM_SQL, NEXUS_EXPIRED_SQL, NEXUS_HEARTBEAT_SQL, NEXUS_RENEW_SQL,
  NEXUS_REQUEUE_SQL, NEXUS_SEIZE_SQL
} from "../nexus-runtime.mjs";
import { COMMAND_TASK_FENCED_SQL } from "../d1-command-task-repository.mjs";

/**
 * SQL-SEMANTICS tests, executed by SQLite (node:sqlite) against the exact SQL strings the runtime
 * sends to Cloudflare D1. D1 is SQLite, so this proves statement syntax, JSON functions, the
 * conditional guards and RETURNING behaviour on a real SQL engine.
 *
 * It is NOT a live D1 test: no Cloudflare credentials are used, no HTTP request is made, and D1's
 * own limits (statement size, time limits, concurrency) are not exercised. A live D1 run is still
 * required before deployment.
 */

const TASKS_DDL = "CREATE TABLE habitat_command_tasks (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)";
const WORKERS_DDL = `CREATE TABLE habitat_nexus_workers (
  worker_id TEXT PRIMARY KEY NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
  state TEXT NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, detail TEXT
)`;

function db() {
  const database = new DatabaseSync(":memory:");
  database.exec(TASKS_DDL);
  database.exec(WORKERS_DDL);
  return database;
}

function insert(database, id, record, status = record.status, updatedAt = record.updatedAt) {
  database.prepare("INSERT INTO habitat_command_tasks (id, record_json, status, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, JSON.stringify(record), status, updatedAt);
}

function read(database, id) {
  const row = database.prepare("SELECT record_json, status FROM habitat_command_tasks WHERE id = ?").get(id);
  return row ? { ...JSON.parse(row.record_json), status: row.status } : null;
}

const T0 = "2026-11-21T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

test("D1/SQLite: the claim statement claims a queued task exactly once", () => {
  const database = db();
  insert(database, "t1", { id: "t1", status: "queued", attempts: 0, adapter: "runtime.health", updatedAt: T0 });

  const first = database.prepare(NEXUS_CLAIM_SQL).all("w1", "2026-11-21T00:05:00.000Z", "fence-1", T0, T0);
  assert.equal(first.length, 1, "first claim wins");
  assert.equal(JSON.parse(first[0].record_json).fence, "fence-1");
  assert.equal(JSON.parse(first[0].record_json).claimedBy, "w1");

  const second = database.prepare(NEXUS_CLAIM_SQL).all("w2", "2026-11-21T00:05:00.000Z", "fence-2", T0, T0);
  assert.equal(second.length, 0, "second worker gets nothing");
  assert.equal(read(database, "t1").claimedBy, "w1", "ownership did not change");
});

test("D1/SQLite: an approved task (working, no fence) is claimable", () => {
  const database = db();
  insert(database, "t2", { id: "t2", status: "working", updatedAt: T0, adapter: "runtime.health", approvals: [{ state: "approved" }] });
  const claimed = database.prepare(NEXUS_CLAIM_SQL).all("w1", "2026-11-21T00:05:00.000Z", "fence-9", T0, T0);
  assert.equal(claimed.length, 1, "approve() leaves the task in working with no fence, and it is picked up");
  assert.equal(JSON.parse(claimed[0].record_json).fence, "fence-9");
});

test("D1/SQLite: an adapter-less legacy task is not claimed", () => {
  const database = db();
  insert(database, "legacy", { id: "legacy", status: "queued", attempts: 0, updatedAt: T0 });
  const claimed = database.prepare(NEXUS_CLAIM_SQL).all("w1", "2026-11-21T00:05:00.000Z", "fence-legacy", T0, T0);
  assert.equal(claimed.length, 0);
  assert.equal(read(database, "legacy").status, "queued");
});

test("D1/SQLite: a fenced (owned) task is not claimable by another worker", () => {
  const database = db();
  insert(database, "t3", { id: "t3", status: "working", fence: "owned", claimedBy: "w1", leaseUntil: "2026-11-21T00:05:00.000Z", updatedAt: T0 }, "working");
  const claimed = database.prepare(NEXUS_CLAIM_SQL).all("w2", "2026-11-21T00:10:00.000Z", "fence-x", T0, T0);
  assert.equal(claimed.length, 0);
});

test("D1/SQLite: lease renewal only succeeds for the owning fence", () => {
  const database = db();
  insert(database, "t4", { id: "t4", status: "working", fence: "f-own", claimedBy: "w1", leaseUntil: PAST, updatedAt: T0 }, "working");

  const wrong = database.prepare(NEXUS_RENEW_SQL).all("2026-11-21T01:00:00.000Z", T0, T0, "t4", "f-other");
  assert.equal(wrong.length, 0, "a different fence cannot renew");
  assert.equal(read(database, "t4").leaseUntil, PAST);

  const right = database.prepare(NEXUS_RENEW_SQL).all("2026-11-21T01:00:00.000Z", T0, T0, "t4", "f-own");
  assert.equal(right.length, 1);
  assert.equal(read(database, "t4").leaseUntil, "2026-11-21T01:00:00.000Z");
});

test("D1/SQLite: requeue is atomic on the fence and increments attempts", () => {
  const database = db();
  insert(database, "t5", { id: "t5", status: "working", fence: "f5", claimedBy: "w1", attempts: 0, leaseUntil: PAST, updatedAt: T0 }, "working");

  const wrong = database.prepare(NEXUS_REQUEUE_SQL).all(1, T0, T0, "t5", "not-the-fence");
  assert.equal(wrong.length, 0, "stale recoverer loses");
  assert.equal(read(database, "t5").status, "working");

  const right = database.prepare(NEXUS_REQUEUE_SQL).all(1, T0, T0, "t5", "f5");
  assert.equal(right.length, 1);
  const after = read(database, "t5");
  assert.equal(after.status, "queued");
  assert.equal(after.attempts, 1);
  assert.equal(after.fence, null);
  assert.equal(after.claimedBy, null);

  const again = database.prepare(NEXUS_REQUEUE_SQL).all(2, T0, T0, "t5", "f5");
  assert.equal(again.length, 0, "the same fence cannot be requeued twice");
});

test("D1/SQLite: seize lets exactly one recoverer fail exhausted work", () => {
  const database = db();
  insert(database, "t6", { id: "t6", status: "working", fence: "f6", claimedBy: "w1", attempts: 2, leaseUntil: PAST, updatedAt: T0 }, "working");

  const first = database.prepare(NEXUS_SEIZE_SQL).all("r1", "take-1", T0, T0, "t6", "f6");
  assert.equal(first.length, 1);
  const second = database.prepare(NEXUS_SEIZE_SQL).all("r2", "take-2", T0, T0, "t6", "f6");
  assert.equal(second.length, 0, "the old fence is gone, so the second recoverer cannot also fail it");
});

test("D1/SQLite: expiry selects expired leases and lease-less stale work only", () => {
  const database = db();
  insert(database, "expired", { id: "expired", status: "working", fence: "a", leaseUntil: PAST, updatedAt: T0 }, "working");
  insert(database, "no-lease-old", { id: "no-lease-old", status: "working", updatedAt: PAST }, "working", PAST);
  insert(database, "live", { id: "live", status: "working", fence: "b", leaseUntil: "2026-11-22T00:00:00.000Z", updatedAt: T0 }, "working");
  insert(database, "no-lease-fresh", { id: "no-lease-fresh", status: "working", updatedAt: T0 }, "working", T0);
  insert(database, "queued", { id: "queued", status: "queued", updatedAt: PAST }, "queued", PAST);

  const rows = database.prepare(NEXUS_EXPIRED_SQL).all(T0, "2026-11-20T00:00:00.000Z");
  const ids = rows.map(row => row.id).sort();
  assert.deepEqual(ids, ["expired", "no-lease-old"]);
});

test("D1/SQLite: heartbeat upsert keeps one row per worker and updates counters", () => {
  const database = db();
  database.prepare(NEXUS_HEARTBEAT_SQL).run("w1", T0, T0, "starting", 0, 0, 0, null);
  database.prepare(NEXUS_HEARTBEAT_SQL).run("w1", T0, "2026-11-21T00:01:00.000Z", "idle", 3, 2, 1, "done");
  const rows = database.prepare("SELECT * FROM habitat_nexus_workers").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "idle");
  assert.equal(rows[0].claimed, 3);
  assert.equal(rows[0].completed, 2);
  assert.equal(rows[0].failed, 1);
  assert.equal(rows[0].started_at, T0, "started_at is preserved across heartbeats");
});

test("D1/SQLite: fenced transition is a single conditional write", () => {
  const database = db();
  insert(database, "f1", { id: "f1", status: "working", fence: "fence-a", claimedBy: "w-a", attempts: 0, updatedAt: T0 }, "working");

  const wrongFence = database.prepare(COMMAND_TASK_FENCED_SQL).all(
    JSON.stringify({ id: "f1", status: "done", result: { evidence: ["a"] } }), "done", T0, "f1", "working", "fence-b", "w-a"
  );
  assert.equal(wrongFence.length, 0, "a different fence cannot complete");
  assert.equal(read(database, "f1").status, "working");

  const wrongOwner = database.prepare(COMMAND_TASK_FENCED_SQL).all(
    JSON.stringify({ id: "f1", status: "done" }), "done", T0, "f1", "working", "fence-a", "w-b"
  );
  assert.equal(wrongOwner.length, 0, "a different claim owner cannot complete");
  assert.equal(read(database, "f1").status, "working");

  const good = database.prepare(COMMAND_TASK_FENCED_SQL).all(
    JSON.stringify({ id: "f1", status: "done", result: { summary: "ok", evidence: ["a"] } }), "done", T0, "f1", "working", "fence-a", "w-a"
  );
  assert.equal(good.length, 1, "the owning claim completes");
  assert.equal(read(database, "f1").status, "done");

  const after = database.prepare(COMMAND_TASK_FENCED_SQL).all(
    JSON.stringify({ id: "f1", status: "failed" }), "failed", T0, "f1", "working", "fence-a", "w-a"
  );
  assert.equal(after.length, 0, "a terminal task cannot be transitioned again");
  assert.equal(read(database, "f1").status, "done");
});

test("D1/SQLite: concurrent fenced transitions allow exactly one winner", () => {
  const database = db();
  insert(database, "f2", { id: "f2", status: "working", fence: "fence-x", claimedBy: "w-a", updatedAt: T0 }, "working");
  const statement = database.prepare(COMMAND_TASK_FENCED_SQL);
  const first = statement.all(JSON.stringify({ id: "f2", status: "done" }), "done", T0, "f2", "working", "fence-x", "w-a");
  const second = statement.all(JSON.stringify({ id: "f2", status: "done" }), "done", T0, "f2", "working", "fence-x", "w-a");
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});
