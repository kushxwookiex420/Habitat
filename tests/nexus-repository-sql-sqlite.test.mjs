import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { COMMAND_TASK_FENCED_SQL, COMMAND_TASK_UNFENCED_UPDATE_SQL } from "../d1-command-task-repository.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE habitat_command_tasks (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)");
  return db;
}

function insert(db, id, record, status = record.status || "working", updatedAt = record.updatedAt || "2026-11-21T00:00:00.000Z") {
  const raw = JSON.stringify(record);
  db.prepare("INSERT INTO habitat_command_tasks (id, record_json, status, updated_at) VALUES (?, ?, ?, ?)").run(id, raw, status, updatedAt);
  return raw;
}

function legacy(id, extra = {}) {
  return {
    id, objective: "legacy", role: "ax", status: "working",
    createdAt: "2026-11-21T00:00:00.000Z", updatedAt: "2026-11-21T00:00:00.000Z",
    attempts: 0, approvals: [], statusHistory: [], ...extra
  };
}

test("the unfenced update SQL applies a matching version exactly once", () => {
  const db = database();
  const original = insert(db, "cmd_1", legacy("cmd_1"));
  const next = JSON.stringify({ ...legacy("cmd_1"), status: "done", result: { summary: "ok", evidence: ["x"] } });
  const stmt = db.prepare(COMMAND_TASK_UNFENCED_UPDATE_SQL);
  const first = stmt.all(next, "done", "2026-11-21T00:00:01.000Z", "cmd_1", "working", original);
  assert.equal(first.length, 1, "matching version writes and returns the row");
  assert.equal(JSON.parse(first[0].record_json).status, "done");

  const stale = stmt.all(JSON.stringify({ ...legacy("cmd_1"), status: "failed" }), "failed", "2026-11-21T00:00:02.000Z", "cmd_1", "working", original);
  assert.equal(stale.length, 0, "a stale version writes nothing");
  const row = db.prepare("SELECT record_json FROM habitat_command_tasks WHERE id = ?").get("cmd_1");
  assert.equal(JSON.parse(row.record_json).status, "done");
});

test("null and missing fence are both treated as unfenced", () => {
  const db = database();
  const stmt = db.prepare(COMMAND_TASK_UNFENCED_UPDATE_SQL);
  for (const [id, extra] of [["cmd_null", { fence: null }], ["cmd_missing", {}]]) {
    const original = insert(db, id, legacy(id, extra));
    const next = JSON.stringify({ ...legacy(id, extra), status: "done" });
    const rows = stmt.all(next, "done", "2026-11-21T00:00:03.000Z", id, "working", original);
    assert.equal(rows.length, 1, id + " remains updatable");
  }
});

test("a fenced or status-changed row cannot be written by the unfenced SQL", () => {
  const db = database();
  const stmt = db.prepare(COMMAND_TASK_UNFENCED_UPDATE_SQL);
  const fencedRecord = legacy("cmd_f", { fence: "fence-1", claimedBy: "w1" });
  const original = insert(db, "cmd_f", fencedRecord);
  const next = JSON.stringify({ ...fencedRecord, status: "done" });
  assert.equal(stmt.all(next, "done", "2026-11-21T00:00:04.000Z", "cmd_f", "working", original).length, 0);

  const queued = legacy("cmd_q", { status: "queued" });
  const queuedRaw = insert(db, "cmd_q", queued, "queued");
  assert.equal(stmt.all(next, "done", "2026-11-21T00:00:04.000Z", "cmd_q", "working", queuedRaw).length, 0, "status mismatch is rejected");
});

test("the fenced transition SQL still requires status, fence and claimedBy", () => {
  const db = database();
  const record = { ...legacy("cmd_w"), fence: "fence-live", claimedBy: "worker-1" };
  const original = insert(db, "cmd_w", record);
  const stmt = db.prepare(COMMAND_TASK_FENCED_SQL);
  const done = JSON.stringify({ ...record, status: "done" });
  assert.equal(stmt.all(done, "done", "2026-11-21T00:00:05.000Z", "cmd_w", "working", "fence-live", "worker-1").length, 1);
  assert.equal(stmt.all(done, "done", "2026-11-21T00:00:05.000Z", "cmd_w", "working", "wrong-fence", "worker-1").length, 0);
  assert.equal(stmt.all(done, "done", "2026-11-21T00:00:05.000Z", "cmd_w", "working", "fence-live", "other-worker").length, 0);
  const row = db.prepare("SELECT record_json FROM habitat_command_tasks WHERE id = ?").get("cmd_w");
  assert.equal(JSON.parse(row.record_json).status, "done");
  assert.equal(JSON.parse(row.record_json).claimedBy, "worker-1");
  assert.equal(_rawUnchanged(db, "cmd_w", original), false, "the first fenced transition changed the row once");
});

function _rawUnchanged(db, id, expected) {
  return db.prepare("SELECT record_json FROM habitat_command_tasks WHERE id = ?").get(id).record_json === expected;
}
