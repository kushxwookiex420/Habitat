import test from "node:test";
import assert from "node:assert/strict";
import { createUniversalCommandEngine, normalizeState } from "../universal-command-engine.mjs";
import { createToolRegistry } from "../tool-registry.mjs";
import { describeRoles } from "../agent-roles.mjs";

function memoryRepository() {
  const rows = new Map();
  return {
    rows,
    async create(task) {
      if (rows.has(task.id)) throw new Error("duplicate id");
      rows.set(task.id, structuredClone(task));
      return structuredClone(task);
    },
    async get(id) {
      return rows.has(id) ? structuredClone(rows.get(id)) : null;
    },
    async list({ limit = 50, status } = {}) {
      const all = [...rows.values()].filter(row => !status || row.status === status);
      return all.slice(0, limit).map(row => structuredClone(row));
    },
    async update(id, patch) {
      if (!rows.has(id)) return null;
      const next = { ...rows.get(id), ...structuredClone(patch), id };
      rows.set(id, next);
      return structuredClone(next);
    }
  };
}

function setup(options = {}) {
  const repository = memoryRepository();
  const registry = createToolRegistry({ env: options.env || {} });
  let counter = 0;
  const engine = createUniversalCommandEngine({
    repository,
    registry,
    now: options.now || (() => "2026-11-21T12:00:00.000Z"),
    newId: () => "cmd_test_" + (++counter),
    maxAttempts: 2
  });
  return { repository, registry, engine };
}

test("a submitted objective is queued, not reported as work in progress", async () => {
  const { engine } = setup();
  const outcome = await engine.submit({ objective: "Ship the launcher build" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.task.status, "queued");
  assert.equal(outcome.task.result, null);
  assert.equal(outcome.task.statusHistory.length, 1);
  assert.equal(outcome.task.statusHistory[0].to, "queued");
});

test("an objective shorter than three characters is refused", async () => {
  const { engine } = setup();
  const outcome = await engine.submit({ objective: "  a  " });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "invalid_objective");
});

test("an idempotency key returns the same task instead of a second one", async () => {
  const { engine, repository } = setup();
  const first = await engine.submit({ objective: "Rotate the relay keys", idempotencyKey: "owner-2026-11-21-keys" });
  const second = await engine.submit({ objective: "Rotate the relay keys", idempotencyKey: "owner-2026-11-21-keys" });
  assert.equal(second.replayed, true);
  assert.equal(second.task.id, first.task.id);
  assert.equal(repository.rows.size, 1);
});

test("a concurrent idempotent submission replays the winning row instead of failing the insert", async () => {
  const { engine, repository } = setup();
  // Simulate the other request winning after both callers read no existing row: the INSERT reports
  // a duplicate, but the deterministic idempotency id is now present. The engine must replay it.
  repository.create = async task => {
    repository.rows.set(task.id, structuredClone(task));
    throw new Error("UNIQUE constraint failed: habitat_command_tasks.id");
  };
  const outcome = await engine.submit({ objective: "Rotate the relay keys", idempotencyKey: "raced-key" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.replayed, true);
  assert.equal(repository.rows.size, 1);
});

test("cancellation is explicit, terminal, and unavailable to a worker-owned task", async () => {
  const { engine, repository } = setup();
  const task = (await engine.submit({ objective: "Prepare a report" })).task;
  const cancelled = await engine.cancel({ taskId: task.id, by: "owner", reason: "no longer needed" });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(cancelled.task.cancelReason, "no longer needed");
  assert.equal(cancelled.task.statusHistory.at(-1).to, "cancelled");
  assert.equal((await engine.complete({ taskId: task.id, result: { summary: "late", evidence: ["x"] } })).code, "invalid_transition");
  assert.equal((await engine.checkpoint({ taskId: task.id, note: "late" })).code, "invalid_transition");
  assert.equal((await engine.cancel({ taskId: task.id })).code, "invalid_transition");

  const owned = (await engine.submit({ objective: "Worker-owned task" })).task;
  repository.rows.get(owned.id).fence = "fence-live";
  const refused = await engine.cancel({ taskId: owned.id });
  assert.equal(refused.code, "claim_required");
  assert.equal(repository.rows.get(owned.id).status, "queued");
});

test("a plan may reference an unavailable tool but must not claim it ran", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Research launcher options" })).task;
  const planned = await engine.plan({
    taskId: task.id,
    steps: [{ step: "search the web", role: "orion", tool: "web.search" }]
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.task.status, "working");
  assert.equal(planned.task.plan[0].toolAvailability, "adapter_missing");
  assert.ok(planned.warnings.some(warning => warning.includes("adapter_missing")));
});

test("a step whose tool is approval gated parks the task for the owner", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Deploy the new backend", role: "nexus" })).task;
  const planned = await engine.plan({
    taskId: task.id,
    steps: [{ step: "deploy to render", role: "nexus", tool: "deploy.render" }]
  });
  assert.equal(planned.approvalRequired, true);
  assert.equal(planned.task.status, "needs_approval");
  assert.equal(planned.task.approvals.at(-1).state, "requested");
});

test("approval moves the task to working and a denial fails it honestly", async () => {
  const { engine } = setup();
  const approved = (await engine.submit({ objective: "Deploy to render", role: "nexus" })).task;
  await engine.plan({ taskId: approved.id, steps: [{ step: "deploy", role: "nexus", tool: "deploy.render" }] });
  const granted = await engine.approve({ taskId: approved.id, by: "owner" });
  assert.equal(granted.task.status, "working");
  assert.equal(granted.task.approvals.at(-1).state, "approved");

  const denied = (await engine.submit({ objective: "Buy the ad slot" })).task;
  await engine.requestApproval({ taskId: denied.id, reason: "spends money", action: "payment.spend" });
  const result = await engine.deny({ taskId: denied.id, by: "owner", reason: "not this month" });
  assert.equal(result.task.status, "failed");
  assert.match(result.task.error, /Denied by owner/);
  assert.equal(result.task.result, null);
});

test("a task cannot be completed while approval is pending", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Publish the video" })).task;
  await engine.requestApproval({ taskId: task.id, reason: "publishes externally" });
  const outcome = await engine.complete({ taskId: task.id, result: { summary: "done", evidence: ["https://x.test/v"] } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "approval_pending");
});

test("completion without evidence is refused and leaves the task working", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Build the APK", role: "nexus" })).task;
  await engine.plan({ taskId: task.id, steps: [{ step: "assemble", role: "nexus", tool: "system.health" }] });
  const noEvidence = await engine.complete({ taskId: task.id, result: { summary: "built it" } });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.code, "evidence_required");
  const noSummary = await engine.complete({ taskId: task.id, result: { evidence: ["https://x.test/a.apk"] } });
  assert.equal(noSummary.code, "result_required");
  const after = await engine.get(task.id);
  assert.equal(after.task.status, "working");
  assert.equal(after.task.result, null);
});

test("completion with evidence closes the task and records who verified it", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Build the APK", role: "nexus" })).task;
  const outcome = await engine.complete({
    taskId: task.id,
    result: { summary: "APK built", evidence: ["sha256:abc", "https://x.test/app.apk"] },
    verifiedBy: "sentinel"
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.task.status, "done");
  assert.equal(outcome.task.result.verifiedBy, "sentinel");
  assert.equal(outcome.task.result.evidence.length, 2);
  assert.deepEqual(outcome.task.statusHistory.at(-1), {
    from: "queued", to: "done", at: "2026-11-21T12:00:00.000Z", by: "sentinel", reason: "completed with evidence"
  });
});

test("a finished task rejects further transitions", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Write the report" })).task;
  await engine.complete({ taskId: task.id, result: { summary: "written", evidence: ["reports/r.md"] } });
  const again = await engine.complete({ taskId: task.id, result: { summary: "written", evidence: ["reports/r.md"] } });
  assert.equal(again.ok, false);
  assert.equal(again.code, "invalid_transition");
  const failed = await engine.fail({ taskId: task.id, error: "nope" });
  assert.equal(failed.code, "invalid_transition");
});

test("failure needs a real error and retries are capped", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Repair the build" })).task;
  assert.equal((await engine.fail({ taskId: task.id, error: "  " })).code, "error_required");

  const failed = await engine.fail({ taskId: task.id, error: "gradle failed" });
  assert.equal(failed.task.status, "failed");
  assert.equal(failed.task.error, "gradle failed");

  const first = await engine.retry({ taskId: task.id });
  assert.equal(first.task.status, "queued");
  assert.equal(first.attempts, 1);
  await engine.fail({ taskId: task.id, error: "gradle failed again" });
  const second = await engine.retry({ taskId: task.id });
  assert.equal(second.attempts, 2);
  await engine.fail({ taskId: task.id, error: "still failing" });
  const third = await engine.retry({ taskId: task.id });
  assert.equal(third.ok, false);
  assert.equal(third.code, "attempt_limit_reached");
});

test("a plan cannot borrow another role's tool or name an unknown one", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Commit the fix", role: "nexus" })).task;
  const wrongRole = await engine.plan({ taskId: task.id, steps: [{ step: "spend", role: "orion", tool: "payment.spend" }] });
  assert.equal(wrongRole.code, "role_not_allowed");
  const unknownTool = await engine.plan({ taskId: task.id, steps: [{ step: "x", role: "nexus", tool: "nope.tool" }] });
  assert.equal(unknownTool.code, "unknown_tool");
  const emptyPlan = await engine.plan({ taskId: task.id, steps: [] });
  assert.equal(emptyPlan.code, "invalid_plan");
});

test("tasks are readable from a fresh engine over the same store", async () => {
  const { repository, registry, engine } = setup();
  const task = (await engine.submit({ objective: "Persist this objective" })).task;
  await engine.complete({ taskId: task.id, result: { summary: "stored", evidence: ["commit:abc"] } });
  const restarted = createUniversalCommandEngine({ repository, registry });
  const listed = await restarted.list({ status: "done" });
  assert.equal(listed.count, 1);
  assert.equal(listed.tasks[0].id, task.id);
  assert.equal(listed.tasks[0].status, "done");
});

test("legacy worker statuses normalize without pretending to be new work", () => {
  assert.equal(normalizeState("planned"), "queued");
  assert.equal(normalizeState("delegated"), "working");
  assert.equal(normalizeState("interrupted"), "failed");
  assert.equal(normalizeState("verified"), "done");
});

test("the role listing does not claim deployed agents", () => {
  const listing = describeRoles();
  assert.equal(listing.roles.length, 5);
  assert.deepEqual(listing.deployedAgents, []);
  assert.ok(listing.roles.every(role => role.deployed === false));
});

test("priority is persisted, defaults to zero, and is bounded", async () => {
  const { engine } = setup();
  const normal = await engine.submit({ objective: "Run the nightly health sweep" });
  assert.equal(normal.task.priority, 0, "an unspecified priority is an explicit 0, not missing");

  const urgent = await engine.submit({ objective: "Restore the staging database", priority: 100 });
  assert.equal(urgent.task.priority, 100);

  const numericString = await engine.submit({ objective: "Fix the pairing dialog", priority: "25" });
  assert.equal(numericString.task.priority, 25, "a numeric string from JSON clients is accepted");

  for (const bad of [-1, 101, 2.5, "high", {}]) {
    const refused = await engine.submit({ objective: "Whatever this is", priority: bad });
    assert.equal(refused.ok, false, "priority " + JSON.stringify(bad) + " is refused");
    assert.equal(refused.code, "invalid_priority");
  }
});

test("a high priority is an ordering hint only, not an authorization bypass", async () => {
  const { engine } = setup();
  const outcome = await engine.submit({ objective: "Publish the store listing", priority: 100 });
  // Still queued with no plan and no approval: the ordering hint bought nothing executable.
  assert.equal(outcome.task.status, "queued");
  assert.deepEqual(outcome.task.approvals, []);
  const planned = await engine.plan({ taskId: outcome.task.id, steps: [{ step: "Draft the listing copy", role: "ax" }] });
  assert.equal(planned.ok, true);
  assert.equal(planned.task.status !== "completed", true);
});
