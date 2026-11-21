import test from "node:test";
import assert from "node:assert/strict";
import { createNexusWorker, registerNexusRuntime, createD1Query, NEXUS_CLAIM_SQL, NEXUS_EXPIRED_SQL } from "../nexus-runtime.mjs";
import { createUniversalCommandEngine } from "../universal-command-engine.mjs";

/**
 * Behaviour tests, not SQL-string tests. A single shared mini-D1 stands in for the database so two
 * workers can actually race each other, and the engine stub records the exact argument shapes the
 * real universal command engine requires (`fail({error})`, `complete({verifiedBy})`).
 *
 * NOT covered here: real Cloudflare D1 integration. That needs credentials and is untested.
 */

const DEVICE = "launcher-s26";
const DEVICE_TOKEN = "device_token_" + "t".repeat(30);
const AX_TOKEN = "ax_bridge_" + "a".repeat(40);

function miniD1() {
  const state = { tasks: new Map(), heartbeats: [] };
  let busy = false;
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    if (/^CREATE TABLE/.test(text)) return [{ results: [] }];
    if (text.startsWith("UPDATE habitat_command_tasks SET status = 'working'")) {
      // Atomic in the same sense as the SQL: the guard is re-checked when the row is taken.
      if (busy) return [{ results: [] }];
      busy = true;
      try {
        const claimable = task => (task.status === "queued" || (task.status === "working" && (task.fence ?? null) === null))
          && typeof task.adapter === "string" && task.adapter.length > 0;
        const candidate = [...state.tasks.values()]
          .filter(claimable)
          .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
        if (!candidate || !claimable(candidate)) return [{ results: [] }];
        candidate.status = "working";
        candidate.claimedBy = params[0];
        candidate.leaseUntil = params[1];
        candidate.fence = params[2];
        return [{ results: [{ record_json: JSON.stringify(candidate) }] }];
      } finally {
        busy = false;
      }
    }
    if (text.startsWith("UPDATE habitat_command_tasks SET status = 'queued'")) {
      // requeue: [attempts, at, at, id, fence]
      const [attempts, at, , id, fence] = params;
      const task = state.tasks.get(id);
      const ownsFence = Boolean(task) && task.status === "working" && (task.fence ?? null) === (fence ?? null);
      if (!ownsFence) return [{ results: [] }];
      Object.assign(task, { status: "queued", attempts, claimedBy: null, leaseUntil: null, fence: null, updatedAt: at });
      return [{ results: [{ id }] }];
    }
    if (text.startsWith("UPDATE habitat_command_tasks SET record_json = json_set")) {
      const ownsFence = (task, fence) => Boolean(task) && task.status === "working" && (task.fence ?? null) === (fence ?? null);
      if (text.includes("'$.claimedBy', ?")) {
        // seize: [workerId, fence, at, at, id, oldFence]
        const [workerId, fence, at, , id, oldFence] = params;
        const task = state.tasks.get(id);
        if (!ownsFence(task, oldFence)) return [{ results: [] }];
        Object.assign(task, { claimedBy: workerId, fence, updatedAt: at });
        return [{ results: [{ id }] }];
      }
      // renew: [leaseUntil, at, at, id, fence]
      const [leaseUntil, at, , id, fence] = params;
      const task = state.tasks.get(id);
      if (!ownsFence(task, fence)) return [{ results: [] }];
      Object.assign(task, { leaseUntil, updatedAt: at });
      return [{ results: [{ id }] }];
    }
    if (text.startsWith("SELECT id, record_json") && text.includes("leaseUntil")) {
      const at = params[0];
      const floor = params[1];
      const expired = [...state.tasks.values()]
        .filter(task => task.status === "working" && (
          (task.leaseUntil && task.leaseUntil < at) ||
          (!task.leaseUntil && String(task.updatedAt || task.updated_at || "") < floor)
        ))
        .slice(0, 10)
        .map(task => ({ id: task.id, record_json: JSON.stringify(task) }));
      return [{ results: expired }];
    }
    if (text.startsWith("INSERT INTO habitat_nexus_workers")) {
      state.heartbeats.push({ workerId: params[0], at: params[2], state: params[3], claimed: params[4], completed: params[5], failed: params[6] });
      return [{ results: [] }];
    }
    if (text.startsWith("SELECT worker_id")) {
      const latest = new Map();
      for (const beat of state.heartbeats) latest.set(beat.workerId, beat);
      return [{ results: [...latest.values()].map(beat => ({
        worker_id: beat.workerId, started_at: beat.at, heartbeat_at: beat.at, state: beat.state,
        claimed: beat.claimed, completed: beat.completed, failed: beat.failed, detail: null
      })) }];
    }
    throw new Error("unexpected SQL: " + text.slice(0, 70));
  };
  return { state, query };
}

function repositoryOver(d1) {
  const { state } = d1;
  return {
    durable: true,
    async initialize() { return { ok: true }; },
    async get(id) { const task = state.tasks.get(id); return task ? structuredClone(task) : null; },
    async create(task) { state.tasks.set(task.id, structuredClone(task)); return structuredClone(task); },
    async update(id, patch) {
      if (!state.tasks.has(id)) return null;
      state.tasks.set(id, { ...state.tasks.get(id), ...structuredClone(patch) });
      return structuredClone(state.tasks.get(id));
    },
    async list({ status, limit = 50 } = {}) {
      return [...state.tasks.values()].filter(task => !status || task.status === status).slice(0, limit).map(task => structuredClone(task));
    },
    /** Mirrors the D1 conditional UPDATE: one check-and-write, no window between them. */
    async transition(id, { expect, next } = {}) {
      const current = state.tasks.get(id);
      if (!current || current.status !== "working") return null;
      if (String(expect?.status || "working") !== "working") return null;
      if ((current.fence ?? null) !== (expect?.fence ?? null)) return null;
      if ((current.claimedBy ?? null) !== (expect?.claimedBy ?? null)) return null;
      state.tasks.set(id, structuredClone(next));
      return structuredClone(next);
    }
  };
}

/** Mirrors universal-command-engine.mjs argument shapes and persists what it is told. */
function engineOver(d1) {
  const { state } = d1;
  const calls = [];
  const patch = (taskId, changes) => {
    const task = state.tasks.get(taskId);
    if (!task) return null;
    state.tasks.set(taskId, { ...task, ...changes });
    return structuredClone(state.tasks.get(taskId));
  };
  return {
    calls,
    async complete(options) {
      calls.push({ method: "complete", options });
      assert.ok("verifiedBy" in options, "engine.complete requires verifiedBy");
      if (options.result.evidence.length === 0) return { ok: false, error: "evidence_required" };
      // The real engine writes verifiedBy into result; mirror that so the assertion is meaningful.
      const task = patch(options.taskId, {
        status: "done",
        result: { ...options.result, verifiedBy: options.verifiedBy, completedAt: "2026-11-21T00:10:00.000Z" },
        error: null
      });
      return { ok: true, task };
    },
    async fail(options) {
      calls.push({ method: "fail", options });
      assert.ok("error" in options, "engine.fail requires an error field");
      assert.ok(!("reason" in options), "engine.fail does not take a reason field");
      const task = patch(options.taskId, { status: "failed", error: options.error });
      return { ok: true, task };
    },
    async approve(options) { calls.push({ method: "approve", options }); return { ok: true, task: patch(options.taskId, { status: "working" }) }; },
    async deny(options) { calls.push({ method: "deny", options }); return { ok: true, task: patch(options.taskId, { status: "failed" }) }; },
    async list({ status } = {}) {
      calls.push({ method: "list" });
      return { ok: true, tasks: [...state.tasks.values()].filter(task => !status || task.status === status).map(task => structuredClone(task)) };
    }
  };
}

function fakeRegistry() { return { get: id => ({ id, available: true }), summary: () => ({ tools: [] }) }; }

function makeApp() {
  const routes = new Map();
  const register = method => (path, ...handlers) => routes.set(method + " " + path, handlers);
  return { routes, get: register("GET"), post: register("POST"), use() {} };
}

function recorder() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function findRoute(app, method, path) {
  for (const [key, handlers] of app.routes) {
    const [routeMethod, routePath] = key.split(" ");
    if (routeMethod !== method) continue;
    const wanted = path.split("/"), pattern = routePath.split("/");
    if (wanted.length !== pattern.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i += 1) {
      if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = decodeURIComponent(wanted[i]);
      else if (pattern[i] !== wanted[i]) { matched = false; break; }
    }
    if (matched) return { handlers, params };
  }
  return null;
}

async function request(app, method, path, { headers = {}, body = {}, query = {}, params = {} } = {}) {
  const route = findRoute(app, method, path);
  assert.ok(route, "route exists: " + method + " " + path);
  const res = recorder();
  await route.handlers[route.handlers.length - 1]({ method, headers, body, query, params: { ...route.params, ...params } }, res);
  return res;
}

function task(id, extra = {}) {
  return { id, objective: "do the thing", status: "queued", role: "ax", createdAt: "2026-11-21T00:00:00.000Z", updatedAt: "2026-11-21T00:00:00.000Z", requestedBy: "ax", approvals: [], attempts: 0, ...extra };
}

const quiet = { log() {}, warn() {}, error() {} };

async function setup({ withVerifier = true, startWorker = false, owners = [DEVICE], verifier = null, engineOverride = null, adapters = TEST_ADAPTERS } = {}) {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = engineOver(d1);
  const app = makeApp();
  const verifyDevice = verifier || (withVerifier
    ? async (token, deviceId) => deviceId === DEVICE && token === DEVICE_TOKEN
    : null);
  const runtime = registerNexusRuntime(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository, registry: fakeRegistry(), query: d1.query, engine: engineOverride || engine,
    adapters, verifyDevice, ownerDeviceId: owners.join(","), handleSignals: false, log: quiet,
    // These doubles are deliberately not in the read-only set; the production mount keeps the
    // guard on and is covered by tests/nexus-autonomous-foundation.test.mjs.
    enforceReadOnlyAdapters: false
  });
  const init = await runtime.initialize({ startWorker });
  return { app, d1, repository, engine, runtime, init };
}

// Adapters belong to the caller in production; these test doubles stand in for real operations.
const TEST_ADAPTERS = {
  "task.ok": async task => ({ summary: "did " + task.id, evidence: ["evidence:" + task.id], decisions: [], blockers: [] }),
  "nexus.echo": async task => ({ summary: "Acknowledged: " + task.objective, evidence: ["nexus:echo/" + task.id] })
};

function seedOwned(d1, id, workerId, extra = {}) {
  const record = task(id, {
    status: "working",
    claimedBy: workerId,
    fence: "fence-" + id,
    leaseUntil: new Date(Date.now() + 600_000).toISOString(),
    ...extra
  });
  d1.state.tasks.set(id, record);
  return structuredClone(record);
}

function workerOn(d1, engine, overrides = {}) {
  return createNexusWorker({
    repository: repositoryOver(d1), engine, query: d1.query,
    adapters: { ...TEST_ADAPTERS },
    pollMs: 10_000, log: quiet, ...overrides
  });
}

// ---- 1. competing workers -------------------------------------------------

test("two competing workers cannot claim the same task from a shared store", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_a", task("cmd_a", { adapter: "runtime.health" }));
  d1.state.tasks.set("cmd_b", task("cmd_b", { adapter: "runtime.health", updatedAt: "2026-11-21T00:00:01.000Z" }));
  const one = workerOn(d1, engine, { workerId: "w1" });
  const two = workerOn(d1, engine, { workerId: "w2" });
  const [first, second] = await Promise.all([one.claim(), two.claim()]);
  const claimed = [first?.id, second?.id].filter(Boolean);
  assert.equal(new Set(claimed).size, claimed.length, "no task was claimed twice");
  assert.equal(claimed.length, 2, "both workers got different work");
  assert.equal([...d1.state.tasks.values()].filter(t => t.status === "working").length, 2);
});

test("when only one task exists, the second worker gets nothing", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_only", task("cmd_only", { adapter: "runtime.health" }));
  const one = workerOn(d1, engine, { workerId: "w1" });
  const two = workerOn(d1, engine, { workerId: "w2" });
  const [first, second] = await Promise.all([one.claim(), two.claim()]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

// ---- 2. device authentication --------------------------------------------

test("approvals require a valid paired-device credential", async () => {
  const { app, d1 } = await setup();
  d1.state.tasks.set("cmd_p", task("cmd_p", { status: "needs_approval", approvals: [{ state: "requested", requestedAt: "2026-11-21T00:03:00.000Z" }] }));

  const anonymous = await request(app, "GET", "/device/command/approvals", { query: { deviceId: DEVICE } });
  assert.equal(anonymous.statusCode, 401);
  const wrongToken = await request(app, "GET", "/device/command/approvals", { headers: { authorization: "Bearer nope" }, query: { deviceId: DEVICE } });
  assert.equal(wrongToken.statusCode, 401);
  const wrongDevice = await request(app, "GET", "/device/command/approvals", { headers: { authorization: "Bearer " + DEVICE_TOKEN }, query: { deviceId: "launcher-other" } });
  assert.equal(wrongDevice.statusCode, 401);

  const valid = await request(app, "GET", "/device/command/approvals", { headers: { authorization: "Bearer " + DEVICE_TOKEN }, query: { deviceId: DEVICE } });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body.count, 1);
  assert.equal(valid.body.approvals[0].taskId, "cmd_p");
});

test("without an injected device verifier the route refuses instead of trusting anyone", async () => {
  const { app } = await setup({ withVerifier: false });
  const res = await request(app, "GET", "/device/command/approvals", { headers: { authorization: "Bearer " + DEVICE_TOKEN }, query: { deviceId: DEVICE } });
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /Device verification is not configured/);
});

// ---- 3. Ax cannot approve ------------------------------------------------

test("the Ax bridge credential cannot approve or deny a device-protected task", async () => {
  const { app, d1, engine } = await setup();
  d1.state.tasks.set("cmd_ax", task("cmd_ax", { status: "needs_approval", approvals: [{ state: "requested" }] }));
  for (const approved of [true, false]) {
    const res = await request(app, "POST", "/device/command/tasks/cmd_ax/approval", {
      headers: { authorization: "Bearer " + AX_TOKEN },
      body: { deviceId: DEVICE, approved }, params: { id: "cmd_ax" }
    });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(engine.calls.some(call => call.method === "approve" || call.method === "deny"), false);
  assert.equal(d1.state.tasks.get("cmd_ax").status, "needs_approval");
});

// ---- 4 & 5. engine contract ---------------------------------------------

test("a failure persists the error text and the failed state", async () => {
  const { d1, engine } = await setup();
  const worker = workerOn(d1, engine, { workerId: "w-fail" });
  await worker.execute(seedOwned(d1, "cmd_f", "w-fail", { adapter: "does.not.exist" }));
  const fail = engine.calls.find(call => call.method === "fail");
  assert.ok(fail, "engine.fail was called");
  assert.match(fail.options.error, /No adapter/);
  assert.equal(d1.state.tasks.get("cmd_f").status, "failed");
  assert.match(d1.state.tasks.get("cmd_f").error, /No adapter/);
});

test("completion records the worker identity as verifiedBy", async () => {
  const { d1, engine } = await setup();
  const worker = workerOn(d1, engine, { workerId: "nexus-prod-1" });
  await worker.execute(seedOwned(d1, "cmd_c", "nexus-prod-1", { adapter: "task.ok" }));
  const complete = engine.calls.find(call => call.method === "complete");
  assert.ok(complete);
  assert.equal(complete.options.verifiedBy, "nexus-prod-1");
  assert.equal("by" in complete.options, false, "complete does not take by");
  assert.equal(d1.state.tasks.get("cmd_c").result.verifiedBy, "nexus-prod-1");
  assert.equal(d1.state.tasks.get("cmd_c").status, "done");
});

// ---- 6. retry limits -----------------------------------------------------

test("an expired lease below the limit is requeued with an incremented attempt count", async () => {
  const { d1, engine } = await setup();
  d1.state.tasks.set("cmd_r", task("cmd_r", { status: "working", attempts: 0, leaseUntil: "2000-01-01T00:00:00.000Z" }));
  const outcome = await workerOn(d1, engine, { maxAttempts: 3 }).recoverExpired();
  assert.deepEqual(outcome, { requeued: 1, exhausted: 0, lost: 0 });
  assert.equal(d1.state.tasks.get("cmd_r").status, "queued");
  assert.equal(d1.state.tasks.get("cmd_r").attempts, 1);
});

test("an expired lease at the attempt limit is failed, never retried forever", async () => {
  const { d1, engine } = await setup();
  d1.state.tasks.set("cmd_x", task("cmd_x", { status: "working", attempts: 2, leaseUntil: "2000-01-01T00:00:00.000Z" }));
  const outcome = await workerOn(d1, engine, { maxAttempts: 3 }).recoverExpired();
  assert.deepEqual(outcome, { requeued: 0, exhausted: 1, lost: 0 });
  assert.equal(d1.state.tasks.get("cmd_x").status, "failed");
  assert.match(d1.state.tasks.get("cmd_x").error, /retry limit reached/);
  const fail = engine.calls.find(call => call.method === "fail");
  assert.match(fail.options.error, /after 3 attempt/);
});

test("a hung adapter is bounded by adapterTimeoutMs and fails instead of renewing forever", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, {
    workerId: "w-timeout",
    adapterTimeoutMs: 100,
    adapters: { slow: () => new Promise(() => {}) }
  });
  const started = Date.now();
  await worker.execute(seedOwned(d1, "cmd_timeout", "w-timeout", { adapter: "slow" }));
  assert.ok(Date.now() - started < 2000, "timeout was bounded");
  assert.equal(d1.state.tasks.get("cmd_timeout").status, "failed");
  assert.match(d1.state.tasks.get("cmd_timeout").error, /timed out after 100ms/);
});

// ---- 7. evidence gate ----------------------------------------------------

test("missing evidence cannot produce a completed task", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, { workerId: "w-e", adapters: { empty: async () => ({ summary: "nothing", evidence: [] }) } });
  await worker.execute(seedOwned(d1, "cmd_e", "w-e", { adapter: "empty" }));
  assert.equal(engine.calls.some(call => call.method === "complete"), false);
  assert.equal(d1.state.tasks.get("cmd_e").status, "failed");
  assert.match(d1.state.tasks.get("cmd_e").error, /no evidence/i);
});

test("a task awaiting approval is never executed by the worker", async () => {
  const { d1, engine } = await setup();
  const worker = workerOn(d1, engine, { workerId: "w-w" });
  await worker.execute(seedOwned(d1, "cmd_w", "w-w", { approvals: [{ state: "requested" }] }));
  assert.equal(engine.calls.some(call => call.method === "complete"), false);
  assert.equal(d1.state.tasks.get("cmd_w").status, "needs_approval");
});

// ---- 8 & 9. lifecycle ----------------------------------------------------

test("initialize() actually starts the worker", async () => {
  const { d1, init, runtime } = await setup({ startWorker: true });
  assert.equal(init.ok, true);
  assert.equal(init.started, true);
  assert.equal(runtime.status().started, true);
  assert.equal(runtime.worker.isStopped(), false);
  const states = d1.state.heartbeats.map(beat => beat.state);
  assert.ok(states.includes("starting"), "worker recorded a starting heartbeat: " + states.join(","));
  assert.ok(states.includes("idle") || states.includes("polling"));
});

test("a deferred worker can be started after initialization, and shutdown is idempotent", async () => {
  const { runtime, init } = await setup({ startWorker: false });
  assert.equal(init.started, false);
  const started = await runtime.startWorker();
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  assert.equal(runtime.status().started, true);
  await runtime.shutdown("first");
  await runtime.shutdown("second");
  assert.equal(runtime.worker.isStopped(), true);
});

test("initialize({startWorker:false}) leaves it stopped, and shutdown stops a running worker", async () => {
  const idle = await setup({ startWorker: false });
  assert.equal(idle.init.started, false);
  assert.equal(idle.d1.state.heartbeats.length, 0);

  const running = await setup({ startWorker: true });
  await running.runtime.shutdown("test-shutdown");
  assert.equal(running.runtime.worker.isStopped(), true);
  assert.equal(running.d1.state.heartbeats.at(-1).state, "stopped");
  running.d1.state.tasks.set("cmd_z", task("cmd_z"));
  await running.runtime.worker.tick();
  assert.equal(running.runtime.worker.counters().claimed, 0, "a stopped worker claims nothing");
});

// ---- 10. heartbeats ------------------------------------------------------

test("heartbeats reflect real execution and its counters", async () => {
  const { app, d1, runtime } = await setup({ startWorker: true });
  d1.state.tasks.set("cmd_h", task("cmd_h", { adapter: "task.ok" }));
  await runtime.worker.tick();
  const executing = d1.state.heartbeats.filter(beat => beat.state === "executing").at(-1);
  assert.ok(executing, "an executing heartbeat was written");
  assert.equal(executing.claimed, 1);
  assert.ok(d1.state.heartbeats.at(-1).completed >= 1, "heartbeat carries the completion count");
  const status = await request(app, "GET", "/nexus/runtime", { headers: { authorization: "Bearer " + AX_TOKEN } });
  assert.equal(status.body.runtime.heartbeatVerified, true);
  assert.equal(status.body.runtime.workerStarted, true);
});

// ---- transport and configuration ----------------------------------------

test("the runtime endpoint requires the Ax credential and flags stale heartbeats", async () => {
  const { app } = await setup();
  const anonymous = await request(app, "GET", "/nexus/runtime");
  assert.equal(anonymous.statusCode, 401);
  const good = await request(app, "GET", "/nexus/runtime", { headers: { authorization: "Bearer " + AX_TOKEN } });
  assert.equal(good.statusCode, 200);
  assert.equal(good.body.runtime.heartbeatVerified, false, "no worker has beaten yet");
  assert.match(good.body.runtime.sleepingNote, /sleeps/i);
});

test("the D1 query builder refuses to exist without credentials", () => {
  assert.throws(() => createD1Query({ accountId: "a", databaseId: "", apiToken: "" }), /requires Cloudflare D1/);
});

test("claim and expiry SQL keep their guards", () => {
  assert.match(NEXUS_CLAIM_SQL, /RETURNING record_json/);
  assert.match(NEXUS_CLAIM_SQL, /'\$\.fence'/);
  assert.match(NEXUS_EXPIRED_SQL, /json_extract\(record_json, '\$\.leaseUntil'\)/);
});

// ---- real engine contract -------------------------------------------------
// These use the actual universal command engine, not the stub, so a wrong argument shape fails
// here instead of passing in a mock that accepts anything.

test("the real engine accepts the worker's completion call and records verifiedBy", async () => {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = createUniversalCommandEngine({ repository, registry: fakeRegistry() });
  const worker = workerOn(d1, engine, { workerId: "w-real-1" });
  const outcome = await worker.execute(seedOwned(d1, "cmd_real_done", "w-real-1", { adapter: "nexus.echo" }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const stored = d1.state.tasks.get("cmd_real_done");
  assert.equal(stored.status, "done");
  assert.equal(stored.result.verifiedBy, worker.workerId);
  assert.deepEqual(stored.result.evidence, ["nexus:echo/cmd_real_done"]);
});

test("the real engine accepts the worker's failure call and persists the error", async () => {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = createUniversalCommandEngine({ repository, registry: fakeRegistry() });
  const worker = workerOn(d1, engine, { workerId: "w-real-2" });
  const outcome = await worker.execute(seedOwned(d1, "cmd_real_fail", "w-real-2", { adapter: "missing.adapter" }));
  assert.equal(outcome.ok, false);
  const stored = d1.state.tasks.get("cmd_real_fail");
  assert.equal(stored.status, "failed");
  assert.match(stored.error, /No adapter registered for "missing\.adapter"/);
});

test("the real engine still refuses completion without evidence", async () => {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = createUniversalCommandEngine({ repository, registry: fakeRegistry() });
  await repository.create(task("cmd_real_bare", { status: "working" }));
  // Call the real engine directly: this asserts its own evidence gate, not the worker's.
  const outcome = await engine.complete({ taskId: "cmd_real_bare", verifiedBy: "w", result: { summary: "did nothing", evidence: [] } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "evidence_required");
  const stored = d1.state.tasks.get("cmd_real_bare");
  assert.equal(stored.status, "working");
});

// ---- device repository wiring (review finding) ---------------------------
// Habitat has two repositories: the DEVICE one owns verifyDeviceToken, the TASK one does not.
// These tests pin that separation so the mounting mistake cannot return.

test("the device repository object is accepted as the verifier source", async () => {
  const d1 = miniD1();
  const app = makeApp();
  const deviceRepository = {
    async verifyDeviceToken(token, deviceId) { return deviceId === DEVICE && token === DEVICE_TOKEN; }
  };
  const runtime = registerNexusRuntime(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository: repositoryOver(d1), registry: fakeRegistry(), query: d1.query,
    engine: engineOver(d1), deviceRepository, ownerDeviceId: DEVICE, handleSignals: false, log: quiet
  });
  await runtime.initialize({ startWorker: false });
  assert.equal(runtime.status().deviceVerifier, true);

  const bad = await request(app, "GET", "/device/command/approvals", { headers: { authorization: "Bearer nope" }, query: { deviceId: DEVICE } });
  assert.equal(bad.statusCode, 401);
  const good = await request(app, "GET", "/device/command/approvals", { headers: { authorization: "Bearer " + DEVICE_TOKEN }, query: { deviceId: DEVICE } });
  assert.equal(good.statusCode, 200);
});

test("passing the command-task repository as the device repository fails at construction", () => {
  const taskRepo = { async get() {}, async list() {}, async create() {}, async update() {} };
  assert.throws(
    () => registerNexusRuntime(makeApp(), { env: {}, repository: taskRepo, registry: fakeRegistry(), query: miniD1().query, deviceRepository: taskRepo }),
    /deviceRepository must be the D1 device repository/
  );
});

test("a verifyDevice that is neither function nor verifier object is rejected", () => {
  const d1 = miniD1();
  assert.throws(
    () => registerNexusRuntime(makeApp(), {
      env: {}, repository: repositoryOver(d1), registry: fakeRegistry(), query: d1.query,
      engine: engineOver(d1), verifyDevice: "not-a-verifier"
    }),
    /verifyDevice must be a function/
  );
});

// ---- shutdown and D1 failure handling ------------------------------------

test("shutdown survives a failing D1 heartbeat and still marks the worker stopped", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  // A worker whose D1 is already failing must still shut down cleanly: the heartbeat is
  // best-effort and must never turn a shutdown into a crash loop.
  const brokenWorker = createNexusWorker({
    repository: repositoryOver(d1), engine, pollMs: 10_000, log: quiet,
    query: async () => { throw new Error("D1 down"); }
  });
  await brokenWorker.stop("sigterm").then(() => assert.ok(true), () => assert.fail("stop() threw on D1 failure"));
  assert.equal(brokenWorker.isStopped(), true);
  await brokenWorker.tick();
  assert.equal(brokenWorker.counters().claimed, 0, "a stopped worker never claims, even with D1 down");
});

test("a D1 failure during a tick does not crash the worker and stops future claims", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  let calls = 0;
  const flaky = createNexusWorker({
    repository: repositoryOver(d1), engine, pollMs: 10_000, log: quiet,
    query: async (sql, params) => {
      calls += 1;
      if (calls > 1) throw new Error("D1 down");
      return d1.query(sql, params);
    }
  });
  d1.state.tasks.set("cmd_flaky", task("cmd_flaky"));
  // The second D1 call fails, which lands inside tick: it must be caught, not thrown out to the
  // process, and nothing may be claimed on a failed statement.
  await flaky.tick().then(() => assert.ok(true), () => assert.fail("tick() threw"));
  assert.equal(flaky.counters().claimed, 0, "no claim when the claim statement itself failed");
  assert.ok(calls >= 1, "the worker did attempt D1 work");
});

// ---- outage vs invalid credentials (review item 1) -----------------------

test("a device-repository outage returns 503, never a credential 401", async () => {
  const { app, engine, d1 } = await setup({ verifier: async () => { throw new Error("D1 unavailable"); } });
  d1.state.tasks.set("cmd_out", task("cmd_out", { status: "needs_approval", approvals: [{ state: "requested" }] }));
  for (const path of ["GET /device/command/approvals", "POST /device/command/tasks/cmd_out/approval"]) {
    const [method, route] = path.split(" ");
    const res = await request(app, method, route, {
      headers: { authorization: "Bearer " + DEVICE_TOKEN },
      query: { deviceId: DEVICE }, body: { deviceId: DEVICE, approved: true }, params: { id: "cmd_out" }
    });
    assert.equal(res.statusCode, 503, path + " must report the outage as 503");
    assert.match(res.body.error, /unavailable/i);
  }
  assert.equal(engine.calls.some(call => call.method === "approve"), false, "no approval during an outage");
  assert.equal(d1.state.tasks.get("cmd_out").status, "needs_approval");
});

test("an invalid credential is 401 while an outage is 503, on the same route", async () => {
  const good = await setup();
  const invalid = await request(good.app, "GET", "/device/command/approvals", {
    headers: { authorization: "Bearer wrong" }, query: { deviceId: DEVICE }
  });
  assert.equal(invalid.statusCode, 401);
  assert.match(invalid.body.error, /paired owner deviceId/);

  const down = await setup({ verifier: async () => { throw new Error("boom"); } });
  const outage = await request(down.app, "GET", "/device/command/approvals", {
    headers: { authorization: "Bearer " + DEVICE_TOKEN }, query: { deviceId: DEVICE }
  });
  assert.equal(outage.statusCode, 503);
});

test("a verifier returning a truthy non-boolean is not treated as success", async () => {
  const { app } = await setup({ verifier: async () => "some-hash-value" });
  const res = await request(app, "GET", "/device/command/approvals", {
    headers: { authorization: "Bearer " + DEVICE_TOKEN }, query: { deviceId: DEVICE }
  });
  assert.equal(res.statusCode, 401);
});

// ---- owner-only approval (review item 2) ---------------------------------

test("a paired device that is not the owner cannot approve or list approvals", async () => {
  const { app, engine, d1 } = await setup({ owners: ["launcher-owner"] });
  d1.state.tasks.set("cmd_notmine", task("cmd_notmine", { status: "needs_approval", approvals: [{ state: "requested" }] }));
  const list = await request(app, "GET", "/device/command/approvals", {
    headers: { authorization: "Bearer " + DEVICE_TOKEN }, query: { deviceId: DEVICE }
  });
  assert.equal(list.statusCode, 403);
  const decision = await request(app, "POST", "/device/command/tasks/cmd_notmine/approval", {
    headers: { authorization: "Bearer " + DEVICE_TOKEN }, body: { deviceId: DEVICE, approved: true }, params: { id: "cmd_notmine" }
  });
  assert.equal(decision.statusCode, 403);
  assert.equal(engine.calls.some(call => call.method === "approve"), false);
  assert.equal(d1.state.tasks.get("cmd_notmine").status, "needs_approval");
});

test("without an owner configured, approvals fail closed even for a valid paired device", async () => {
  const { app, engine } = await setup({ owners: [] });
  const res = await request(app, "POST", "/device/command/tasks/any/approval", {
    headers: { authorization: "Bearer " + DEVICE_TOKEN }, body: { deviceId: DEVICE, approved: true }, params: { id: "any" }
  });
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /Owner authorization is not configured/);
  assert.equal(engine.calls.some(call => call.method === "approve"), false);
});

test("the Ax bridge token cannot approve or list approvals even as the owner device id", async () => {
  const { app, engine } = await setup();
  for (const method of ["GET", "POST"]) {
    const res = await request(app, method, method === "GET" ? "/device/command/approvals" : "/device/command/tasks/t/approval", {
      headers: { authorization: "Bearer " + AX_TOKEN }, query: { deviceId: DEVICE }, body: { deviceId: DEVICE, approved: true }, params: { id: "t" }
    });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(engine.calls.some(call => call.method === "approve"), false);
});

// ---- retry semantics (review item 3) -------------------------------------

test("an adapter failure is terminal: the failed task is never claimed again", async () => {
  const { d1, engine } = await setup();
  d1.state.tasks.set("cmd_terminal", task("cmd_terminal", { adapter: "missing.adapter" }));
  await workerOn(d1, engine).tick();
  assert.equal(d1.state.tasks.get("cmd_terminal").status, "failed");
  const claimsBefore = engine.calls.length;
  await workerOn(d1, engine).tick();
  assert.equal(engine.calls.length, claimsBefore, "a second tick did no engine work");
  assert.equal(d1.state.tasks.get("cmd_terminal").status, "failed");
});

test("only expired leases are retried, and a live lease is left alone", async () => {
  const { d1, engine } = await setup();
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const fresh = new Date().toISOString();
  d1.state.tasks.set("cmd_stale", task("cmd_stale", { status: "working", attempts: 0, updatedAt: old }));
  d1.state.tasks.set("cmd_live", task("cmd_live", { status: "working", attempts: 0, leaseUntil: new Date(Date.now() + 600_000).toISOString(), updatedAt: fresh }));
  const outcome = await workerOn(d1, engine).recoverExpired();
  assert.deepEqual(outcome, { requeued: 1, exhausted: 0, lost: 0 });
  assert.equal(d1.state.tasks.get("cmd_stale").status, "queued");
  assert.equal(d1.state.tasks.get("cmd_live").status, "working");
});

test("lease recovery never requeues a failed or done task", async () => {
  const { d1, engine } = await setup();
  d1.state.tasks.set("cmd_f", task("cmd_f", { status: "failed", attempts: 1, leaseUntil: "2000-01-01T00:00:00.000Z" }));
  d1.state.tasks.set("cmd_d", task("cmd_d", { status: "done", attempts: 1, leaseUntil: "2000-01-01T00:00:00.000Z" }));
  const outcome = await workerOn(d1, engine).recoverExpired();
  assert.deepEqual(outcome, { requeued: 0, exhausted: 0, lost: 0 });
  assert.equal(d1.state.tasks.get("cmd_f").status, "failed");
  assert.equal(d1.state.tasks.get("cmd_d").status, "done");
});

test("a task awaiting owner approval is not executed and stays pending", async () => {
  const { d1, engine } = await setup();
  d1.state.tasks.set("cmd_gate", task("cmd_gate", { approvals: [{ state: "requested", requestedAt: "2026-11-21T00:00:00.000Z" }] }));
  await workerOn(d1, engine).execute(d1.state.tasks.get("cmd_gate"));
  assert.equal(d1.state.tasks.get("cmd_gate").status, "needs_approval");
  assert.equal(engine.calls.some(call => call.method === "complete"), false);
});

// ---- production lifecycle (review item 4) --------------------------------

test("SIGTERM stops the worker and then exits, so the host is not left waiting", async () => {
  const d1 = miniD1();
  const exits = [];
  const app = makeApp();
  const runtime = registerNexusRuntime(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository: repositoryOver(d1), registry: fakeRegistry(), query: d1.query,
    engine: engineOver(d1), verifyDevice: async () => true,
    ownerDeviceId: DEVICE, handleSignals: true, exitOnSignal: true, exit: code => exits.push(code), log: quiet
  });
  await runtime.initialize({ startWorker: true });
  process.emit("SIGTERM");
  for (let i = 0; i < 100 && exits.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(exits, [0], "the handler exited the process");
  assert.equal(runtime.worker.isStopped(), true);
  assert.equal(runtime.status().started, false);
});

// ---- fail-closed adapters (audit item 1) ---------------------------------

test("there are no built-in adapters and an unregistered adapter fails closed", async () => {
  const runtimeModule = await import("../nexus-runtime.mjs");
  assert.equal(runtimeModule.defaultAdapters, undefined, "no implicit echo/inspect adapter is exported");
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = createNexusWorker({ repository: repositoryOver(d1), engine, query: d1.query, workerId: "w-none", log: quiet });
  await worker.execute(seedOwned(d1, "cmd_none", "w-none", { adapter: "nexus.echo" }));
  assert.equal(engine.calls.some(call => call.method === "complete"), false, "no completion without a real adapter");
  assert.equal(d1.state.tasks.get("cmd_none").status, "failed");
  assert.match(d1.state.tasks.get("cmd_none").error, /No adapter registered for "nexus\.echo"/);
});

test("a task with no adapter at all fails closed", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = createNexusWorker({ repository: repositoryOver(d1), engine, query: d1.query, workerId: "w-empty", log: quiet });
  await worker.execute(seedOwned(d1, "cmd_blank", "w-empty"));
  assert.equal(d1.state.tasks.get("cmd_blank").status, "failed");
  assert.match(d1.state.tasks.get("cmd_blank").error, /no adapter/i);
});

test("adapter blockers prevent completion even when evidence is present", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, {
    workerId: "w-block",
    adapters: { blocked: async () => ({ summary: "partially done", evidence: ["file.txt"], blockers: ["database locked"] }) }
  });
  await worker.execute(seedOwned(d1, "cmd_block", "w-block", { adapter: "blocked" }));
  assert.equal(engine.calls.some(call => call.method === "complete"), false);
  assert.equal(d1.state.tasks.get("cmd_block").status, "failed");
  assert.match(d1.state.tasks.get("cmd_block").error, /blockers: database locked/);
});

test("an adapter reporting ok:false or a missing summary cannot complete", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, {
    workerId: "w-neg",
    adapters: {
      no: async () => ({ ok: false, error: "endpoint returned 500" }),
      terse: async () => ({ summary: "", evidence: ["x"] })
    }
  });
  await worker.execute(seedOwned(d1, "cmd_no", "w-neg", { adapter: "no" }));
  await worker.execute(seedOwned(d1, "cmd_terse", "w-neg", { adapter: "terse" }));
  assert.equal(engine.calls.some(call => call.method === "complete"), false);
  assert.match(d1.state.tasks.get("cmd_no").error, /adapter reported failure: endpoint returned 500/);
  assert.match(d1.state.tasks.get("cmd_terse").error, /no usable summary/);
});

// ---- fencing and concurrency (audit item 2) ------------------------------

test("competing recovery workers requeue a task exactly once", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_race", task("cmd_race", { status: "working", attempts: 0, fence: "f-race", leaseUntil: "2000-01-01T00:00:00.000Z" }));
  const one = workerOn(d1, engine, { workerId: "r1" });
  const two = workerOn(d1, engine, { workerId: "r2" });
  const [a, b] = await Promise.all([one.recoverExpired(), two.recoverExpired()]);
  assert.equal(a.requeued + b.requeued, 1, "exactly one recoverer won");
  assert.equal(a.lost + b.lost, 1, "the loser detected it had already been recovered");
  assert.equal(d1.state.tasks.get("cmd_race").attempts, 1);
  assert.equal(d1.state.tasks.get("cmd_race").fence, null);
});

test("competing recoverers fail exhausted work only once", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_ex", task("cmd_ex", { status: "working", attempts: 2, fence: "f-ex", leaseUntil: "2000-01-01T00:00:00.000Z" }));
  const [a, b] = await Promise.all([workerOn(d1, engine, { workerId: "x1" }).recoverExpired(), workerOn(d1, engine, { workerId: "x2" }).recoverExpired()]);
  assert.equal(a.exhausted + b.exhausted, 1);
  assert.equal(engine.calls.filter(call => call.method === "fail").length, 1, "engine.fail ran once");
  assert.equal(d1.state.tasks.get("cmd_ex").status, "failed");
});

test("a completion from a worker whose fence was taken over is rejected as stale", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = workerOn(d1, engine, {
    workerId: "w-slow",
    adapters: { slow: async () => { await gate; return { summary: "finished late", evidence: ["late.txt"] }; } }
  });
  const owned = seedOwned(d1, "cmd_stale", "w-slow", { adapter: "slow" });
  const pending = worker.execute(owned);
  // Another worker takes the fence while this adapter is still running.
  Object.assign(d1.state.tasks.get("cmd_stale"), { claimedBy: "w-other", fence: "fence-taken" });
  release();
  const outcome = await pending;
  assert.equal(outcome.reason, "stale_claim");
  assert.equal(engine.calls.some(call => call.method === "complete"), false, "no completion after takeover");
  assert.equal(worker.counters().stale, 1);
  assert.equal(d1.state.tasks.get("cmd_stale").status, "working");
});

test("an expired lease during execution is not completed by the original worker", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, {
    workerId: "w-exp",
    leaseMs: 200,
    renewLease: false,
    adapters: { slow: async () => { await new Promise(resolve => setTimeout(resolve, 320)); return { summary: "finished", evidence: ["late.txt"] }; } }
  });
  d1.state.tasks.set("cmd_exp", task("cmd_exp", { adapter: "slow" }));
  const pending = worker.tick();
  await new Promise(resolve => setTimeout(resolve, 230));
  const recovery = await workerOn(d1, engine, { workerId: "recoverer", leaseMs: 200 }).recoverExpired();
  assert.equal(recovery.requeued, 1, "the lease had expired, so the task was recovered");
  await pending;
  assert.equal(engine.calls.some(call => call.method === "complete"), false, "the original worker did not complete it");
  assert.ok(worker.counters().stale >= 1);
  assert.equal(d1.state.tasks.get("cmd_exp").status, "queued");
});

test("lease renewal keeps a long-running task owned and recoverable-free", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, {
    workerId: "w-renew",
    leaseMs: 900,
    adapters: { slow: async () => { await new Promise(resolve => setTimeout(resolve, 500)); return { summary: "long job done", evidence: ["out.txt"] }; } }
  });
  const owned = seedOwned(d1, "cmd_long", "w-renew", { adapter: "slow", leaseUntil: new Date(Date.now() + 300).toISOString() });
  const pending = worker.execute(owned);
  await new Promise(resolve => setTimeout(resolve, 400));
  const recovery = await workerOn(d1, engine, { workerId: "rival", leaseMs: 900 }).recoverExpired();
  assert.equal(recovery.requeued, 0, "a renewed lease was not stolen");
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.ok(worker.counters().renewals >= 1, "renewals were recorded");
  assert.equal(d1.state.tasks.get("cmd_long").status, "done");
});

// ---- real engine approval transitions (audit item 3) --------------------

async function approvalFixture(decision) {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = createUniversalCommandEngine({ repository, registry: fakeRegistry() });
  const app = makeApp();
  const runtime = registerNexusRuntime(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository, registry: fakeRegistry(), query: d1.query, engine,
    adapters: TEST_ADAPTERS,
    verifyDevice: async (token, deviceId) => deviceId === DEVICE && token === DEVICE_TOKEN,
    ownerDeviceId: DEVICE, handleSignals: false, log: quiet,
    enforceReadOnlyAdapters: false
  });
  await runtime.initialize({ startWorker: false });
  await repository.create(task("cmd_ap", { adapter: "task.ok" }));
  const requested = await engine.requestApproval({ taskId: "cmd_ap", reason: "needs owner sign-off", by: "ax" });
  assert.equal(requested.ok, true);
  assert.equal(d1.state.tasks.get("cmd_ap").status, "needs_approval");
  const res = await request(app, "POST", "/device/command/tasks/cmd_ap/approval", {
    headers: { authorization: "Bearer " + DEVICE_TOKEN },
    body: { deviceId: DEVICE, approved: decision }, params: { id: "cmd_ap" }
  });
  return { d1, engine, runtime, res };
}

test("an approved task becomes executable and the worker completes it", async () => {
  const { d1, runtime, res } = await approvalFixture(true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "working", "approve() moves the task to working, not queued");
  await runtime.worker.tick();
  const stored = d1.state.tasks.get("cmd_ap");
  assert.equal(stored.status, "done");
  assert.equal(stored.result.verifiedBy, runtime.worker.workerId);
  assert.deepEqual(stored.result.evidence, ["evidence:cmd_ap"]);
});

test("a worker-parks a pending task without a fence so the owner can then approve it", async () => {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = createUniversalCommandEngine({ repository, registry: fakeRegistry() });
  const app = makeApp();
  const runtime = registerNexusRuntime(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository, registry: fakeRegistry(), query: d1.query, engine,
    adapters: TEST_ADAPTERS,
    verifyDevice: async (token, deviceId) => deviceId === DEVICE && token === DEVICE_TOKEN,
    ownerDeviceId: DEVICE, handleSignals: false, log: quiet,
    enforceReadOnlyAdapters: false
  });
  await runtime.initialize({ startWorker: false });
  await repository.create(task("cmd_park", {
    adapter: "task.ok",
    approvals: [{ state: "requested", requestedAt: "2026-11-21T00:03:00.000Z" }]
  }));

  await runtime.worker.tick();
  const parked = d1.state.tasks.get("cmd_park");
  assert.equal(parked.status, "needs_approval");
  assert.equal(parked.fence, undefined, "parking releases the worker fence");
  assert.equal(parked.claimedBy, undefined);

  const approved = await request(app, "POST", "/device/command/tasks/cmd_park/approval", {
    headers: { authorization: "Bearer " + DEVICE_TOKEN },
    body: { deviceId: DEVICE, approved: true }, params: { id: "cmd_park" }
  });
  assert.equal(approved.statusCode, 200, approved.body?.error || "owner approval succeeds");
  assert.equal(approved.body.status, "working");

  await runtime.worker.tick();
  assert.equal(d1.state.tasks.get("cmd_park").status, "done");
});

test("a denied task is terminal and is never executed", async () => {
  const { d1, runtime, res } = await approvalFixture(false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "failed");
  await runtime.worker.tick();
  const stored = d1.state.tasks.get("cmd_ap");
  assert.equal(stored.status, "failed");
  assert.equal(stored.result, undefined);
});

// ---- lifecycle, reporting and configuration (items 4 and 5) -------------

test("start() is idempotent and reports the existing worker", async () => {
  const d1 = miniD1();
  const worker = workerOn(d1, engineOver(d1), { pollMs: 60_000 });
  const first = await worker.start();
  const second = await worker.start();
  assert.equal(first.started, true);
  assert.equal(first.alreadyRunning, false);
  assert.equal(second.alreadyRunning, true);
  await worker.stop("test");
});

test("stop() is bounded for a hung adapter and reports the timeout", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, {
    workerId: "w-hang",
    shutdownTimeoutMs: 150,
    adapters: { hang: () => new Promise(() => {}) }
  });
  d1.state.tasks.set("cmd_hang", task("cmd_hang", { adapter: "hang" }));
  worker.start().catch(() => {});
  for (let i = 0; i < 100 && worker.counters().claimed === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  const started = Date.now();
  const result = await worker.stop("sigterm");
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 3000, "stop returned promptly instead of waiting forever");
  assert.equal(worker.isStopped(), true);
});

test("invalid worker configuration is rejected at construction", () => {
  const d1 = miniD1();
  const base = { repository: repositoryOver(d1), engine: engineOver(d1), query: d1.query };
  assert.throws(() => createNexusWorker({ ...base, pollMs: 10 }), /pollMs/);
  assert.throws(() => createNexusWorker({ ...base, maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createNexusWorker({ ...base, leaseMs: 50 }), /leaseMs/);
  assert.throws(() => createNexusWorker({ ...base, adapters: null }), /adapters/);
});

test("runtime reporting counts only live workers and separates stopped ones", async () => {
  const { app, d1 } = await setup();
  const at = new Date().toISOString();
  d1.state.heartbeats.push(
    { workerId: "live-1", at, state: "idle", claimed: 0, completed: 0, failed: 0 },
    { workerId: "stopped-1", at, state: "stopped", claimed: 2, completed: 1, failed: 1 }
  );
  const res = await request(app, "GET", "/nexus/runtime", { headers: { authorization: "Bearer " + AX_TOKEN } });
  assert.equal(res.body.runtime.liveWorkers, 1);
  assert.equal(res.body.runtime.stoppedWorkers, 1);
  assert.equal(res.body.runtime.heartbeatVerified, true);
});

test("counters distinguish failures, stale claims and exhausted retries", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, { workerId: "w-count", maxAttempts: 1 });
  await worker.execute(seedOwned(d1, "cmd_c1", "w-count", { adapter: "missing" }));
  d1.state.tasks.set("cmd_c2", task("cmd_c2", { status: "working", attempts: 0, fence: "f2", leaseUntil: "2000-01-01T00:00:00.000Z" }));
  const recovery = await worker.recoverExpired();
  assert.equal(recovery.exhausted, 1, "maxAttempts 1 means the first expiry is final");
  const counters = worker.counters();
  assert.equal(counters.failed, 2, "adapter failure plus exhausted lease count as failures");
  assert.equal(counters.exhausted, 1);
});

test("a task that finishes only after a shutdown timeout does not write a completion", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  const worker = workerOn(d1, engine, {
    workerId: "w-late",
    shutdownTimeoutMs: 100,
    adapters: { late: async () => { await new Promise(resolve => setTimeout(resolve, 400)); return { summary: "finished after shutdown", evidence: ["late.txt"] }; } }
  });
  d1.state.tasks.set("cmd_late", task("cmd_late", { adapter: "late" }));
  worker.start().catch(() => {});
  for (let i = 0; i < 100 && worker.counters().claimed === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  const stopResult = await worker.stop("sigterm");
  assert.equal(stopResult.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(engine.calls.some(call => call.method === "complete"), false, "no completion after the shutdown deadline");
  assert.equal(worker.counters().completed, 0);
  assert.equal(d1.state.tasks.get("cmd_late").status, "working", "the lease is left to expire and be recovered");
});

// ---- engine-level fencing (audit revision 2) -----------------------------
// These use the REAL engine and a repository whose transition() mirrors the D1 conditional UPDATE.

async function fencedFixture() {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = createUniversalCommandEngine({ repository, registry: fakeRegistry() });
  return { d1, repository, engine };
}

test("engine rejects a stale completion after takeover and leaves the newer claim intact", async () => {
  const { d1, engine } = await fencedFixture();
  const taskA = seedOwned(d1, "cmd_fence_c", "w-a", { adapter: "task.ok" });
  Object.assign(d1.state.tasks.get("cmd_fence_c"), { claimedBy: "w-b", fence: "fence-b" });

  const outcome = await engine.complete({
    taskId: "cmd_fence_c", verifiedBy: "w-a",
    claim: { fence: taskA.fence, workerId: "w-a" },
    result: { summary: "A thought it finished", evidence: ["a.txt"] }
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "stale_claim");
  const stored = d1.state.tasks.get("cmd_fence_c");
  assert.equal(stored.status, "working", "the task was not completed");
  assert.equal(stored.claimedBy, "w-b");
  assert.equal(stored.fence, "fence-b");
  assert.equal(stored.result ?? null, null, "no result was written");
});

test("engine rejects a stale failure after takeover and leaves the newer claim intact", async () => {
  const { d1, engine } = await fencedFixture();
  const taskA = seedOwned(d1, "cmd_fence_f", "w-a", { adapter: "task.ok" });
  Object.assign(d1.state.tasks.get("cmd_fence_f"), { claimedBy: "w-b", fence: "fence-b" });

  const outcome = await engine.fail({
    taskId: "cmd_fence_f", error: "A failed late", by: "w-a",
    claim: { fence: taskA.fence, workerId: "w-a" }
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "stale_claim");
  const stored = d1.state.tasks.get("cmd_fence_f");
  assert.equal(stored.status, "working");
  assert.equal(stored.claimedBy, "w-b");
  assert.equal(stored.error ?? null, null);
});

test("a worker whose ownership read was stale still cannot complete: the DB transition refuses", async () => {
  const { d1, repository, engine } = await fencedFixture();
  const worker = workerOn(d1, engine, { workerId: "w-a", repository, adapters: { "task.ok": TEST_ADAPTERS["task.ok"] } });
  const owned = seedOwned(d1, "cmd_toctou", "w-a", { adapter: "task.ok" });
  // B takes over, but every repository read lies to A and reports its old claim. This is the exact
  // check-then-write window Ax described: only the conditional write can close it.
  const realGet = repository.get.bind(repository);
  repository.get = async id => {
    const actual = await realGet(id);
    return { ...actual, status: "working", claimedBy: "w-a", fence: owned.fence };
  };
  Object.assign(d1.state.tasks.get("cmd_toctou"), { claimedBy: "w-b", fence: "fence-b" });

  const outcome = await worker.execute(owned);
  assert.equal(outcome.reason, "stale_claim");
  assert.equal(outcome.outcome?.code, "stale_claim", "the refusal came from the engine transition");
  const stored = d1.state.tasks.get("cmd_toctou");
  assert.equal(stored.status, "working");
  assert.equal(stored.claimedBy, "w-b");
});

test("two concurrent completions with the same claim produce exactly one completion", async () => {
  const { d1, engine } = await fencedFixture();
  const task = seedOwned(d1, "cmd_conc", "w-par", { adapter: "task.ok" });
  const claim = { fence: task.fence, workerId: "w-par" };
  const [first, second] = await Promise.all([
    engine.complete({ taskId: "cmd_conc", verifiedBy: "w-par", claim, result: { summary: "first", evidence: ["a.txt"] } }),
    engine.complete({ taskId: "cmd_conc", verifiedBy: "w-par", claim, result: { summary: "second", evidence: ["b.txt"] } })
  ]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1, "one winner");
  assert.equal([first, second].filter(outcome => outcome.code === "stale_claim").length, 1);
  assert.equal(d1.state.tasks.get("cmd_conc").status, "done");
});

test("a renewed lease followed by takeover still blocks the old claim", async () => {
  const { d1, repository, engine } = await fencedFixture();
  const worker = workerOn(d1, engine, {
    workerId: "w-renew",
    leaseMs: 300,
    adapters: {
      renewThenLose: async task => {
        await new Promise(resolve => setTimeout(resolve, 200));
        Object.assign(d1.state.tasks.get(task.id), { claimedBy: "w-new", fence: "fence-new" });
        return { summary: "A finished after takeover", evidence: ["a.txt"] };
      }
    }
  });
  const owned = seedOwned(d1, "cmd_renew", "w-renew", { adapter: "renewThenLose", leaseUntil: new Date(Date.now() + 200).toISOString() });
  const outcome = await worker.execute(owned);
  assert.ok(worker.counters().renewals >= 1, "the lease was renewed before the takeover");
  assert.equal(outcome.reason, "stale_claim");
  assert.equal(d1.state.tasks.get("cmd_renew").status, "working");
  assert.equal(d1.state.tasks.get("cmd_renew").claimedBy, "w-new");
});

test("an approved task executes exactly once with two competing workers", async () => {
  const d1 = miniD1();
  const repository = repositoryOver(d1);
  const engine = createUniversalCommandEngine({ repository, registry: fakeRegistry() });
  await repository.create(task("cmd_once", { adapter: "task.ok" }));
  await engine.requestApproval({ taskId: "cmd_once", reason: "owner sign-off", by: "ax" });
  const approved = await engine.approve({ taskId: "cmd_once", by: "owner" });
  assert.equal(approved.ok, true);
  const one = workerOn(d1, engine, { workerId: "w-one" });
  const two = workerOn(d1, engine, { workerId: "w-two" });
  const [a, b] = await Promise.all([one.tick(), two.tick()]);
  assert.equal(d1.state.tasks.get("cmd_once").status, "done");
  assert.equal(one.counters().completed + two.counters().completed, 1, "exactly one execution");
});

test("recovery racing a completion cannot both win", async () => {
  const { d1, engine } = await fencedFixture();
  const owned = seedOwned(d1, "cmd_race2", "w-a", {
    adapter: "task.ok",
    leaseUntil: "2000-01-01T00:00:00.000Z"
  });
  const worker = workerOn(d1, engine, { workerId: "w-recover" });
  const [completion, recovery] = await Promise.all([
    engine.complete({ taskId: "cmd_race2", verifiedBy: "w-a", claim: { fence: owned.fence, workerId: "w-a" }, result: { summary: "done", evidence: ["a.txt"] } }),
    worker.recoverExpired()
  ]);
  const stored = d1.state.tasks.get("cmd_race2");
  assert.ok(!(completion.ok && recovery.requeued === 1), "the same transition cannot complete and requeue");
  if (completion.ok) {
    assert.equal(stored.status, "done");
    assert.equal(recovery.requeued, 0);
  } else {
    assert.equal(completion.code, "stale_claim");
    assert.equal(recovery.requeued, 1);
    assert.equal(stored.status, "queued");
  }
});

test("a repository without fenced transitions refuses a fenced write instead of writing blindly", async () => {
  const legacy = {
    tasks: new Map([["cmd_legacy", { id: "cmd_legacy", status: "working", fence: "f", claimedBy: "w", objective: "x", createdAt: "2026-11-21T00:00:00.000Z", attempts: 0 }]]),
    async get(id) { return this.tasks.get(id) || null; },
    async update(id, patch) { this.tasks.set(id, { ...this.tasks.get(id), ...patch }); return this.tasks.get(id); },
    async create() {}, async list() { return []; }
  };
  const engine = createUniversalCommandEngine({ repository: legacy, registry: fakeRegistry() });
  const outcome = await engine.complete({ taskId: "cmd_legacy", verifiedBy: "w", claim: { fence: "f", workerId: "w" }, result: { summary: "done", evidence: ["a"] } });
  assert.equal(outcome.code, "fencing_unsupported");
  assert.equal(legacy.tasks.get("cmd_legacy").status, "working", "nothing was written");
});

test("unfenced engine callers keep the existing contract", async () => {
  const { d1, engine } = await fencedFixture();
  await d1.state.tasks.set("cmd_manual", task("cmd_manual", { status: "working" }));
  const outcome = await engine.complete({ taskId: "cmd_manual", verifiedBy: "ax", result: { summary: "manual close", evidence: ["note"] } });
  assert.equal(outcome.ok, true);
  assert.equal(d1.state.tasks.get("cmd_manual").status, "done");
});

test("a fenced completion preserves existing task record fields", async () => {
  const { d1, engine } = await fencedFixture();
  seedOwned(d1, "cmd_fields", "w-f", {
    adapter: "task.ok",
    objective: "keep me",
    role: "ax",
    customField: { nested: true },
    approvals: [{ state: "approved", decidedBy: "owner" }]
  });
  const outcome = await engine.complete({
    taskId: "cmd_fields", verifiedBy: "w-f", claim: { fence: "fence-cmd_fields", workerId: "w-f" },
    result: { summary: "done properly", evidence: ["file.txt"] }
  });
  assert.equal(outcome.ok, true);
  const stored = d1.state.tasks.get("cmd_fields");
  assert.equal(stored.objective, "keep me");
  assert.deepEqual(stored.customField, { nested: true });
  assert.deepEqual(stored.approvals, [{ state: "approved", decidedBy: "owner" }]);
  assert.equal(stored.attempts, 0);
  assert.equal(stored.result.verifiedBy, "w-f");
  assert.ok(stored.statusHistory.some(entry => entry.to === "done"));
});

// ---- claim validation and stale status reporting (Ax decision) -----------

test("a claim without a fence or without a worker id is rejected without a write", async () => {
  const { d1, engine } = await fencedFixture();
  seedOwned(d1, "cmd_claim_invalid", "w-a", { adapter: "task.ok" });

  const noFence = await engine.complete({
    taskId: "cmd_claim_invalid", verifiedBy: "w-a", claim: { workerId: "w-a" },
    result: { summary: "no fence", evidence: ["a"] }
  });
  assert.equal(noFence.ok, false);
  assert.equal(noFence.code, "invalid_claim");

  const noWorker = await engine.fail({
    taskId: "cmd_claim_invalid", error: "no worker", by: "w-a", claim: { fence: "fence-cmd_claim_invalid" }
  });
  assert.equal(noWorker.ok, false);
  assert.equal(noWorker.code, "invalid_claim");

  const emptyStrings = await engine.complete({
    taskId: "cmd_claim_invalid", verifiedBy: "w-a", claim: { fence: "  ", workerId: "  " },
    result: { summary: "blank", evidence: ["a"] }
  });
  assert.equal(emptyStrings.code, "invalid_claim");

  const stored = d1.state.tasks.get("cmd_claim_invalid");
  assert.equal(stored.status, "working");
  assert.equal(stored.result ?? null, null);
  assert.equal(stored.error ?? null, null);
});

test("a stale claim without a fence cannot match a fence-less working record", async () => {
  const { d1, engine } = await fencedFixture();
  d1.state.tasks.set("cmd_nofence", task("cmd_nofence", { status: "working" }));
  const outcome = await engine.complete({
    taskId: "cmd_nofence", verifiedBy: "w-a", claim: { fence: "", workerId: "w-a" },
    result: { summary: "should not match", evidence: ["a"] }
  });
  assert.equal(outcome.code, "invalid_claim");
  assert.equal(d1.state.tasks.get("cmd_nofence").status, "working");
});

test("a stale-claim response reports the task's actual current status", async () => {
  const { d1, repository, engine } = await fencedFixture();
  const owned = seedOwned(d1, "cmd_status", "w-a", { adapter: "task.ok" });
  // B takes over and finishes the task; A still holds its old claim.
  Object.assign(d1.state.tasks.get("cmd_status"), { claimedBy: "w-b", fence: "fence-b" });
  const bDone = await engine.complete({
    taskId: "cmd_status", verifiedBy: "w-b", claim: { fence: "fence-b", workerId: "w-b" },
    result: { summary: "B did it", evidence: ["b"] }
  });
  assert.equal(bDone.ok, true);

  // A's read is stale (it saw working), then the CAS fails and the response must say "done".
  const realGet = repository.get.bind(repository);
  let reads = 0;
  repository.get = async id => {
    reads += 1;
    const actual = await realGet(id);
    return reads === 1 ? { ...actual, status: "working", claimedBy: "w-a", fence: owned.fence } : actual;
  };
  const stale = await engine.complete({
    taskId: "cmd_status", verifiedBy: "w-a", claim: { fence: owned.fence, workerId: "w-a" },
    result: { summary: "A too late", evidence: ["a"] }
  });
  assert.equal(stale.code, "stale_claim");
  assert.equal(stale.status, "done", "the response reports the real current status");
  assert.equal(d1.state.tasks.get("cmd_status").result.verifiedBy, "w-b", "B's completion stands");
});

test("a stale worker cannot move a task into needs_approval after a takeover", async () => {
  const { d1, engine } = await setup();
  const worker = workerOn(d1, engine, { workerId: "w-old" });
  const stale = seedOwned(d1, "cmd_gate_race", "w-old", { approvals: [{ state: "requested" }] });
  const current = d1.state.tasks.get("cmd_gate_race");
  const taken = { ...current, fence: "fence-new-owner", claimedBy: "w-new" };
  d1.state.tasks.set("cmd_gate_race", taken);
  const before = JSON.stringify(d1.state.tasks.get("cmd_gate_race"));

  const outcome = await worker.execute(stale);
  assert.equal(outcome.reason, "stale_claim");
  assert.equal(JSON.stringify(d1.state.tasks.get("cmd_gate_race")), before, "the newer claim was not modified");
  assert.equal(d1.state.tasks.get("cmd_gate_race").claimedBy, "w-new");
  assert.equal(d1.state.tasks.get("cmd_gate_race").status, "working");
});
