import test from "node:test";
import assert from "node:assert/strict";
import { createNexusWorker } from "../nexus-runtime.mjs";

/**
 * Concurrency and failed-write behaviour for the NEXUS worker.
 *
 * The store double can inject a failure into one statement kind at a time, so these tests cover the
 * paths that only appear during an incident: duplicate ticks, two workers racing one queue, a lease
 * that expires while an adapter is still running, and D1 write failures during heartbeat, recovery,
 * retention and completion. None of this is a live D1 test.
 */

const past = () => "2000-01-01T00:00:00.000Z";
const future = () => new Date(Date.now() + 600_000).toISOString();
const quiet = { log() {}, warn() {}, error() {} };

function miniD1() {
  const state = { tasks: new Map(), heartbeats: [] };
  const fail = { claim: 0, requeue: 0, heartbeat: 0, prune: 0, expire: 0, renew: 0, seize: 0 };
  let busy = false;
  const hit = kind => {
    if (fail[kind] > 0) {
      fail[kind] -= 1;
      throw new Error("D1 " + kind + " write unavailable");
    }
  };
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    if (/^CREATE TABLE/.test(text)) return [{ results: [] }];
    if (text.startsWith("INSERT INTO habitat_nexus_workers")) {
      hit("heartbeat");
      state.heartbeats.push({ workerId: params[0], at: params[2], state: params[3] });
      return [{ results: [] }];
    }
    if (text.startsWith("DELETE FROM habitat_nexus_workers")) {
      hit("prune");
      return [{ results: [] }];
    }
    if (text.startsWith("UPDATE habitat_command_tasks SET status = 'working'")) {
      hit("claim");
      if (busy) return [{ results: [] }];
      busy = true;
      try {
        const claimable = task => (task.status === "queued" || (task.status === "working" && (task.fence ?? null) === null))
          && typeof task.adapter === "string" && task.adapter.length > 0;
        const candidate = [...state.tasks.values()]
          .filter(claimable)
          .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
        if (!candidate) return [{ results: [] }];
        Object.assign(candidate, { status: "working", claimedBy: params[0], leaseUntil: params[1], fence: params[2] });
        return [{ results: [{ record_json: JSON.stringify(structuredClone(candidate)) }] }];
      } finally {
        busy = false;
      }
    }
    if (text.startsWith("UPDATE habitat_command_tasks SET status = 'queued'")) {
      hit("requeue");
      const [attempts, at, , id, fence] = params;
      const task = state.tasks.get(id);
      if (!task || task.status !== "working" || (task.fence ?? null) !== (fence ?? null)) return [{ results: [] }];
      Object.assign(task, { status: "queued", attempts, claimedBy: null, leaseUntil: null, fence: null, updatedAt: at });
      return [{ results: [{ id }] }];
    }
    if (text.startsWith("UPDATE habitat_command_tasks SET record_json = json_set")) {
      if (text.includes("'$.claimedBy', ?")) {
        hit("seize");
        const [workerId, fence, at, , id, oldFence] = params;
        const task = state.tasks.get(id);
        if (!task || task.status !== "working" || (task.fence ?? null) !== (oldFence ?? null)) return [{ results: [] }];
        Object.assign(task, { claimedBy: workerId, fence, updatedAt: at });
        return [{ results: [{ id }] }];
      }
      hit("renew");
      const [leaseUntil, at, , id, fence] = params;
      const task = state.tasks.get(id);
      if (!task || task.status !== "working" || (task.fence ?? null) !== (fence ?? null)) return [{ results: [] }];
      Object.assign(task, { leaseUntil, updatedAt: at });
      return [{ results: [{ id }] }];
    }
    if (text.startsWith("SELECT id, record_json") && text.includes("leaseUntil")) {
      hit("expire");
      const at = params[0];
      const floor = params[1];
      return [{ results: [...state.tasks.values()]
        .filter(task => task.status === "working" && (
          (task.leaseUntil && task.leaseUntil < at) ||
          (!task.leaseUntil && String(task.updatedAt || "") < floor)
        ))
        .slice(0, 10)
        .map(task => ({ id: task.id, record_json: JSON.stringify(task) })) }];
    }
    throw new Error("unexpected SQL in concurrency harness: " + text.slice(0, 90));
  };
  return { state, fail, query };
}

function repositoryOver(d1) {
  const { state } = d1;
  return {
    durable: true,
    async initialize() { return { ok: true }; },
    async get(id) { const task = state.tasks.get(id); return task ? structuredClone(task) : null; },
    async create(task) { state.tasks.set(task.id, structuredClone(task)); return structuredClone(task); },
    async update(id, patch) {
      const current = state.tasks.get(id);
      if (!current) return null;
      state.tasks.set(id, { ...current, ...structuredClone(patch) });
      return structuredClone(state.tasks.get(id));
    },
    async list({ status, limit = 50 } = {}) {
      return [...state.tasks.values()].filter(task => !status || task.status === status).slice(0, limit).map(task => structuredClone(task));
    },
    async transition(id, { expect, next } = {}) {
      const current = state.tasks.get(id);
      if (!current || current.status !== "working") return null;
      if ((current.fence ?? null) !== (expect?.fence ?? null)) return null;
      if ((current.claimedBy ?? null) !== (expect?.claimedBy ?? null)) return null;
      state.tasks.set(id, { ...next, id });
      return structuredClone(state.tasks.get(id));
    }
  };
}

function engineOver(d1, { failComplete = 0 } = {}) {
  const calls = { complete: 0, fail: 0 };
  const patch = (taskId, changes) => {
    const task = d1.state.tasks.get(taskId);
    if (!task) return null;
    d1.state.tasks.set(taskId, { ...task, ...changes });
    return structuredClone(d1.state.tasks.get(taskId));
  };
  return {
    calls,
    setCompleteFailures(count) { failComplete = count; },
    async complete(options) {
      calls.complete += 1;
      if (failComplete > 0) { failComplete -= 1; throw new Error("D1 completion write unavailable"); }
      return { ok: true, task: patch(options.taskId, { status: "done", result: { ...options.result, verifiedBy: options.verifiedBy }, error: null }) };
    },
    async fail(options) { calls.fail += 1; return { ok: true, task: patch(options.taskId, { status: "failed", error: options.error }) }; },
    async list() { return { ok: true, tasks: [] }; }
  };
}

const adapters = {
  "task.ok": async task => ({ summary: "did " + task.id, evidence: ["concurrency:" + task.id], decisions: [], blockers: [] })
};

function workerOver(d1, engine, workerId, overrides = {}) {
  return createNexusWorker({
    repository: repositoryOver(d1),
    engine,
    query: d1.query,
    adapters,
    workerId,
    pollMs: 60_000,
    renewLease: false,
    log: quiet,
    ...overrides
  });
}

function queued(id, extra = {}) {
  return {
    id,
    objective: "race safely",
    status: "queued",
    role: "ax",
    adapter: "task.ok",
    attempts: 0,
    requestedBy: "ax",
    approvals: [],
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    ...extra
  };
}

function working(id, workerId, extra = {}) {
  return {
    ...queued(id),
    status: "working",
    claimedBy: workerId,
    fence: "fence-" + id,
    leaseUntil: future(),
    ...extra
  };
}

test("concurrent ticks on one worker never claim or execute the same task twice", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_dup", queued("cmd_dup"));

  const worker = workerOver(d1, engine, "w-dup");
  const [first, second] = await Promise.all([worker.tick(), worker.tick()]);

  const skipped = [first, second].filter(report => report.skipped);
  assert.equal(skipped.length, 1, "one tick is rejected while the other is running");
  assert.equal(skipped[0].reason, "already_running");
  assert.equal(engine.calls.complete, 1, "the adapter completed exactly once");
  assert.equal(d1.state.tasks.get("cmd_dup").status, "done");
});

test("two workers ticking at once execute a single queue item exactly once", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_race", queued("cmd_race"));

  const one = workerOver(d1, engine, "w-one");
  const two = workerOver(d1, engine, "w-two");
  const [a, b] = await Promise.all([one.tick(), two.tick()]);

  const claimed = (a.claimed || 0) + (b.claimed || 0);
  assert.equal(claimed, 1, "only one worker claimed the task");
  assert.equal(engine.calls.complete, 1);
  assert.equal(d1.state.tasks.get("cmd_race").status, "done");
});

test("a lease that expires mid-adapter cannot be completed by the stale worker", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slowAdapters = { "task.ok": async task => { await gate; return { summary: "slow " + task.id, evidence: ["slow:" + task.id] }; } };

  const stale = createNexusWorker({
    repository: repositoryOver(d1), engine, query: d1.query, adapters: slowAdapters,
    workerId: "w-stale", pollMs: 60_000, renewLease: false, log: quiet
  });
  const current = workerOver(d1, engine, "w-current");
  const task = working("cmd_expire", "w-stale", { leaseUntil: past() });
  // Store a copy: the harness mutates rows in place, so asserting against the original object
  // would compare a value with itself after recovery/claim.
  d1.state.tasks.set("cmd_expire", structuredClone(task));

  const inFlight = stale.execute(structuredClone(task));
  let taken = null;
  try {
    // Another worker recovers and takes the expired task while the adapter is still running.
    assert.deepEqual(await current.recoverExpired(), { requeued: 1, exhausted: 0, lost: 0 });
    taken = await current.claim();
    assert.equal(taken?.id, "cmd_expire");
    assert.equal(taken.fence !== task.fence, true, "the new claim uses a new fence");
  } finally {
    // Always release the adapter so a failed assertion cannot leave a 120 s deadline pending.
    release();
  }

  const outcome = await inFlight;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "stale_claim", "the stale worker does not complete the task");
  const stored = d1.state.tasks.get("cmd_expire");
  assert.equal(stored.status, "working");
  assert.equal(stored.claimedBy, "w-current", "ownership stays with the new claim");
  assert.equal(engine.calls.complete, 0);
});

test("a failed completion write cannot mark a task done, and restart recovery retries it", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1, { failComplete: 1 });
  d1.state.tasks.set("cmd_write", queued("cmd_write"));

  const worker = workerOver(d1, engine, "w-write");
  const report = await worker.tick();

  assert.equal(report.ok, false, "the tick reports the storage failure");
  assert.match(report.error, /completion write unavailable/);
  assert.equal(d1.state.tasks.get("cmd_write").status, "working", "no false completion");
  assert.equal(d1.state.tasks.get("cmd_write").result, undefined);

  // Simulate the restart: the lease expires and a new worker recovers the same task.
  d1.state.tasks.get("cmd_write").leaseUntil = past();
  const restarted = workerOver(d1, engine, "w-after-write");
  const recovered = await restarted.tick();
  assert.equal(recovered.ok, true, recovered.error || "");
  assert.equal(recovered.recovered, 1);
  assert.equal(d1.state.tasks.get("cmd_write").status, "done");
  assert.equal(d1.state.tasks.get("cmd_write").attempts, 1);
});

test("a failed heartbeat write fails the tick instead of pretending it is healthy", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_beat", queued("cmd_beat"));
  d1.fail.heartbeat = 1;

  const worker = workerOver(d1, engine, "w-beat");
  const report = await worker.tick();
  assert.equal(report.ok, false);
  assert.match(report.error, /heartbeat write unavailable/);
  assert.equal(d1.state.tasks.get("cmd_beat").status, "queued", "no work was claimed on a failed tick");

  const next = await worker.tick();
  assert.equal(next.ok, true, next.error || "");
  assert.equal(d1.state.tasks.get("cmd_beat").status, "done");
});

test("a failed recovery write leaves the task working and the next tick recovers it", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_recover", working("cmd_recover", "w-dead", { leaseUntil: past() }));
  d1.fail.requeue = 1;

  const worker = workerOver(d1, engine, "w-recover");
  const failed = await worker.tick();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /requeue write unavailable/);
  assert.equal(d1.state.tasks.get("cmd_recover").status, "working", "nothing was lost or half-requeued");

  const recovered = await worker.tick();
  assert.equal(recovered.ok, true, recovered.error || "");
  assert.equal(recovered.recovered, 1);
  assert.equal(d1.state.tasks.get("cmd_recover").status, "done");
  assert.equal(d1.state.tasks.get("cmd_recover").attempts, 1);
});

test("a failed retention delete does not block execution", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_prune", queued("cmd_prune"));
  d1.fail.prune = 1;

  const worker = workerOver(d1, engine, "w-prune");
  const report = await worker.tick();
  assert.equal(report.ok, true, report.error || "");
  assert.equal(report.completed, 1);
  assert.equal(d1.state.tasks.get("cmd_prune").status, "done");
});
