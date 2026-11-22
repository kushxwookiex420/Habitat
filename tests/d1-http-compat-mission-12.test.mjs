import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxObjectiveRepository } from "../ax-objective-repository.mjs";
import { createD1AxSecurityEventRepository } from "../ax-security-event-repository.mjs";
import { createD1SchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createSecurityEventService } from "../ax-security-events.mjs";
import { createSchedulerService } from "../ax-scheduler.mjs";

/**
 * The real D1 repositories over the real D1 HTTP request/response shape, with SQLite as the engine.
 * This proves SQL shape, CAS/unique behavior and transport parsing. It is NOT a live D1 test and
 * cannot prove Cloudflare-specific behavior or that production has the schema.
 */
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const statements = [];
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    statements.push(sql);
    const rows = db.prepare(sql).all(...params);
    return {
      ok: true,
      status: 200,
      async json() { return { success: true, result: [{ results: rows }] }; }
    };
  };
  return { db, statements, fetchImpl };
}

const credentials = { accountId: "acct-compat", databaseId: "db-compat", apiToken: "test-token-not-real" };

test("objective repository works through the D1 HTTP shape with CAS and accounting", async () => {
  const d1 = sqliteD1();
  const repository = createD1AxObjectiveRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();
  const service = createObjectiveService({ repository });
  const created = await service.create({ objective: "D1 compat objective", criteria: ["A child run is reserved and settled exactly once"], key: "d1-compat", budgetUsd: 0.05 });
  assert.equal(created.ok, true);
  const id = created.objective.id;
  await service.understand(id, { summary: "D1-shaped storage." });
  await service.plan(id, { steps: [{ objective: "inspect", agent: "engineering" }] });
  assert.equal((await service.start(id)).ok, true);
  assert.equal((await service.reserveExecution(id, { executionId: "d1-run", estimateUsd: 0.02 })).ok, true);
  assert.equal((await service.settleExecution(id, { executionId: "d1-run", actualUsd: 0.01 })).ok, true);
  const accounting = await service.accounting(id);
  assert.equal(accounting.spentUsd, 0.01);
  assert.equal(accounting.reservedUsd, 0);

  const stale = await repository.getRecord(id);
  const changed = { ...stale.objective, note: "first writer" };
  assert.equal((await repository.update(changed, stale.recordJson)).ok, true);
  const conflict = await repository.update({ ...stale.objective, note: "second writer" }, stale.recordJson);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "conflict");
});

test("security repository assigns unique sequences through D1 under concurrent appends", async () => {
  const d1 = sqliteD1();
  const repository = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();
  const log = createSecurityEventService({ repository });
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => log.record({
    category: "auth.failure",
    summary: "d1 concurrent " + index
  })));
  assert.equal(outcomes.every(item => item.ok), true, JSON.stringify(outcomes.filter(item => !item.ok)));
  const chain = await repository.chain({ limit: 100 });
  assert.equal(chain.length, 8);
  assert.deepEqual(chain.map(row => row.seq), Array.from({ length: 8 }, (_, index) => index + 1));
  const integrity = await log.integrity();
  assert.equal(integrity.ok, true);
  assert.equal(integrity.checked, 8);

  const duplicate = { ...chain[0], id: "sec_dup_d1" };
  const firstAppend = await repository.append(duplicate);
  const replay = await repository.append(duplicate);
  assert.equal(replay.seq, firstAppend.seq, "a replayed append returns the committed event");
  assert.equal((await repository.chain({ limit: 100 })).length, 9, "a replay does not append a second row");
});

test("scheduler repository acquires, completes and reports status through D1", async () => {
  const d1 = sqliteD1();
  const repository = createD1SchedulerRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();
  const service = createSchedulerService({ ticks: repository });
  const first = await service.tick({ trigger: "compat" });
  assert.equal(first.ok, true);
  const status = await service.status();
  assert.equal(status.scheduler.lastStatus, "ok");
  assert.equal(status.scheduler.tickCount, 1);
  assert.equal(status.scheduler.leaseActive, false);
});
