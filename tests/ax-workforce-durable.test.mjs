import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkforceRepository } from "../d1-workforce-repository.mjs";
import { createDurableWorkforce } from "../ax-durable-workforce.mjs";

const NOW = "2026-11-24T12:00:00.000Z";
const now = () => NOW;

/** One shim covers both D1 (rows array) and node:sqlite (statement handle). */
function queryFrom(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };
}

function adapters() {
  return [
    { id: "local-coder", kind: "coding", description: "deterministic", execute: async () => ({ ok: true }), health: async () => ({ status: "healthy" }) },
    { id: "local-verifier", kind: "verification", description: "independent", execute: async () => ({ ok: true }) }
  ];
}

async function seed(workforce) {
  await workforce.registerAdapter(adapters()[0]);
  await workforce.registerAdapter(adapters()[1]);
  await workforce.registerAgent({
    id: "coder.one", name: "Coder", specialty: "coding", adapterId: "local-coder",
    capabilities: ["coding", "tests"], permissions: { allowed: ["coding"], denied: ["deploy"] },
    availability: { maxConcurrent: 1 }
  });
  await workforce.registerAgent({
    id: "verifier.one", name: "Verifier", specialty: "verification", adapterId: "local-verifier",
    capabilities: ["verification"], permissions: { allowed: ["verification"], denied: ["coding"] },
    availability: { maxConcurrent: 2 }
  });
}

test("the repository initializes idempotently and upserts instead of duplicating", async () => {
  const db = new DatabaseSync(":memory:");
  const repository = createWorkforceRepository({ query: queryFrom(db), now });
  assert.equal((await repository.initialize()).ok, true);
  assert.equal((await repository.initialize()).ok, true, "a second initialize is a no-op");

  await repository.saveAgent({ id: "a.one", name: "A", specialty: "coding", adapterId: "x", revision: 1, health: { status: "unknown" }, addedAt: NOW });
  await repository.saveAgent({ id: "a.one", name: "A renamed", specialty: "coding", adapterId: "x", revision: 2, health: { status: "healthy" }, addedAt: NOW });
  const agents = await repository.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "A renamed");
  assert.equal(agents[0].revision, 2);
});

test("the database refuses a second active assignment for one task", async () => {
  const db = new DatabaseSync(":memory:");
  const repository = createWorkforceRepository({ query: queryFrom(db), now });
  await repository.initialize();
  await repository.saveAssignment({ id: "asg_0001", taskId: "task-1", agentId: "a", state: "active", attempts: 1, assignedAt: NOW });
  await assert.rejects(
    () => repository.saveAssignment({ id: "asg_0002", taskId: "task-1", agentId: "b", state: "active", attempts: 1, assignedAt: NOW }),
    /UNIQUE|constraint/i
  );
  await repository.saveAssignment({ id: "asg_0002", taskId: "task-1", agentId: "b", state: "released", attempts: 1, assignedAt: NOW });
  assert.equal((await repository.listAssignments({ state: "active" })).length, 1);
});

test("a verified result is stored with an approval state that is not approval", async () => {
  const db = new DatabaseSync(":memory:");
  const repository = createWorkforceRepository({ query: queryFrom(db), now });
  await repository.initialize();
  await repository.saveResult({ id: "res_0001", taskId: "task-1", agentId: "coder.one", verifierAgentId: "verifier.one", status: "verified", approvalRequired: true, approved: false, evidence: ["x"], at: NOW });
  const [stored] = await repository.listResults();
  assert.equal(stored.approvalState, "required");
  const approved = await repository.setApproval({ resultId: "res_0001", state: "approved", by: "owner" });
  assert.equal(approved.ok, true);
  assert.equal((await repository.listResults())[0].approvalState, "approved");
  assert.equal((await repository.setApproval({ resultId: "res_0001", state: "maybe" })).code, "approval_state_invalid");
});

test("assignments, verified results and audit survive a new process", async () => {
  const db = new DatabaseSync(":memory:");
  const query = queryFrom(db);
  const repository = createWorkforceRepository({ query, now });

  // Process A: register the workforce and leave an assignment in flight.
  const first = createDurableWorkforce({ repository, adapters: adapters(), now });
  await seed(first);
  const assigned = await first.assign({ taskId: "task-1", agentId: "coder.one", requires: ["coding", "tests"], workspaceKey: "improvement/task-1" });
  assert.equal(assigned.ok, true);
  const firstCounts = await repository.counts();
  assert.equal(firstCounts.agents, 2);
  assert.equal(firstCounts.assignments, 1);

  // Process B: a new engine over the same store, as after a restart.
  const second = createDurableWorkforce({ repository, adapters: adapters(), now });
  const hydrated = await second.hydrate();
  assert.equal(hydrated.ok, true);
  assert.equal(second.agents().length, 2);
  const active = second.assignments().filter(item => item.state === "active");
  assert.equal(active.length, 1, "the in-flight assignment came back");
  assert.equal(active[0].taskId, "task-1");
  assert.equal(active[0].attempts, 1);

  // Finish it in the new process, with independent verification.
  const finalized = await second.finalize({
    assignmentId: active[0].id,
    result: { status: "completed", evidence: ["patch.diff"], changedFiles: ["ax-improvement.mjs"], tests: { ran: 4, passed: 4, failed: 0 }, costCents: null },
    verifierAgentId: "verifier.one",
    verification: { ok: true, evidence: ["node --test 4/4"], tests: { ran: 4, passed: 4, failed: 0 } }
  });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.result.status, "verified");
  assert.equal(finalized.result.approvalRequired, true);
  assert.equal(finalized.result.costMeasured, false);

  // Process C: results and audit are still there, and approval is still pending.
  const third = createDurableWorkforce({ repository, adapters: adapters(), now });
  await third.hydrate();
  const results = third.results();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "verified");
  assert.equal(results[0].verifierAgentId, "verifier.one");
  assert.equal(third.assignments().find(item => item.id === active[0].id).state, "completed");
  const audit = await repository.listAudit();
  assert.ok(audit.some(entry => entry.action === "agent.registered"));
  assert.ok(audit.some(entry => entry.action === "assignment.created"));
  assert.ok(audit.some(entry => entry.action === "result.recorded"));
  const stored = (await repository.listResults())[0];
  assert.equal(stored.approvalState, "required", "verification is not approval");
});

test("self-verification is still refused after a restart", async () => {
  const db = new DatabaseSync(":memory:");
  const repository = createWorkforceRepository({ query: queryFrom(db), now });
  const first = createDurableWorkforce({ repository, adapters: adapters(), now });
  await seed(first);
  const assigned = await first.assign({ taskId: "task-2", agentId: "coder.one" });

  const second = createDurableWorkforce({ repository, adapters: adapters(), now });
  await second.hydrate();
  const outcome = await second.finalize({
    assignmentId: assigned.assignmentId,
    result: { status: "completed", evidence: ["patch.diff"] },
    verifierAgentId: "coder.one",
    verification: { ok: true, evidence: ["self"], tests: { ran: 1, passed: 1, failed: 0 } }
  });
  assert.equal(outcome.code, "self_verification_refused");
  assert.equal(second.results()[0].status, "unverified");
});

test("a removed worker is gone after a restart while its results remain", async () => {
  const db = new DatabaseSync(":memory:");
  const repository = createWorkforceRepository({ query: queryFrom(db), now });
  const first = createDurableWorkforce({ repository, adapters: adapters(), now });
  await seed(first);
  const assigned = await first.assign({ taskId: "task-3", agentId: "coder.one" });
  await first.finalize({
    assignmentId: assigned.assignmentId,
    result: { status: "completed", evidence: ["e"], tests: { ran: 1, passed: 1, failed: 0 } },
    verifierAgentId: "verifier.one",
    verification: { ok: true, evidence: ["v"], tests: { ran: 1, passed: 1, failed: 0 } }
  });
  assert.equal((await first.removeAgent("coder.one")).ok, true);

  const second = createDurableWorkforce({ repository, adapters: adapters(), now });
  await second.hydrate();
  assert.equal(second.agent("coder.one"), null);
  assert.equal(second.results().length, 1, "the result outlives the worker");
});
