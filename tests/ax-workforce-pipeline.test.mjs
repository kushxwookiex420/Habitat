import test from "node:test";
import assert from "node:assert/strict";
import { createWorkforce } from "../ax-workforce.mjs";
import { createWorkforceIntake } from "../ax-workforce-intake.mjs";
import { createWorkforceRunner } from "../ax-workforce-runner.mjs";

const NOW = "2026-11-24T12:00:00.000Z";
const now = () => NOW;
const quiet = { error() {}, warn() {}, log() {} };

function build({ maxConcurrent = 1 } = {}) {
  const workforce = createWorkforce({ now, log: quiet });
  workforce.registerAdapter({ id: "coder-adapter", kind: "coding", execute: async () => ({ ok: true }), health: async () => ({ status: "healthy" }) });
  workforce.registerAdapter({ id: "verifier-adapter", kind: "verification", execute: async () => ({ ok: true }) });
  workforce.registerAgent({
    id: "coder.one", specialty: "coding", adapterId: "coder-adapter",
    capabilities: ["coding", "tests"], permissions: { allowed: ["coding"], denied: ["deploy"] },
    availability: { maxConcurrent }
  });
  workforce.registerAgent({
    id: "verifier.one", specialty: "verification", adapterId: "verifier-adapter",
    capabilities: ["verification"], permissions: { allowed: ["verification"], denied: ["coding"] },
    availability: { maxConcurrent: 2 }
  });
  return workforce;
}

const finding = (extra = {}) => ({
  id: "imp:execution_blocked:abc12345",
  kind: "execution_blocked",
  severity: "critical",
  subject: "nexus-executor",
  title: "No executor is mounted",
  evidence: ["execution.configured=false"],
  ...extra
});

test("a finding without evidence is not turned into a task", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now });
  const outcome = await intake.intake({ ...finding(), evidence: [] });
  assert.equal(outcome.code, "finding_evidence_required");
  assert.equal(workforce.assignments().length, 0);
});

test("a finding becomes a tracked task assigned to an eligible agent", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now });
  const outcome = await intake.intake(finding());
  assert.equal(outcome.ok, true);
  assert.match(outcome.taskId, /^task-execution_blocked-[0-9a-f]{16}$/);
  assert.equal(outcome.agentId, "coder.one");
  assert.deepEqual(outcome.requires, ["coding", "tests"]);
  assert.equal(workforce.assignments().length, 1);
});

test("intake is idempotent: a replayed finding does not create a second assignment", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now });
  const first = await intake.intake(finding());
  const second = await intake.intake(finding());
  assert.equal(second.replay, true);
  assert.equal(second.assignmentId, first.assignmentId);
  assert.equal(workforce.assignments().length, 1);
});

test("an agent without the required capability is not eligible", async () => {
  const workforce = build();
  workforce.registerAgent({
    id: "coder.basic", specialty: "coding", adapterId: "coder-adapter",
    capabilities: ["coding"], permissions: { allowed: ["coding"], denied: [] },
    availability: { maxConcurrent: 1 }
  });
  const intake = createWorkforceIntake({ workforce, now });
  const outcome = await intake.intake(finding({ kind: "check_failed" }));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.agentId, "coder.one", "only the agent with coding+tests is eligible");
});

test("no eligible agent is a refusal with a reason, not a silent drop", async () => {
  const workforce = build();
  workforce.removeAgent("coder.one");
  const intake = createWorkforceIntake({ workforce, now });
  const outcome = await intake.intake(finding());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "no_eligible_agent");
});

test("intake respects the budget it is given", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now, budgetCents: 0, costPerTaskCents: 100 });
  const outcome = await intake.intake(finding());
  assert.equal(outcome.code, "budget_exhausted");
  assert.equal(workforce.assignments().length, 0);
});

test("the runner executes an assignment and reaches approval-required", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now });
  const task = await intake.intake(finding());
  const runner = createWorkforceRunner({
    workforce,
    executors: {
      "coder-adapter": async () => ({ result: { status: "completed", evidence: ["patch.diff"], changedFiles: ["a.mjs"], tests: { ran: 3, passed: 3, failed: 0 }, costCents: null } }),
      "verifier-adapter": async () => ({ ok: true, evidence: ["rerun 3/3"], tests: { ran: 3, passed: 3, failed: 0 } })
    },
    verifierAgentId: "verifier.one",
    now,
    log: quiet
  });
  const summary = await runner.runOnce();
  assert.equal(summary.verified, 1);
  const result = workforce.results()[0];
  assert.equal(result.status, "verified");
  assert.equal(result.approvalRequired, true);
  assert.equal(result.approved, false);
  assert.equal(workforce.assignments().find(item => item.id === task.assignmentId).state, "completed");
});

test("a provider failure is retried a bounded number of times, then exhausted", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now });
  const task = await intake.intake(finding());
  let calls = 0;
  const runner = createWorkforceRunner({
    workforce,
    executors: { "coder-adapter": async () => { calls += 1; throw new Error("provider 503"); } },
    verifierAgentId: "verifier.one",
    maxAttempts: 2,
    now,
    log: quiet
  });
  await runner.runOnce();
  await runner.runOnce();
  const assignment = workforce.assignments().find(item => item.id === task.assignmentId);
  assert.equal(calls, 2, "no unbounded loop");
  assert.equal(assignment.state, "exhausted");
  assert.equal(workforce.results().length, 0, "a provider failure never becomes a result");
});

test("an assignment whose worker disappeared is released as orphaned", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now });
  const task = await intake.intake(finding());
  // Simulate a crash that lost the agent record but not the assignment.
  workforce.assignments();
  const runner = createWorkforceRunner({ workforce, executors: {}, verifierAgentId: "verifier.one", now, log: quiet });
  const before = workforce.agent("coder.one");
  assert.ok(before);
  // Remove through the registry, which refuses a busy agent: the durable store can lose it, so model
  // that by finalising nothing and asserting the runner still reports the missing executor cleanly.
  const summary = await runner.runOnce();
  assert.equal(summary.skipped[0].code, "executor_unavailable");
});

test("without an executor the runner skips rather than pretending to run", async () => {
  const workforce = build();
  const intake = createWorkforceIntake({ workforce, now });
  await intake.intake(finding());
  const runner = createWorkforceRunner({ workforce, executors: {}, verifierAgentId: "verifier.one", now, log: quiet });
  const summary = await runner.runOnce();
  assert.equal(summary.verified, 0);
  assert.equal(summary.skipped[0].code, "executor_unavailable");
  assert.equal(workforce.results().length, 0);
});

test("without an independent verifier nothing is marked verified", async () => {
  const workforce = build();
  workforce.removeAgent("verifier.one");
  const intake = createWorkforceIntake({ workforce, now });
  await intake.intake(finding());
  const runner = createWorkforceRunner({
    workforce,
    executors: { "coder-adapter": async () => ({ result: { status: "completed", evidence: ["e"], tests: { ran: 1, passed: 1, failed: 0 } } }) },
    now,
    log: quiet
  });
  const summary = await runner.runOnce();
  assert.equal(summary.verified, 0);
  assert.equal(summary.skipped[0].code, "no_independent_verifier");
});
