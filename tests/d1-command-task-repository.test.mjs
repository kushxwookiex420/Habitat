import test from "node:test";
import assert from "node:assert/strict";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";

/**
 * The command store must survive restarts and must not silently degrade to memory.
 * These tests drive the real repository against a fake D1 endpoint that records the SQL.
 */

function fakeD1({ fail = false } = {}) {
  const rows = new Map();
  const statements = [];
  const fetchImpl = async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    statements.push(sql);
    if (fail) {
      return { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: "boom" }] }) };
    }
    const respond = results => ({ ok: true, status: 200, json: async () => ({ success: true, result: [{ results, meta: { changes: results.length } }] }) });

    if (/^CREATE (TABLE|INDEX)/i.test(sql)) return respond([]);
    if (/^INSERT INTO habitat_command_tasks/i.test(sql)) {
      const [id, recordJson, status, updatedAt] = params;
      rows.set(id, { record_json: recordJson, status, updated_at: updatedAt });
      return respond([{}]);
    }
    if (/^UPDATE habitat_command_tasks/i.test(sql)) {
      const [recordJson, status, updatedAt, id] = params;
      if (!rows.has(id)) return respond([]);
      rows.set(id, { record_json: recordJson, status, updated_at: updatedAt });
      return respond([{}]);
    }
    if (/^SELECT record_json FROM habitat_command_tasks WHERE id/i.test(sql)) {
      const row = rows.get(params[0]);
      return respond(row ? [{ record_json: row.record_json }] : []);
    }
    if (/^SELECT record_json FROM habitat_command_tasks WHERE status/i.test(sql)) {
      const [status, limit] = params;
      const matches = [...rows.values()].filter(row => row.status === status).slice(0, Number(limit));
      return respond(matches.map(row => ({ record_json: row.record_json })));
    }
    if (/^SELECT record_json FROM habitat_command_tasks/i.test(sql)) {
      const limit = Number(params[0]);
      return respond([...rows.values()].slice(0, limit).map(row => ({ record_json: row.record_json })));
    }
    if (/^SELECT 1 AS ok/i.test(sql)) return respond([{ ok: 1 }]);
    return respond([]);
  };
  return { fetchImpl, statements, rows };
}

function build(options = {}) {
  const fake = fakeD1(options);
  const repository = createD1CommandTaskRepository({
    accountId: "acct",
    databaseId: "db",
    apiToken: "token",
    fetchImpl: fake.fetchImpl
  });
  return { repository, fake };
}

const task = {
  id: "cmd_1",
  objective: "ship the command center",
  status: "queued",
  createdAt: "2026-11-21T12:00:00.000Z",
  updatedAt: "2026-11-21T12:00:00.000Z"
};

test("initialize creates the command table and index, idempotently", async () => {
  const { repository, fake } = build();
  const first = await repository.initialize();
  assert.equal(first.ok, true);
  const second = await repository.initialize();
  assert.equal(second.ok, true);
  assert.ok(fake.statements.some(sql => /CREATE TABLE IF NOT EXISTS habitat_command_tasks/.test(sql)));
  assert.ok(fake.statements.some(sql => /CREATE INDEX IF NOT EXISTS habitat_command_tasks_status_updated_at/.test(sql)));
  // Nothing is created outside the command table.
  assert.equal(fake.statements.some(sql => /habitat_tasks\b/.test(sql)), false);
});

test("a task survives a write and a read", async () => {
  const { repository } = build();
  await repository.initialize();
  const created = await repository.create(task);
  assert.equal(created.id, "cmd_1");
  const loaded = await repository.get("cmd_1");
  assert.equal(loaded.objective, "ship the command center");
  assert.equal(loaded.status, "queued");
});

test("an update changes both the record and the indexed status column", async () => {
  const { repository, fake } = build();
  await repository.initialize();
  await repository.create(task);
  const updated = await repository.update("cmd_1", { status: "done", result: { summary: "shipped", evidence: ["commit:abc"] } });
  assert.equal(updated.status, "done");
  assert.equal(updated.result.summary, "shipped");
  assert.ok(fake.statements.some(sql => /^UPDATE habitat_command_tasks SET record_json = \?, status = \?, updated_at = \? WHERE id = \?$/.test(sql)));
  assert.equal(updated.id, "cmd_1");
});

test("listing filters by status and respects the requested limit", async () => {
  const { repository } = build();
  await repository.initialize();
  await repository.create(task);
  await repository.create({ ...task, id: "cmd_2", status: "done" });
  const queued = await repository.list({ status: "queued" });
  assert.deepEqual(queued.map(row => row.id), ["cmd_1"]);
  const all = await repository.list({ limit: 1 });
  assert.equal(all.length, 1);
});

test("updating a task that does not exist returns null instead of inventing a record", async () => {
  const { repository } = build();
  await repository.initialize();
  assert.equal(await repository.update("cmd_missing", { status: "done" }), null);
  assert.equal(await repository.get("cmd_missing"), null);
});

test("a failing D1 endpoint fails loudly so startup cannot silently use memory", async () => {
  const { repository } = build({ fail: true });
  await assert.rejects(() => repository.initialize(), /D1 command query failed/);
  await assert.rejects(() => repository.get("cmd_1"), /D1 command query failed/);
});

test("missing credentials are refused at construction", () => {
  assert.throws(() => createD1CommandTaskRepository({ accountId: "a", databaseId: "", apiToken: "" }), /requires CLOUDFLARE_ACCOUNT_ID/);
});
