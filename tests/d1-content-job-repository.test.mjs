import test from "node:test";
import assert from "node:assert/strict";
import { createD1ContentJobRepository } from "../d1-content-job-repository.mjs";

function fakeD1() {
  const rows = new Map();
  const fetchImpl = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    let results = [];
    let changes = 0;
    if (sql.startsWith("INSERT INTO habitat_content_jobs")) {
      rows.set(params[0], { id: params[0], record_json: params[1], status: params[2], updated_at: params[3] });
      changes = 1;
    } else if (sql.startsWith("SELECT record_json FROM habitat_content_jobs WHERE id")) {
      const row = rows.get(params[0]);
      results = row ? [{ record_json: row.record_json }] : [];
    } else if (sql.startsWith("SELECT record_json FROM habitat_content_jobs ORDER")) {
      results = [...rows.values()]
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, params[0])
        .map(row => ({ record_json: row.record_json }));
    } else if (sql.startsWith("SELECT 1")) {
      results = [{ ok: 1 }];
    }
    return {
      ok: true,
      status: 200,
      async json() { return { success: true, result: [{ results, meta: { changes } }] }; }
    };
  };
  return { rows, fetchImpl };
}

test("D1 content-job repository initializes, upserts, and restores complete job state", async () => {
  const fake = fakeD1();
  const repository = createD1ContentJobRepository({
    accountId: "account", databaseId: "database", apiToken: "secret", fetchImpl: fake.fetchImpl
  });
  await repository.initialize();
  const job = {
    id: "content-test-1",
    project: "ViceCityFiles",
    status: "research",
    updatedAt: "2026-10-09T12:00:00.000Z",
    stages: { research: { status: "completed", result: { angle: "confirmed facts" } } }
  };
  await repository.upsert(job);
  assert.deepEqual(await repository.get(job.id), job);
  assert.deepEqual(await repository.list({ limit: 10 }), [job]);
  const changed = { ...job, updatedAt: "2026-10-09T12:01:00.000Z", stages: { ...job.stages, script: { status: "completed", result: { title: "Test" } } } };
  await repository.upsert(changed);
  assert.deepEqual(await repository.get(job.id), changed);
  assert.equal(fake.rows.size, 1);
  assert.deepEqual(await repository.healthCheck(), { ok: true, adapter: "cloudflare-d1", durable: true });
});

test("D1 content-job repository rejects incomplete credentials", () => {
  assert.throws(() => createD1ContentJobRepository({ accountId: "account", databaseId: "", apiToken: "secret" }), /requires CLOUDFLARE_ACCOUNT_ID/);
});

test("D1 content-job repository does not expose token values in query errors", async () => {
  const repository = createD1ContentJobRepository({
    accountId: "account", databaseId: "database", apiToken: "do-not-leak",
    fetchImpl: async () => ({ ok: false, status: 403, async json() { return { success: false, errors: [{ message: "do-not-leak" }] }; } })
  });
  await assert.rejects(repository.initialize(), error => {
    assert.match(error.message, /HTTP 403/);
    assert.equal(error.message.includes("do-not-leak"), false);
    return true;
  });
});
