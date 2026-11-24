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

const OWNER_ID = "owner-phone";
const OWNER_TOKEN = "owner-device-token";
const auth = { authorization: "Bearer ax-test-secret" };
const ownerAuth = {
  ...auth,
  "x-owner-device-id": OWNER_ID,
  "x-owner-device-token": OWNER_TOKEN
};
const ownerVerifier = async (token, deviceId) => token === OWNER_TOKEN && deviceId === OWNER_ID;

function mountTestApp(app, repository, extra = {}) {
  return registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" },
    repository, registry: registry(),
    verifyDevice: ownerVerifier, ownerDeviceId: OWNER_ID,
    ...extra
  });
}

test("registers the complete command route surface without duplicate paths", () => {
  const app = makeApp();
  mountTestApp(app, memoryRepository());
  const paths = [...app.routes.keys()];
  assert.equal(paths.length, 108, "the previous 105 plus POST /ax/missions, GET /ax/missions/:missionId and POST /ax/missions/:missionId/run");
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes("GET /ax/command/roles"));
  assert.ok(paths.includes("GET /ax/command/tools"));
  assert.ok(paths.includes("GET /ax/command/events"));
  assert.ok(paths.includes("POST /ax/command/messages"));
  assert.ok(paths.includes("GET /ax/command/messages/thread/:correlationId"));
  assert.ok(paths.includes("POST /ax/nexus/messages/:id/acknowledge"));
  assert.ok(paths.includes("GET /ax/command/presence"));
  assert.ok(paths.includes("GET /ax/command/openapi.json"));
  assert.ok(paths.includes("POST /ax/command/runs"));
  assert.ok(paths.includes("GET /ax/command/runs"));
  assert.ok(paths.includes("GET /ax/command/runs/:id"));
  assert.ok(paths.includes("POST /ax/command/tasks/:id/cancel"));
  assert.ok(paths.includes("POST /ax/command/tasks/:id/retry"));
  // Mission 09: memory, notifications, history, recovery, providers and diagnostics.
  for (const added of [
    "GET /ax/command/memory",
    "GET /ax/command/memory/stats",
    "GET /ax/command/memory/search",
    "GET /ax/command/memory/:project/:key",
    "GET /ax/command/memory/:project/:key/history",
    "POST /ax/command/memory",
    "POST /ax/command/memory/owner",
    "POST /ax/command/memory/:project/:key/delete",
    "POST /ax/command/memory/import/preview",
    "POST /ax/command/memory/import/apply",
    "GET /ax/command/notifications",
    "POST /ax/command/notifications/:id/ack",
    "GET /ax/command/history",
    "GET /ax/command/recovery",
    "GET /ax/command/providers",
    "GET /ax/command/diagnostics"
  ]) {
    assert.ok(paths.includes(added), "route " + added);
  }
});

test("rejects missing and incorrect Ax credentials before touching command storage", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  mountTestApp(app, repository);
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
  mountTestApp(app, repository);
  const result = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "Inspect status" } });
  assert.equal(result.statusCode, 503);
  assert.match(result.body.error, /storage is not ready/);
  assert.equal(repository.rows.size, 0);
});

test("authenticated role and tool descriptions are read-only and explicit", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  mountTestApp(app, repository);
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
  mountTestApp(app, repository);

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
    headers: ownerAuth, params: { id }, body: { result: { summary: "Health endpoint responded.", evidence: ["https://example.test/health"] } }
  });
  assert.equal(completed.body.task.status, "done");
  assert.equal(completed.body.task.result.verifiedBy, "owner:" + OWNER_ID);
});

test("approval, denial, failure and retry endpoints preserve the engine lifecycle", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  mountTestApp(app, repository);

  const submitted = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "Run a guarded operation" } });
  const id = submitted.body.task.id;

  const approval = await invoke(app, "POST /ax/command/tasks/:id/approval", {
    headers: auth, params: { id }, body: { reason: "Owner must authorize this operation.", action: "external_write" }
  });
  assert.equal(approval.body.task.status, "needs_approval");

  const denied = await invoke(app, "POST /ax/command/tasks/:id/deny", {
    headers: ownerAuth, params: { id }, body: { by: "caller-forged", reason: "Not approved." }
  });
  assert.equal(denied.body.task.status, "failed");
  assert.equal(denied.body.task.approvals.at(-1).decidedBy, "owner:" + OWNER_ID);

  const retry = await invoke(app, "POST /ax/command/tasks/:id/retry", { headers: ownerAuth, params: { id }, body: { by: "owner" } });
  assert.equal(retry.body.task.status, "queued");

  const failed = await invoke(app, "POST /ax/command/tasks/:id/fail", {
    headers: ownerAuth, params: { id }, body: { error: "The adapter is not configured." }
  });
  assert.equal(failed.body.task.status, "failed");

  const approvedTask = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "Request a separate approval" } });
  const approvedId = approvedTask.body.task.id;
  await invoke(app, "POST /ax/command/tasks/:id/approval", {
    headers: auth, params: { id: approvedId }, body: { reason: "Owner decision required." }
  });
  const approved = await invoke(app, "POST /ax/command/tasks/:id/approve", {
    headers: ownerAuth, params: { id: approvedId }, body: { by: "caller-forged" }
  });
  assert.equal(approved.body.task.status, "working");
  assert.equal(approved.body.task.approvals.at(-1).decidedBy, "owner:" + OWNER_ID);
});

test("an owner can cancel a queued task and it becomes terminal", async () => {
  const app = makeApp();
  mountTestApp(app, memoryRepository());
  const submitted = await invoke(app, "POST /ax/command/tasks", {
    headers: auth, body: { objective: "Cancel this safely" }
  });
  const id = submitted.body.task.id;
  const cancelled = await invoke(app, "POST /ax/command/tasks/:id/cancel", {
    headers: ownerAuth, params: { id }, body: { reason: "no longer needed" }
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.body.task.status, "cancelled");
  assert.equal(cancelled.body.task.cancelReason, "no longer needed");
  const late = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: ownerAuth, params: { id }, body: { result: { summary: "too late", evidence: ["x"] } }
  });
  assert.equal(late.statusCode, 409);
});

test("approve, deny, cancel and retry reject bridge-only, invalid and non-owner credentials", async () => {
  for (const action of ["approve", "deny", "cancel", "retry"]) {
    const app = makeApp();
    const repository = memoryRepository();
    mountTestApp(app, repository);
    const submitted = await invoke(app, "POST /ax/command/tasks", { headers: auth, body: { objective: "guarded " + action } });
    const id = submitted.body.task.id;
    await invoke(app, "POST /ax/command/tasks/:id/approval", { headers: auth, params: { id }, body: { reason: "owner decision" } });

    const bridgeOnly = await invoke(app, "POST /ax/command/tasks/:id/" + action, {
      headers: auth, params: { id }, body: { by: "owner" }
    });
    assert.equal(bridgeOnly.statusCode, 401, action + " must reject bridge-only callers");
    assert.equal(bridgeOnly.body.code, "owner_required");

    const badToken = await invoke(app, "POST /ax/command/tasks/:id/" + action, {
      headers: { ...auth, "x-owner-device-id": OWNER_ID, "x-owner-device-token": "wrong" },
      params: { id }, body: {}
    });
    assert.equal(badToken.statusCode, 401, action + " must reject an invalid device token");
    assert.equal(badToken.body.code, "owner_invalid");

    const nonOwner = await invoke(app, "POST /ax/command/tasks/:id/" + action, {
      headers: { ...auth, "x-owner-device-id": "other-owner", "x-owner-device-token": OWNER_TOKEN },
      params: { id }, body: {}
    });
    assert.equal(nonOwner.statusCode, 401, action + " non-owner token must not verify for another id");

    const stillPending = repository.rows.get(id);
    assert.equal(stillPending.status, "needs_approval", action + " must not change the task");
  }
});

test("unknown task and invalid transition errors use stable HTTP status codes", async () => {
  const app = makeApp();
  mountTestApp(app, memoryRepository());
  const missing = await invoke(app, "GET /ax/command/tasks/:id", { headers: auth, params: { id: "missing" } });
  assert.equal(missing.statusCode, 404);
  const invalid = await invoke(app, "POST /ax/command/tasks/:id/approve", { headers: ownerAuth, params: { id: "missing" }, body: {} });
  assert.equal(invalid.statusCode, 404);
});

// ---- route-level ownership gate (Ax decision) -----------------------------

function fencedRow(extra = {}) {
  const at = new Date().toISOString();
  return {
    id: "cmd_fenced", objective: "run a real operation", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: [],
    fence: "active-fence", claimedBy: "nexus-worker-1", leaseUntil: new Date(Date.now() + 600000).toISOString(),
    ...extra
  };
}

test("Ax routes cannot complete or fail a worker-owned task", async () => {
  for (const action of ["complete", "fail"]) {
    const app = makeApp();
    const repository = memoryRepository();
    repository.rows.set("cmd_fenced", fencedRow());
    mountTestApp(app, repository);
    const res = await invoke(app, "POST /ax/command/tasks/:id/" + action, {
      headers: ownerAuth, params: { id: "cmd_fenced" },
      body: action === "complete"
        ? { result: { summary: "Ax says done", evidence: ["x"] } }
        : { error: "Ax says failed" }
    });
    assert.equal(res.statusCode, 409, action + " must be refused");
    assert.equal(res.body.code, "task_owned_by_worker");
    assert.match(res.body.error, /fenced worker execution path/);
    const stored = repository.rows.get("cmd_fenced");
    assert.equal(stored.status, "working", "the task was not modified");
    assert.equal(stored.fence, "active-fence");
    assert.equal(stored.result ?? null, null);
    assert.equal(stored.error ?? null, null);
  }
});

test("supplying a matching claim to the Ax route does not bypass the ownership gate", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  repository.rows.set("cmd_fenced", fencedRow());
  mountTestApp(app, repository);
  const res = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: ownerAuth, params: { id: "cmd_fenced" },
    body: {
      claim: { fence: "active-fence", workerId: "nexus-worker-1" },
      result: { summary: "pretend worker", evidence: ["x"] }
    }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(repository.rows.get("cmd_fenced").status, "working");
});

test("an owner can still close a legacy task that has no fence", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  const at = new Date().toISOString();
  repository.rows.set("cmd_legacy", {
    id: "cmd_legacy", objective: "old task", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
  });
  mountTestApp(app, repository);
  const res = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: ownerAuth, params: { id: "cmd_legacy" },
    body: { result: { summary: "closed manually", evidence: ["note"] } }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(repository.rows.get("cmd_legacy").status, "done");
});

test("manual close-out without a valid owner device is rejected", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  const at = new Date().toISOString();
  repository.rows.set("cmd_manual", {
    id: "cmd_manual", objective: "old task", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
  });
  // Accepts any valid paired device token, so this test isolates the owner check from credential validity.
  mountTestApp(app, repository, { verifyDevice: async token => token === OWNER_TOKEN });

  const bridgeOnly = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: { authorization: "Bearer ax-test-secret" }, params: { id: "cmd_manual" },
    body: { result: { summary: "no device proof", evidence: ["x"] } }
  });
  assert.equal(bridgeOnly.statusCode, 401);
  assert.equal(bridgeOnly.body.code, "owner_required");

  const badToken = await invoke(app, "POST /ax/command/tasks/:id/fail", {
    headers: { authorization: "Bearer ax-test-secret", "x-owner-device-id": OWNER_ID, "x-owner-device-token": "wrong" },
    params: { id: "cmd_manual" }, body: { error: "nope" }
  });
  assert.equal(badToken.statusCode, 401);
  assert.equal(badToken.body.code, "owner_invalid");

  const nonOwner = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: { authorization: "Bearer ax-test-secret", "x-owner-device-id": "other-phone", "x-owner-device-token": OWNER_TOKEN },
    params: { id: "cmd_manual" }, body: { result: { summary: "not owner", evidence: ["x"] } }
  });
  assert.equal(nonOwner.statusCode, 403);
  assert.equal(repository.rows.get("cmd_manual").status, "working", "nothing was modified");
});

test("manual close-out fails closed when no device verifier is configured", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  const at = new Date().toISOString();
  repository.rows.set("cmd_noverify", {
    id: "cmd_noverify", objective: "x", status: "working", createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
  });
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" },
    repository, registry: registry(), ownerDeviceId: OWNER_ID
  });
  const res = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: ownerAuth, params: { id: "cmd_noverify" },
    body: { result: { summary: "should not work", evidence: ["x"] } }
  });
  assert.equal(res.statusCode, 503);
  assert.equal(repository.rows.get("cmd_noverify").status, "working");
});

test("a verified device with no configured owner is a 503 misconfiguration, not a 403 decision", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  const at = new Date().toISOString();
  repository.rows.set("cmd_noowner", {
    id: "cmd_noowner", objective: "x", status: "working", createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
  });
  // The device credential is valid, but HABITAT_OWNER_DEVICE_ID(S) is unset on this process.
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "ax-test-secret" },
    repository, registry: registry(), verifyDevice: ownerVerifier
  });
  const res = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: ownerAuth, params: { id: "cmd_noowner" },
    body: { result: { summary: "should not work", evidence: ["x"] } }
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "owner_unconfigured");
  assert.match(res.body.error, /HABITAT_OWNER_DEVICE_IDS/);
  assert.equal(repository.rows.get("cmd_noowner").status, "working", "nothing was modified");
});

test("Ax routes cannot plan, checkpoint or request approval on a worker-owned task", async () => {
  const cases = [
    ["plan", { steps: [{ step: "hijack", role: "ax" }] }],
    ["checkpoint", { note: "hijack" }],
    ["approval", { reason: "hijack" }]
  ];
  for (const [action, body] of cases) {
    const app = makeApp();
    const repository = memoryRepository();
    repository.rows.set("cmd_fenced", fencedRow());
    mountTestApp(app, repository);
    const res = await invoke(app, "POST /ax/command/tasks/:id/" + action, {
      headers: auth, params: { id: "cmd_fenced" }, body
    });
    assert.equal(res.statusCode, 409, action + " must be refused");
    assert.equal(res.body.code, "task_owned_by_worker");
    const stored = repository.rows.get("cmd_fenced");
    assert.equal(stored.status, "working");
    assert.equal(stored.plan, undefined);
    assert.equal(stored.checkpoints, undefined);
    assert.equal(stored.approvals.length, 0);
  }
});

test("the task route carries owner priority into the queue and refuses an out-of-range value", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  mountTestApp(app, repository);

  const submitted = await invoke(app, "POST /ax/command/tasks", {
    headers: auth,
    body: { objective: "Repair the staging bridge", priority: 40, idempotencyKey: "priority-route-1" }
  });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.body.task.priority, 40, "priority survives the route, not just the engine");
  assert.equal(repository.rows.get(submitted.body.task.id).priority, 40, "and is what was persisted");

  const rejected = await invoke(app, "POST /ax/command/tasks", {
    headers: auth,
    body: { objective: "Repair the staging bridge", priority: 500, idempotencyKey: "priority-route-2" }
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.code, "invalid_priority");
  assert.equal(repository.rows.size, 1, "the refused task was never stored");
});

test("the task route accepts planner signals and derives a suggested priority", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  mountTestApp(app, repository);

  const derived = await invoke(app, "POST /ax/command/tasks", {
    headers: auth,
    body: {
      objective: "Repair the staging command path",
      idempotencyKey: "signals-route-1",
      signals: { urgency: "critical", impact: "critical" }
    }
  });
  assert.equal(derived.statusCode, 201);
  assert.equal(derived.body.task.priority, 60, "40 urgency + 20 impact, with no deadline");
  assert.equal(derived.body.task.prioritySource, "derived");

  const explicit = await invoke(app, "POST /ax/command/tasks", {
    headers: auth,
    body: { objective: "Repair the staging command path", idempotencyKey: "signals-route-2", priority: 3, signals: { urgency: "critical" } }
  });
  assert.equal(explicit.body.task.priority, 3, "an explicit priority wins over signals");
  assert.equal(explicit.body.task.prioritySource, "owner");
});
