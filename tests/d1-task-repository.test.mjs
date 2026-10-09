import test from "node:test";
import assert from "node:assert/strict";
import { createD1TaskRepository } from "../d1-task-repository.mjs";

function fakeD1() {
  const rows = new Map();
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    calls.push({ sql, params });
    let result = [];
    if (sql.startsWith("INSERT INTO habitat_tasks")) {
      if (rows.has(params[0])) return response(false, [], "duplicate id");
      rows.set(params[0], { id: params[0], record_json: params[1], status: params[2], updated_at: params[3] });
      result = [{ meta: { changes: 1 } }];
    } else if (sql.startsWith("SELECT record_json FROM habitat_tasks WHERE id")) {
      const row = rows.get(params[0]);
      result = [{ results: row ? [{ record_json: row.record_json }] : [] }];
    } else if (sql.startsWith("SELECT record_json FROM habitat_tasks WHERE status")) {
      result = [{ results: [...rows.values()].filter(row => row.status === params[0]).slice(0, params[1]).map(row => ({ record_json: row.record_json })) }];
    } else if (sql.startsWith("SELECT record_json FROM habitat_tasks ORDER")) {
      result = [{ results: [...rows.values()].slice(0, params[0]).map(row => ({ record_json: row.record_json })) }];
    } else if (sql.startsWith("UPDATE habitat_tasks")) {
      const row = rows.get(params[3]);
      if (row) {
        rows.set(params[3], { id: params[3], record_json: params[0], status: params[1], updated_at: params[2] });
        result = [{ meta: { changes: 1 } }];
      } else result = [{ meta: { changes: 0 } }];
    } else if (sql.startsWith("DELETE FROM habitat_tasks")) {
      const existed = rows.delete(params[0]);
      result = [{ meta: { changes: existed ? 1 : 0 } }];
    } else {
      result = [{ results: [{ ok: 1 }], meta: { changes: 0 } }];
    }
    return response(true, result);
  };
  return { fetchImpl, rows, calls };
}

function response(success, result, message = "") {
  return {
    ok: success,
    status: success ? 200 : 400,
    async json() {
      return { success, result, errors: message ? [{ message }] : [] };
    }
  };
}

test("D1 repository requires all credentials and never defaults to memory", () => {
  assert.throws(() => createD1TaskRepository({}), /CLOUDFLARE_ACCOUNT_ID/);
});

test("D1 repository initializes and preserves task records across repository instances", async () => {
  const fake = fakeD1();
  const config = { accountId: "account", databaseId: "database", apiToken: "test-only-token", fetchImpl: fake.fetchImpl };
  const first = createD1TaskRepository(config);
  await first.initialize();
  const original = { id: "task-1", title: "test", status: "queued", createdAt: "2026-01-01T00:00:00.000Z" };
  await first.create(original);

  const restarted = createD1TaskRepository(config);
  assert.deepEqual(await restarted.get("task-1"), original);
  assert.deepEqual(await restarted.list(), [original]);
  assert.equal((await restarted.healthCheck()).durable, true);
  assert.ok(fake.calls.every(call => !JSON.stringify(call).includes("test-only-token")));
});

test("D1 repository updates and deletes tasks without changing stable IDs", async () => {
  const fake = fakeD1();
  const repo = createD1TaskRepository({ accountId: "account", databaseId: "database", apiToken: "test", fetchImpl: fake.fetchImpl });
  await repo.create({ id: "task-2", status: "queued", title: "first" });
  const updated = await repo.update("task-2", { status: "complete", title: "second", id: "forged-id" });
  assert.equal(updated.id, "task-2");
  assert.equal(updated.status, "complete");
  assert.equal((await repo.list({ status: "complete" })).length, 1);
  assert.equal(await repo.delete("task-2"), true);
  assert.equal(await repo.get("task-2"), null);
  assert.equal(await repo.delete("task-2"), false);
});

test("D1 repository reports API failures without returning provider payloads", async () => {
  const repo = createD1TaskRepository({
    accountId: "account", databaseId: "database", apiToken: "secret",
    fetchImpl: async () => response(false, [], "sensitive provider detail")
  });
  await assert.rejects(repo.healthCheck(), /check D1 credentials, database ID, and schema/);
});
