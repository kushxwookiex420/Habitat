import test from "node:test";
import assert from "node:assert/strict";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "registered route: " + key);
  const res = responseRecorder();
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function memoryRepository({ failInitialize = false } = {}) {
  const rows = new Map();
  let initialized = 0;
  return {
    rows,
    get initialized() { return initialized; },
    async initialize() {
      initialized += 1;
      if (failInitialize) throw new Error("synthetic D1 initialization failure");
    },
    async create(task) { rows.set(task.id, structuredClone(task)); return structuredClone(task); },
    async get(id) { const task = rows.get(id); return task ? structuredClone(task) : null; },
    async update(id, task) { rows.set(id, structuredClone(task)); return structuredClone(task); },
    async list({ status = null, limit = 50 } = {}) {
      return [...rows.values()]
        .filter(task => !status || task.status === status)
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)))
        .map(task => structuredClone(task));
    }
  };
}

function registry() {
  return {
    get(name) {
      if (name !== "system.health") return null;
      return { name, roles: ["ax"], availability: { state: "available", detail: "local" } };
    },
    approvalRequiredFor() { return { required: false, known: true }; },
    summary() { return { ok: true, count: 1, tools: [{ name: "system.health" }] }; }
  };
}

const auth = { authorization: "Bearer ax-test-secret" };

test("registers the complete command route surface without duplicate paths", () => {
  const app = makeApp();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, repository: memoryRepository(), registry: registry() });
  const paths = [...app.routes.keys()];
  assert.equal(paths.length, 13);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes("GET /ax/command/roles"));
  assert.ok(paths.includes("GET /ax/command/tools"));
  assert.ok(paths.includes("POST /ax/command/tasks/:id/retry"));
});

test("rejects missing and incorrect Ax credentials before touching command storage", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, repository, registry: registry() });
  const missing = await invoke(app, "GET /ax/command/roles", { headers: {} });
  const wrong = await invoke(app, "GET /ax/command/tools", { headers: { authorization: "Bearer wrong" } });
  assert.equal(missing.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(repository.initialized, 0);
});

test("reports missing Ax credential as 503 without exposing a credential value", async () => {
  const app = makeApp();
  registerUniversalCommandRoutes(app, { env: {}, repository: memoryRepository(), registry: registry() });
  const result = await invoke(app, "GET /ax/command/roles", { headers: {} });
  assert.equal(result.statusCode, 503);
  assert.match(result.body.error, /HABITAT_AX_BRIDGE_TOKEN/);
  assert.equal(JSON.stringify(result.body).includes("ax-test-secret"), false);
});

test("reports missing command storage as 503 for stateful routes", async () => {
  const app = makeApp();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, registry: registry() });
  const result = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "Inspect status" } });
  assert.equal(result.statusCode, 503);
  assert.match(result.body.error, /command store/);
});

test("reports D1 initialization failure as 503 and does not continue into the engine", async () => {
  const app = makeApp();
  const repository = memoryRepository({ failInitialize: true });
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, repository, registry: registry() });
  const result = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "Inspect status" } });
  assert.equal(result.statusCode, 503);
  assert.match(result.body.error, /storage is not ready/);
  assert.equal(repository.rows.size, 0);
});

test("authenticated role and tool descriptions are read-only and explicit", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, repository, registry: registry() });
  const roles = await invoke(app, "GET /ax/command/roles", { headers: auth });
  const tools = await invoke(app, "GET /ax/command/tools", { headers: auth });
  assert.equal(roles.statusCode, 200);
  assert.equal(roles.body.deployedAgents.length, 0);
  assert.ok(roles.body.roles.every(role => role.deployed === false));
  assert.equal(tools.statusCode, 200);
  assert.equal(tools.body.tools[0].name, "system.health");
  assert.equal(repository.initialized, 0);
});

test("authenticated owner can submit, read, plan, checkpoint and complete with evidence", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, repository, registry: registry() });

  const submitted = await invoke(app, "POST /ax/command/tasks", {
    headers: auth,
    body: { objective: "Inspect Habitat health", idempotencyKey: "route-test-001" }
  });
  assert.equal(submitted.statusCode, 201);
  const id = submitted.body.task.id;
  assert.equal(submitted.body.task.status, "queued");

  const replay = await invoke(app, "POST /ax/command/tasks", {
    headers: auth,
    body: { objective: "Inspect Habitat health", idempotencyKey: "route-test-001" }
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.replayed, true);

  const listed = await invoke(app, "GET /ax/command/tasks", { headers: auth, query: { status: "queued" } });
  assert.equal(listed.body.count, 1);

  const read = await invoke(app, "GET /ax/command/tasks/:id", { headers: auth, params: { id } });
  assert.equal(read.body.task.id, id);

  const planned = await invoke(app, "POST /ax/command/tasks/:id/plan", {
    headers: auth, params: { id }, body: { steps: [{ step: "Read local health", tool: "system.health" }] }
  });
  assert.equal(planned.body.task.status, "working");

  const checkpoint = await invoke(app, "POST /ax/command/tasks/:id/checkpoint", {
    headers: auth, params: { id }, body: { note: "Health endpoint checked." }
  });
  assert.equal(checkpoint.body.task.checkpoints.at(-1).note, "Health endpoint checked.");

  const completed = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: auth, params: { id }, body: { result: { summary: "Health endpoint responded.", evidence: ["https://example.test/health"] } }
  });
  assert.equal(completed.body.task.status, "done");
});

test("approval, denial, failure and retry endpoints preserve the engine lifecycle", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, repository, registry: registry() });

  const submitted = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "Run a guarded operation" } });
  const id = submitted.body.task.id;

  const approval = await invoke(app, "POST /ax/command/tasks/:id/approval", {
    headers: auth, params: { id }, body: { reason: "Owner must authorize this operation.", action: "external_write" }
  });
  assert.equal(approval.body.task.status, "needs_approval");

  const denied = await invoke(app, "POST /ax/command/tasks/:id/deny", {
    headers: auth, params: { id }, body: { by: "owner", reason: "Not approved." }
  });
  assert.equal(denied.body.task.status, "failed");

  const retry = await invoke(app, "POST /ax/command/tasks/:id/retry", { headers: auth, params: { id }, body: { by: "owner" } });
  assert.equal(retry.body.task.status, "queued");

  const failed = await invoke(app, "POST /ax/command/tasks/:id/fail", {
    headers: auth, params: { id }, body: { error: "The adapter is not configured." }
  });
  assert.equal(failed.body.task.status, "failed");

  const approvedTask = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "Request a separate approval" } });
  const approvedId = approvedTask.body.task.id;
  await invoke(app, "POST /ax/command/tasks/:id/approval", {
    headers: auth, params: { id: approvedId }, body: { reason: "Owner decision required." }
  });
  const approved = await invoke(app, "POST /ax/command/tasks/:id/approve", {
    headers: auth, params: { id: approvedId }, body: { by: "owner" }
  });
  assert.equal(approved.body.task.status, "working");
});

test("unknown task and invalid transition errors use stable HTTP status codes", async () => {
  const app = makeApp();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" }, repository: memoryRepository(), registry: registry() });
  const missing = await invoke(app, "GET /ax/command/tasks/:id", { headers: auth, params: { id: "missing" } });
  assert.equal(missing.statusCode, 404);
  const invalid = await invoke(app, "POST /ax/command/tasks/:id/approve", { headers: auth, params: { id: "missing" }, body: {} });
  assert.equal(invalid.statusCode, 404);
});
