import test from "node:test";
import assert from "node:assert/strict";
import { createObjectiveService, pruneExecutions } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";

const CRITERIA = ["The run is attributable", "The charge happens once"];

async function started(repository, { budgetUsd = 0.05, now = () => new Date().toISOString() } = {}) {
  const service = createObjectiveService({ repository, now });
  const created = await service.create({
    objective: "Adversarial accounting objective",
    criteria: CRITERIA,
    key: "adv-" + Math.random().toString(36).slice(2),
    budgetUsd
  });
  const id = created.objective.id;
  await service.understand(id, { summary: "Test accounting invariants." });
  await service.plan(id, { steps: [{ objective: "inspect", agent: "engineering" }] });
  assert.equal((await service.start(id)).ok, true);
  return { service, id };
}

test("bounded history never discards an in-flight reservation", async () => {
  const repository = createMemoryObjectiveRepository();
  const { service, id } = await started(repository, { budgetUsd: 0.05 });

  for (let index = 0; index < 50; index += 1) {
    const key = "old-" + index;
    assert.equal((await service.reserveExecution(id, { executionId: key, estimateUsd: 0 })).ok, true);
    assert.equal((await service.releaseExecution(id, { executionId: key })).ok, true);
  }
  const active = await service.reserveExecution(id, { executionId: "active-run", estimateUsd: 0.02 });
  assert.equal(active.ok, true);

  // Push far past the history bound. The active reservation must survive every prune.
  for (let index = 0; index < 60; index += 1) {
    const key = "later-" + index;
    assert.equal((await service.reserveExecution(id, { executionId: key, estimateUsd: 0 })).ok, true);
    assert.equal((await service.releaseExecution(id, { executionId: key })).ok, true);
  }

  const objective = await service.get(id);
  const activeRow = objective.accounting.executions.find(item => item.executionId === "active-run");
  assert.ok(activeRow, "the reserved execution was not silently dropped");
  assert.equal(activeRow.status, "reserved");
  assert.equal(service.accountingOf(objective).reservedUsd, 0.02);
  const refused = await service.reserveExecution(id, { executionId: "too-much", estimateUsd: 0.04 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "budget_exhausted");
});

test("pruneExecutions keeps active rows and only trims terminal history", () => {
  const rows = [
    { executionId: "reserved-1", status: "reserved" },
    ...Array.from({ length: 80 }, (_, index) => ({ executionId: "done-" + index, status: "settled" }))
  ];
  const pruned = pruneExecutions(rows, 10);
  assert.ok(pruned.some(row => row.executionId === "reserved-1"));
  assert.equal(pruned.length, 10);
  assert.equal(pruned.filter(row => row.status === "reserved").length, 1);
});

test("concurrent independent reservations cannot jointly exceed the budget", async () => {
  const repository = createMemoryObjectiveRepository();
  const { service, id } = await started(repository, { budgetUsd: 0.05 });
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => service.reserveExecution(id, {
    executionId: "concurrent-" + index,
    estimateUsd: 0.01
  })));
  const accepted = outcomes.filter(outcome => outcome.ok === true);
  const refused = outcomes.filter(outcome => outcome.ok === false);
  assert.ok(accepted.length <= 5, "accepted reservations: " + accepted.length);
  assert.ok(refused.length >= 7);
  for (const outcome of refused) {
    assert.ok(["budget_exhausted", "objective_conflict"].includes(outcome.code), outcome.code);
  }
  const objective = await service.get(id);
  const accounting = service.accountingOf(objective);
  assert.ok(accounting.reservedUsd <= 0.05 + 1e-9, "reserved=" + accounting.reservedUsd);
  assert.equal(new Set(objective.accounting.executions.filter(row => row.status === "reserved").map(row => row.executionId)).size,
    objective.accounting.executions.filter(row => row.status === "reserved").length, "no duplicate execution ids");
});

test("a failed accounting write leaves no reservation and no spend", async () => {
  const inner = createMemoryObjectiveRepository();
  let failNext = false;
  const repository = {
    ...inner,
    async update(record, token) {
      if (failNext) { failNext = false; throw new Error("simulated store outage"); }
      return inner.update(record, token);
    }
  };
  const { service, id } = await started(repository, { budgetUsd: 0.05 });
  failNext = true;
  const outcome = await service.reserveExecution(id, { executionId: "lost-run", estimateUsd: 0.02 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "objective_store_unavailable");
  const objective = await service.get(id);
  assert.equal(objective.accounting.executions.length, 0);
  assert.equal(service.accountingOf(objective).reservedUsd, 0);
  assert.equal(service.accountingOf(objective).spentUsd, 0);
});

test("execution ids and charge ids are deterministic; replay never charges twice", async () => {
  const repository = createMemoryObjectiveRepository();
  const { service, id } = await started(repository);
  const first = await service.reserveExecution(id, { executionId: "same-id", estimateUsd: 0.01 });
  const second = await service.reserveExecution(id, { executionId: "same-id", estimateUsd: 0.01 });
  assert.equal(first.execution.chargeId, second.execution.chargeId);
  assert.equal(second.replayed, true);
  await service.settleExecution(id, { executionId: "same-id", actualUsd: 0.004, runId: "run_1" });
  await service.settleExecution(id, { executionId: "same-id", actualUsd: 0.004, runId: "run_1" });
  await service.settleExecution(id, { executionId: "same-id", actualUsd: 9, runId: "run_1" });
  const accounting = await service.accounting(id);
  assert.equal(accounting.spentUsd, 0.004);
  assert.equal(accounting.executions.filter(row => row.status === "settled").length, 1);
});

test("a bound run id cannot be silently reassigned", async () => {
  const repository = createMemoryObjectiveRepository();
  const { service, id } = await started(repository);
  await service.reserveExecution(id, { executionId: "bound", estimateUsd: 0.01 });
  assert.equal((await service.linkExecutionRun(id, { executionId: "bound", runId: "run_a" })).ok, true);
  const conflict = await service.linkExecutionRun(id, { executionId: "bound", runId: "run_b" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "execution_run_conflict");
});

test("stale unbound reservations are reconciled; a live or unknown bound run is not", async () => {
  let clock = Date.parse("2026-11-22T12:00:00.000Z");
  const repository = createMemoryObjectiveRepository();
  const { service, id } = await started(repository, { now: () => new Date(clock).toISOString() });

  await service.reserveExecution(id, { executionId: "unbound", estimateUsd: 0.01 });
  await service.reserveExecution(id, { executionId: "bound-live", estimateUsd: 0.01 });
  await service.linkExecutionRun(id, { executionId: "bound-live", runId: "run_live" });
  await service.reserveExecution(id, { executionId: "bound-dead", estimateUsd: 0.01 });
  await service.linkExecutionRun(id, { executionId: "bound-dead", runId: "run_dead" });
  clock += 31 * 60_000;

  // Without a run store, a bound reservation is kept: freeing it could fund a live run twice.
  const noStore = await service.reconcileReservations(id, { staleMs: 30 * 60_000, runExists: null });
  assert.deepEqual(noStore.released, ["unbound"]);
  assert.equal(noStore.accounting.reservedUsd, 0.02);

  const withStore = await service.reconcileReservations(id, {
    staleMs: 30 * 60_000,
    runExists: async runId => runId === "run_live"
  });
  assert.deepEqual(withStore.released, ["bound-dead"]);
  assert.equal(withStore.accounting.reservedUsd, 0.01);
  assert.equal(withStore.accounting.spentUsd, 0);

  const objective = await service.get(id);
  const rows = objective.accounting.executions;
  assert.equal(rows.find(row => row.executionId === "unbound").status, "released");
  assert.equal(rows.find(row => row.executionId === "bound-live").status, "reserved");
  assert.equal(rows.find(row => row.executionId === "bound-dead").status, "released");
});

test("a restart rebuilds the same accounting state without duplicate charges", async () => {
  const repository = createMemoryObjectiveRepository();
  const { service, id } = await started(repository);
  await service.reserveExecution(id, { executionId: "crash-run", estimateUsd: 0.02 });
  const before = await service.accounting(id);
  assert.equal(before.reservedUsd, 0.02);

  const records = [...repository._rows.values()].map(value => JSON.parse(value));
  const restarted = createObjectiveService({ repository: createMemoryObjectiveRepository({ records }) });
  const after = await restarted.accounting(id);
  assert.deepEqual(after, before);
  await restarted.settleExecution(id, { executionId: "crash-run", actualUsd: 0.015, runId: "run_after_restart" });
  const replay = await restarted.settleExecution(id, { executionId: "crash-run", actualUsd: 0.015, runId: "run_after_restart" });
  assert.equal(replay.replayed, true);
  assert.equal((await restarted.accounting(id)).spentUsd, 0.015);
});
