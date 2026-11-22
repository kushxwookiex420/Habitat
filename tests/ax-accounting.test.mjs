import test from "node:test";
import assert from "node:assert/strict";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";

const AX_TOKEN = "ax-accounting-secret";
const auth = { authorization: "Bearer " + AX_TOKEN };
const CRITERIA = ["The child run reports a cost", "The parent objective records that cost once"];

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function matchRoute(app, key) {
  if (app.routes.has(key)) return { handlers: app.routes.get(key), params: {} };
  const [method, path] = key.split(" ");
  const parts = path.split("/").filter(Boolean);
  for (const [registered, handlers] of app.routes) {
    const [registeredMethod, registeredPath] = registered.split(" ");
    if (registeredMethod !== method) continue;
    const expected = registeredPath.split("/").filter(Boolean);
    if (expected.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < parts.length; index += 1) {
      if (expected[index].startsWith(":")) params[expected[index].slice(1)] = decodeURIComponent(parts[index]);
      else if (expected[index] !== parts[index]) { matched = false; break; }
    }
    if (matched) return { handlers, params };
  }
  return null;
}

async function invoke(app, key, req = {}) {
  const matched = matchRoute(app, key);
  assert.ok(matched, "registered route: " + key);
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(key, value) { this.headers[key] = value; return this; }
  };
  const request = { headers: {}, query: {}, body: {}, ...req, params: { ...matched.params, ...(req.params || {}) } };
  for (const handler of matched.handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

async function startedObjective(service, { budgetUsd = 0.05, estimatedCostUsd = 0 } = {}) {
  const created = await service.create({ objective: "Account for a child run", criteria: CRITERIA, budgetUsd, key: "acct-" + Math.random() });
  const id = created.objective.id;
  await service.understand(id, { summary: "One child run, charged once." });
  await service.plan(id, { steps: [{ objective: "inspect", agent: "engineering" }], estimatedCostUsd });
  const started = await service.start(id);
  assert.equal(started.ok, true);
  return id;
}

test("independent child runs cannot jointly exceed the objective budget", async () => {
  const service = createObjectiveService({ repository: createMemoryObjectiveRepository() });
  const id = await startedObjective(service, { budgetUsd: 0.05 });
  const first = await service.reserveExecution(id, { executionId: "run-a", estimateUsd: 0.03 });
  assert.equal(first.ok, true);
  assert.equal(first.accounting.reservedUsd, 0.03);
  assert.equal(first.accounting.remainingUsd, 0.02);

  const second = await service.reserveExecution(id, { executionId: "run-b", estimateUsd: 0.03 });
  assert.equal(second.ok, false);
  assert.equal(second.code, "budget_exhausted");
  assert.equal(second.accounting.reservedUsd, 0.03, "a refused reservation changes nothing");

  const small = await service.reserveExecution(id, { executionId: "run-c", estimateUsd: 0.02 });
  assert.equal(small.ok, true);
  assert.equal(small.accounting.remainingUsd, 0);
  const refused = await service.reserveExecution(id, { executionId: "run-d", estimateUsd: 0.01 });
  assert.equal(refused.ok, false);
});

test("a reservation can be released without spending, and settled exactly once", async () => {
  const service = createObjectiveService({ repository: createMemoryObjectiveRepository() });
  const id = await startedObjective(service);
  await service.reserveExecution(id, { executionId: "run-a", estimateUsd: 0.03 });
  const released = await service.releaseExecution(id, { executionId: "run-a", reason: "run never started" });
  assert.equal(released.ok, true);
  assert.equal(released.accounting.reservedUsd, 0);
  assert.equal(released.accounting.spentUsd, 0);

  await service.reserveExecution(id, { executionId: "run-b", estimateUsd: 0.02 });
  const settled = await service.settleExecution(id, { executionId: "run-b", actualUsd: 0.012, runId: "run_b" });
  assert.equal(settled.ok, true);
  assert.equal(settled.accounting.spentUsd, 0.012);
  assert.equal(settled.accounting.reservedUsd, 0);
  const replay = await service.settleExecution(id, { executionId: "run-b", actualUsd: 0.012, runId: "run_b" });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.accounting.spentUsd, 0.012, "a retried settlement never charges twice");
  const objective = await service.get(id);
  assert.equal(objective.execution.tasks.length, 0);
  assert.equal(objective.accounting.executions.length, 2, "the released attempt stays as history; nothing is deleted");
  assert.equal(objective.accounting.executions.filter(item => item.status === "settled").length, 1);
});

test("two concurrent dispatches reserve once, share one run and charge once", async () => {
  const repository = createMemoryObjectiveRepository();
  const objectives = createObjectiveService({ repository });
  const calls = [];
  const orchestrator = {
    enabled: true,
    budgetUsd: 0.05,
    async runObjective(input) {
      calls.push(input);
      await new Promise(resolve => setTimeout(resolve, 5));
      return {
        ok: true,
        run: {
          id: "run_shared",
          objectiveId: input.objectiveId,
          objective: input.objective,
          costUsd: 0.01,
          steps: [{ index: 0, taskId: "task_1", agent: "engineering" }],
          evidence: ["suite exited 0"],
          status: "completed"
        }
      };
    }
  };
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository: {
      async initialize() { return { ok: true }; },
      async create(task) { return task; },
      async get() { return null; },
      async update(_id, task) { return task; },
      async list() { return []; }
    },
    registry: { get() { return null; }, approvalRequiredFor() { return { required: false, known: true }; }, summary() { return { ok: true, count: 0, tools: [] }; } },
    objectiveProvider: () => objectives,
    orchestratorProvider: () => orchestrator
  });

  const created = await invoke(app, "POST /ax/command/objectives", {
    headers: auth,
    body: { objective: "Dispatch concurrently", criteria: CRITERIA, budgetUsd: 0.05, key: "concurrent" }
  });
  const id = created.body.objective.id;
  await invoke(app, "POST /ax/command/objectives/" + id + "/understand", { headers: auth, body: { summary: "One run only." } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/plan", { headers: auth, body: { steps: [{ objective: "inspect", agent: "engineering" }] } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/start", { headers: auth });

  const [left, right] = await Promise.all([
    invoke(app, "POST /ax/command/objectives/" + id + "/dispatch", { headers: auth }),
    invoke(app, "POST /ax/command/objectives/" + id + "/dispatch", { headers: auth })
  ]);
  assert.equal(left.statusCode, 200);
  assert.equal(right.statusCode, 200);
  assert.equal(calls.every(call => call.objectiveId === id), true, "every dispatched run carries the immutable parent objective");
  const final = await invoke(app, "GET /ax/command/objectives/" + id, { headers: auth });
  assert.equal(final.body.accounting.spentUsd, 0.01, "one child run is charged once");
  assert.equal(final.body.accounting.executions.length, 1);
  assert.equal(final.body.accounting.executions[0].status, "settled");
  assert.equal(final.body.accounting.reservedUsd, 0);
});

test("overspend after settlement is recorded and blocks the objective, never hidden", async () => {
  const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository() });
  const orchestrator = {
    enabled: true,
    budgetUsd: 0.05,
    async runObjective(input) {
      return { ok: true, run: { id: "run_expensive", objectiveId: input.objectiveId, costUsd: 0.02, steps: [], evidence: [], status: "completed" } };
    }
  };
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository: { async initialize() { return { ok: true }; }, async create(t) { return t; }, async get() { return null; }, async update(_i, t) { return t; }, async list() { return []; } },
    registry: { get() { return null; }, approvalRequiredFor() { return { required: false, known: true }; }, summary() { return { ok: true, count: 0, tools: [] }; } },
    objectiveProvider: () => objectives,
    orchestratorProvider: () => orchestrator
  });
  const created = await invoke(app, "POST /ax/command/objectives", {
    headers: auth,
    body: { objective: "Overspend truthfully", criteria: CRITERIA, budgetUsd: 0.005, key: "overspend" }
  });
  const id = created.body.objective.id;
  await invoke(app, "POST /ax/command/objectives/" + id + "/understand", { headers: auth, body: { summary: "The run may cost more than the reservation." } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/plan", { headers: auth, body: { steps: [{ objective: "inspect", agent: "engineering" }] } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/start", { headers: auth });
  const dispatched = await invoke(app, "POST /ax/command/objectives/" + id + "/dispatch", { headers: auth });
  assert.equal(dispatched.statusCode, 200);
  assert.equal(dispatched.body.accounting.spentUsd, 0.02);
  assert.equal(dispatched.body.objective.status, "blocked");
  assert.equal(dispatched.body.objective.code, "budget_exhausted");
});

test("a dispatch that never produced a durable run releases its reservation", async () => {
  const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository() });
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository: { async initialize() { return { ok: true }; }, async create(t) { return t; }, async get() { return null; }, async update(_i, t) { return t; }, async list() { return []; } },
    registry: { get() { return null; }, approvalRequiredFor() { return { required: false, known: true }; }, summary() { return { ok: true, count: 0, tools: [] }; } },
    objectiveProvider: () => objectives,
    orchestratorProvider: () => ({ enabled: true, budgetUsd: 0.05, async runObjective() { return { ok: false, code: "store_unavailable", error: "run store down" }; } })
  });
  const created = await invoke(app, "POST /ax/command/objectives", {
    headers: auth,
    body: { objective: "Release a failed dispatch", criteria: CRITERIA, budgetUsd: 0.05, key: "release" }
  });
  const id = created.body.objective.id;
  await invoke(app, "POST /ax/command/objectives/" + id + "/understand", { headers: auth, body: { summary: "No run will exist." } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/plan", { headers: auth, body: { steps: [{ objective: "inspect", agent: "engineering" }] } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/start", { headers: auth });
  const dispatched = await invoke(app, "POST /ax/command/objectives/" + id + "/dispatch", { headers: auth });
  assert.equal(dispatched.statusCode, 503);
  const final = await invoke(app, "GET /ax/command/objectives/" + id, { headers: auth });
  assert.equal(final.body.accounting.spentUsd, 0);
  assert.equal(final.body.accounting.reservedUsd, 0);
  assert.equal(final.body.accounting.executions[0].status, "released");
});
