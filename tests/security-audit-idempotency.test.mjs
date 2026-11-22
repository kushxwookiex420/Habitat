import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxSecurityEventRepository, createMemorySecurityEventRepository } from "../ax-security-event-repository.mjs";
import { createSecurityEventService, verifyEventChain } from "../ax-security-events.mjs";

/**
 * Idempotent audit appends.
 *
 * The failure this covers: D1 commits the INSERT but the HTTP response is lost. The old retry
 * loop re-read the head and appended a second event. These tests prove a stable event id makes the
 * retry return the committed row instead, while a reused id with different content still fails.
 */

const credentials = { accountId: "acct-idem", databaseId: "db-idem", apiToken: "test-token-not-real" };

function sqliteD1({ loseInsertResponses = 0 } = {}) {
  const db = new DatabaseSync(":memory:");
  let inserts = 0;
  const statements = [];
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    statements.push(sql);
    const rows = db.prepare(sql).all(...params);
    if (/^\s*INSERT INTO habitat_ax_security_events/i.test(sql)) {
      inserts += 1;
      if (inserts <= loseInsertResponses) throw new Error("socket hang up after commit");
    }
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
  return { db, statements, fetchImpl, inserts: () => inserts };
}

function event(id, overrides = {}) {
  return {
    id,
    category: "approval.created",
    severity: "info",
    outcome: "allowed",
    actor: "owner-device",
    deviceId: "android-test",
    objectiveId: null,
    runId: null,
    taskId: "task-1",
    correlationId: "corr-1",
    summary: "approval recorded once",
    evidence: null,
    createdAt: "2026-11-22T21:00:00.000Z",
    ...overrides
  };
}

async function chainOf(repository) {
  return repository.chain({ limit: 100 });
}

test("a committed insert with a lost response is returned, not appended twice", async () => {
  const d1 = sqliteD1({ loseInsertResponses: 1 });
  const repository = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();

  const stored = await repository.append(event("sec_ambiguous"));
  assert.equal(stored.id, "sec_ambiguous");
  assert.equal(stored.seq, 1);
  assert.equal(d1.inserts(), 1, "only one INSERT was needed");

  const chain = await chainOf(repository);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].hash, stored.hash);
  assert.equal(verifyEventChain(chain).ok, true);
});

test("a duplicate retry is idempotent and does not advance the sequence", async () => {
  const d1 = sqliteD1();
  const repository = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();

  const first = await repository.append(event("sec_retry"));
  const second = await repository.append(event("sec_retry"));
  assert.deepEqual(second, first);
  assert.equal((await chainOf(repository)).length, 1);
  assert.equal((await repository.head()).seq, 1);

  const next = await repository.append(event("sec_next", { taskId: "task-2" }));
  assert.equal(next.seq, 2);
  assert.equal(verifyEventChain(await chainOf(repository)).ok, true);
});

test("concurrent identical appends produce one row", async () => {
  const d1 = sqliteD1();
  const repository = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();

  const results = await Promise.all(Array.from({ length: 6 }, () => repository.append(event("sec_concurrent"))));
  assert.equal(results.every(row => row.id === "sec_concurrent"), true);
  assert.equal(new Set(results.map(row => row.seq)).size, 1);
  assert.equal((await chainOf(repository)).length, 1);
  assert.equal(verifyEventChain(await chainOf(repository)).ok, true);
});

test("reusing an id for different content is refused", async () => {
  const d1 = sqliteD1();
  const repository = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();

  await repository.append(event("sec_conflict"));
  await assert.rejects(
    () => repository.append(event("sec_conflict", { summary: "a different event" })),
    /security_event_id_conflict/
  );
  assert.equal((await chainOf(repository)).length, 1);
});

test("a restarted repository recovers the committed event and stays idempotent", async () => {
  const d1 = sqliteD1({ loseInsertResponses: 1 });
  const first = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await first.initialize();
  const committed = await first.append(event("sec_restart"));

  // A new repository instance over the same database models a process restart.
  const second = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await second.initialize();
  const recovered = await second.append(event("sec_restart"));
  assert.deepEqual(recovered, committed);
  assert.equal((await chainOf(second)).length, 1);
  assert.equal(verifyEventChain(await chainOf(second)).ok, true);
});

test("memory storage follows the same idempotent and conflict rules", async () => {
  const repository = createMemorySecurityEventRepository();
  const first = await repository.append(event("sec_memory"));
  const second = await repository.append(event("sec_memory"));
  assert.deepEqual(second, first);
  assert.equal(repository._rows.length, 1);
  await assert.rejects(
    () => repository.append(event("sec_memory", { summary: "changed" })),
    /security_event_id_conflict/
  );
});

test("the service still returns one event when the store commits ambiguously", async () => {
  const d1 = sqliteD1({ loseInsertResponses: 1 });
  const repository = createD1AxSecurityEventRepository({ ...credentials, fetchImpl: d1.fetchImpl });
  await repository.initialize();
  const service = createSecurityEventService({ repository });

  const outcome = await service.record({ category: "approval.created", taskId: "task-service" });
  assert.equal(outcome.ok, true);
  assert.equal((await chainOf(repository)).length, 1);
  assert.equal((await service.integrity()).ok, true);
});
