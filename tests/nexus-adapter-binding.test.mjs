import test from "node:test";
import assert from "node:assert/strict";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createNexusWorker, NEXUS_CLAIM_SQL } from "../nexus-runtime.mjs";
import { buildReadOnlyNexusAdapters } from "../nexus-adapter-registration.mjs";

const AX_TOKEN = "ax-test-secret";
const AUTH = { authorization: "Bearer " + AX_TOKEN };
const OWNER_ID = "owner-phone";
const OWNER_TOKEN = "owner-device-token";
const OWNER_AUTH = {
  ...AUTH,
  "x-owner-device-id": OWNER_ID,
  "x-owner-device-token": OWNER_TOKEN
};

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function recorder() {
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
  const res = recorder();
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function memoryRepository() {
  const rows = new Map();
  return {
    rows,
    async initialize() {},
    async create(task) { rows.set(task.id, structuredClone(task)); return structuredClone(task); },
    async get(id) { const task = rows.get(id); return task ? structuredClone(task) : null; },
    async update(id, patch) {
      const current = rows.get(id);
      if (!current) return null;
      const next = { ...current, ...structuredClone(patch) };
      rows.set(id, next);
      return structuredClone(next);
    },
    async transition(id, { expect, next }) {
      const current = rows.get(id);
      if (!current) return null;
      if (expect?.status && current.status !== expect.status) return null;
      if (expect?.fence && current.fence !== expect.fence) return null;
      if (expect?.claimedBy && current.claimedBy !== expect.claimedBy) return null;
      const stored = { ...current, ...structuredClone(next) };
      rows.set(id, stored);
      return structuredClone(stored);
    },
    async list() { return [...rows.values()].map(row => structuredClone(row)); }
  };
}

function registry() {
  return {
    get(name) { return { name, roles: ["ax"], availability: { state: "available", detail: "test" } }; },
    approvalRequiredFor() { return { required: false, known: true }; },
    summary() { return { ok: true, count: 0, tools: [] }; }
  };
}

function mount(repository, extra = {}) {
  const app = makeApp();
  const mounted = registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository, registry: registry(),
    verifyDevice: async (token, deviceId) => token === OWNER_TOKEN && deviceId === OWNER_ID,
    ownerDeviceId: OWNER_ID,
    ...extra
  });
  return { app, mounted };
}

function runtimeQuery(repository) {
  return async (sql, params = []) => {
    if (sql === NEXUS_CLAIM_SQL) {
      const queued = [...repository.rows.values()].find(task => task.status === "queued");
      if (!queued) return [{ results: [] }];
      queued.status = "working";
      queued.claimedBy = params[0];
      queued.fence = params[2];
      queued.leaseUntil = params[1];
      return [{ results: [{ record_json: JSON.stringify(queued) }] }];
    }
    if (/SELECT worker_id, heartbeat_at, state, claimed, completed, failed FROM habitat_nexus_workers/.test(sql)) {
      return [{ results: [{ worker_id: "nexus-binding", heartbeat_at: new Date().toISOString(), state: "idle", claimed: 1, completed: 0, failed: 0 }] }];
    }
    if (/COUNT\(\*\) AS n FROM habitat_command_tasks WHERE status = 'working'/.test(sql)) {
      return [{ results: [{ n: [...repository.rows.values()].filter(task => task.status === "working").length }] }];
    }
    return [{ results: [] }];
  };
}

async function submit(app, body) {
  return invoke(app, "POST /ax/command/tasks", { headers: AUTH, body });
}

for (const adapter of ["repo.inspect", "task.inspect", "runtime.health"]) {
  test("submission binds the allowlisted adapter " + adapter, async () => {
    const repository = memoryRepository();
    const { app } = mount(repository);
    const res = await submit(app, { objective: "bind " + adapter, adapter });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.task.adapter, adapter);
    assert.equal((await repository.get(res.body.task.id)).adapter, adapter);
  });
}

test("unknown, malformed and non-string adapters are rejected without a task", async () => {
  const repository = memoryRepository();
  const { app } = mount(repository);
  for (const adapter of ["shell.exec", "repo.test", "RUNTIME.HEALTH", "", " runtime.health", 42, ["runtime.health"]]) {
    const res = await submit(app, { objective: "must reject adapter", adapter });
    assert.equal(res.statusCode, 400, "rejected: " + JSON.stringify(adapter));
    assert.equal(res.body.code, "adapter_not_allowed");
  }
  assert.equal(repository.rows.size, 0);
});

test("unauthenticated submission is refused before adapter handling", async () => {
  const repository = memoryRepository();
  const { app } = mount(repository);
  const res = await invoke(app, "POST /ax/command/tasks", { headers: {}, body: { objective: "no auth", adapter: "runtime.health" } });
  assert.equal(res.statusCode, 401);
  assert.equal(repository.rows.size, 0);
});

test("a bound runtime.health task is claimed and executed by the real worker", async () => {
  const repository = memoryRepository();
  const { app, mounted } = mount(repository);
  const submitted = await submit(app, { objective: "real runtime health", adapter: "runtime.health" });
  assert.equal(submitted.statusCode, 201);

  const query = runtimeQuery(repository);
  const adapters = buildReadOnlyNexusAdapters({
    rootDir: process.cwd(), allowedPrefixes: ["tests"], taskRepository: repository, d1Query: query
  });
  const worker = createNexusWorker({ repository, engine: mounted.engine, query, adapters, pollMs: 60_000 });
  await worker.tick();

  const stored = await repository.get(submitted.body.task.id);
  assert.equal(stored.status, "done");
  assert.equal(stored.adapter, "runtime.health");
  assert.ok(stored.result.evidence.some(line => /^runtime:workers=1:live=1/.test(line)));
  const read = await invoke(app, "GET /ax/command/tasks/:id", { headers: AUTH, params: { id: stored.id } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.task.result.evidence[0].startsWith("runtime:"), true);
});

test("manual completion cannot bypass worker fencing", async () => {
  const repository = memoryRepository();
  const { app } = mount(repository);
  const submitted = await submit(app, { objective: "fenced task", adapter: "runtime.health" });
  const id = submitted.body.task.id;
  // Simulate the worker claim: fenced, owned record.
  const row = repository.rows.get(id);
  row.status = "working";
  row.claimedBy = "nexus-worker";
  row.fence = "fence-live";
  repository.rows.set(id, row);

  const manual = await invoke(app, "POST /ax/command/tasks/:id/complete", {
    headers: OWNER_AUTH, params: { id }, body: { result: { summary: "forged", evidence: ["forged"] } }
  });
  assert.equal(manual.statusCode, 409);
  const stored = await repository.get(id);
  assert.equal(stored.status, "working");
  assert.equal(stored.result, null);
});

test("stale worker completion is rejected by the fence", async () => {
  const repository = memoryRepository();
  const { app, mounted } = mount(repository);
  const submitted = await submit(app, { objective: "stale fence", adapter: "runtime.health" });
  const id = submitted.body.task.id;
  const row = repository.rows.get(id);
  row.status = "working";
  row.claimedBy = "worker-a";
  row.fence = "fence-a";
  repository.rows.set(id, row);

  const stale = await mounted.engine.complete({
    taskId: id,
    claim: { fence: "fence-old", workerId: "worker-a" },
    verifiedBy: "worker-a",
    result: { summary: "stale result", evidence: ["stale"] }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale_claim");
  assert.equal((await repository.get(id)).status, "working");
});

test("idempotent retries return the same bound task without duplicates", async () => {
  const repository = memoryRepository();
  const { app } = mount(repository);
  const first = await submit(app, { objective: "retry me", adapter: "runtime.health", idempotencyKey: "ax:request-123" });
  const second = await submit(app, { objective: "retry me", adapter: "runtime.health", idempotencyKey: "ax:request-123" });
  assert.equal(first.statusCode, 201);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.task.id, first.body.task.id);
  assert.equal(repository.rows.size, 1);
  assert.equal((await repository.get(first.body.task.id)).adapter, "runtime.health");
});

test("worker completion cannot attach an adapter through its result payload", async () => {
  const repository = memoryRepository();
  const { app, mounted } = mount(repository);
  const submitted = await submit(app, { objective: "no adapter injection", adapter: "runtime.health" });
  const id = submitted.body.task.id;
  const row = repository.rows.get(id);
  row.status = "working";
  row.claimedBy = "worker-a";
  row.fence = "fence-a";
  repository.rows.set(id, row);

  const outcome = await mounted.engine.complete({
    taskId: id,
    claim: { fence: "fence-a", workerId: "worker-a" },
    verifiedBy: "worker-a",
    result: { summary: "done", evidence: ["e"], adapter: "shell.exec" }
  });
  assert.equal(outcome.ok, true);
  assert.equal((await repository.get(id)).adapter, "runtime.health");
});
