import test from "node:test";
import assert from "node:assert/strict";
import { createUniversalCommandEngine, normalizeState, TASK_STATES } from "../universal-command-engine.mjs";

function memoryRepository() {
  const rows = new Map();
  return {
    rows,
    async initialize() {},
    async create(task) { rows.set(task.id, structuredClone(task)); return structuredClone(task); },
    async get(id) { const value = rows.get(id); return value ? structuredClone(value) : null; },
    async update(id, task) { rows.set(id, structuredClone(task)); return structuredClone(task); },
    async list({ status = null, limit = 50 } = {}) {
      return [...rows.values()]
        .filter(task => !status || normalizeState(task.status) === status)
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)))
        .map(task => structuredClone(task));
    }
  };
}

function registry() {
  const tools = new Map([
    ["system.health", { name: "system.health", roles: ["ax"], availability: { state: "available", detail: "local" } }],
    ["publish.external", { name: "publish.external", roles: ["ax"], availability: { state: "unconfigured", detail: "not configured" } }]
  ]);
  return {
    get(name) { return tools.get(name) || null; },
    approvalRequiredFor(name) {
      return name === "publish.external"
        ? { required: true, reason: "External publishing requires owner approval." }
        : { required: false, known: true };
    }
  };
}

function setup(options = {}) {
  let tick = 0;
  const repository = options.repository || memoryRepository();
  const engine = createUniversalCommandEngine({
    repository,
    registry: options.registry || registry(),
    now: () => new Date(Date.UTC(2026, 10, 21, 0, 0, tick++)).toISOString(),
    newId: () => "cmd_test_" + tick
  });
  return { engine, repository };
}

test("engine exposes the documented finite lifecycle and normalizes legacy states", () => {
  assert.deepEqual(TASK_STATES, ["queued", "working", "needs_approval", "done", "failed"]);
  assert.equal(normalizeState("completed"), "done");
  assert.equal(normalizeState("running"), "working");
  assert.equal(normalizeState("unknown"), "queued");
});

test("engine requires a repository and registry", () => {
  assert.throws(() => createUniversalCommandEngine(), /task repository/);
  assert.throws(() => createUniversalCommandEngine({ repository: memoryRepository() }), /tool registry/);
});

test("submit validates objective and role before writing", async () => {
  const { engine, repository } = setup();
  assert.equal((await engine.submit({ objective: "  " })).code, "invalid_objective");
  assert.equal((await engine.submit({ objective: "Do a task", role: "ghost" })).code, "unknown_role");
  assert.equal(repository.rows.size, 0);
});

test("submit creates a queued task with a stable idempotency key", async () => {
  const { engine, repository } = setup();
  const first = await engine.submit({ objective: "Inspect the service", idempotencyKey: "same-request" });
  const replay = await engine.submit({ objective: "A different objective", idempotencyKey: "same-request" });
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(first.task.status, "queued");
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(repository.rows.size, 1);
});

test("submit rejects objectives outside the documented length bounds", async () => {
  const { engine } = setup();
  assert.equal((await engine.submit({ objective: "ab" })).code, "invalid_objective");
  assert.equal((await engine.submit({ objective: "x".repeat(2001) })).code, "invalid_objective");
});

test("plan rejects empty, oversized, unknown-role, unknown-tool and disallowed-tool plans", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Validate a plan" })).task;
  assert.equal((await engine.plan({ taskId: task.id, steps: [] })).code, "invalid_plan");
  assert.equal((await engine.plan({ taskId: task.id, steps: Array.from({ length: 21 }, () => ({ step: "x" })) })).code, "invalid_plan");
  assert.equal((await engine.plan({ taskId: task.id, steps: [{ step: "x", role: "ghost" }] })).code, "unknown_role");
  assert.equal((await engine.plan({ taskId: task.id, steps: [{ step: "x", tool: "missing" }] })).code, "unknown_tool");
  assert.equal((await engine.plan({ taskId: task.id, steps: [{ step: "x", role: "nexus", tool: "system.health" }] })).code, "role_not_allowed");
});

test("plan records unconfigured tool warnings without claiming execution", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Inspect readiness" })).task;
  const result = await engine.plan({ taskId: task.id, steps: [{ step: "Check relay", tool: "publish.external" }] });
  assert.equal(result.ok, true);
  assert.equal(result.task.status, "needs_approval");
  assert.equal(result.task.plan[0].toolAvailability, "unconfigured");
  assert.ok(result.warnings.some(value => value.includes("unconfigured")));
  assert.equal(result.approvalRequired, true);
});

test("approval gates completion until owner approval and records the decision", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Publish an update" })).task;
  await engine.plan({ taskId: task.id, steps: [{ step: "Publish", tool: "publish.external" }] });
  assert.equal((await engine.complete({ taskId: task.id, result: { summary: "Published", evidence: ["https://example.com"] } })).code, "approval_pending");
  const approved = await engine.approve({ taskId: task.id, by: "owner" });
  assert.equal(approved.ok, true);
  assert.equal(approved.task.status, "working");
  assert.equal(approved.task.approvals.at(-1).state, "approved");
});

test("denying approval fails the task and prevents a second decision", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Run a gated operation" })).task;
  await engine.requestApproval({ taskId: task.id, reason: "This changes production." });
  const denied = await engine.deny({ taskId: task.id, by: "owner", reason: "Not authorized." });
  assert.equal(denied.ok, true);
  assert.equal(denied.task.status, "failed");
  assert.match(denied.task.error, /Denied by owner/);
  assert.equal((await engine.approve({ taskId: task.id })).code, "invalid_transition");
});

test("completion requires a meaningful summary and at least one evidence item", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Read a public status page" })).task;
  await engine.plan({ taskId: task.id, steps: [{ step: "Read status" }] });
  assert.equal((await engine.complete({ taskId: task.id, result: { summary: "ok" } })).code, "evidence_required");
  assert.equal((await engine.complete({ taskId: task.id, result: { summary: "  ", evidence: ["url"] } })).code, "result_required");
  const done = await engine.complete({ taskId: task.id, result: { summary: "Status page checked.", evidence: ["https://example.com/status"] } });
  assert.equal(done.ok, true);
  assert.equal(done.task.status, "done");
  assert.equal(done.task.result.evidence.length, 1);
  assert.equal((await engine.complete({ taskId: task.id, result: { summary: "Again", evidence: ["commit"] } })).code, "invalid_transition");
});

test("checkpoint requires a note and stores bounded history", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Record a checkpoint" })).task;
  assert.equal((await engine.checkpoint({ taskId: task.id, note: " " })).code, "invalid_checkpoint");
  const result = await engine.checkpoint({ taskId: task.id, note: "Reviewed the source." });
  assert.equal(result.ok, true);
  assert.equal(result.task.checkpoints.at(-1).note, "Reviewed the source.");
});

test("fail requires a reason and retry is capped", async () => {
  const { engine } = setup();
  const task = (await engine.submit({ objective: "Test bounded retry" })).task;
  assert.equal((await engine.fail({ taskId: task.id, error: " " })).code, "error_required");
  await engine.fail({ taskId: task.id, error: "Transient error" });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const retried = await engine.retry({ taskId: task.id });
    assert.equal(retried.ok, true);
    assert.equal(retried.task.status, "queued");
    if (attempt < 3) await engine.fail({ taskId: task.id, error: "Still failing" });
  }
  await engine.fail({ taskId: task.id, error: "Final failure" });
  assert.equal((await engine.retry({ taskId: task.id })).code, "attempt_limit_reached");
});

test("get, list filters, and not-found results are explicit", async () => {
  const { engine } = setup();
  const first = (await engine.submit({ objective: "First task" })).task;
  await engine.submit({ objective: "Second task" });
  assert.equal((await engine.get("missing")).code, "not_found");
  assert.equal((await engine.get(first.id)).task.id, first.id);
  assert.equal((await engine.list({ status: "queued" })).count, 2);
  assert.equal((await engine.list({ status: "done" })).count, 0);
});
