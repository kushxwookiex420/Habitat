import test from "node:test";
import assert from "node:assert/strict";
import { createNexusWorker } from "../nexus-runtime.mjs";

/**
 * Crash/restart recovery behaviour for the NEXUS executor.
 *
 * A "restart" is modelled as a brand-new worker instance over the same durable store: the old
 * worker's heartbeat stops, its in-memory renewal timer is gone, and only the fence + lease in the
 * task record remain. These tests pin the guarantees an operator relies on after a Render restart:
 * a live lease is never stolen, an expired one is recovered exactly once, retries are counted, and
 * terminal work is never resurrected.
 *
 * The store here is a small behavioural double, not Cloudflare D1. Real D1 recovery remains
 * unverified until the approved live run.
 */

const past = () => "2000-01-01T00:00:00.000Z";
const future = () => new Date(Date.now() + 600_000).toISOString();

function miniD1() {
  const state = { tasks: new Map(), heartbeats: [] };
  let busy = false;
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    if (/^CREATE TABLE/.test(text)) return [{ results: [] }];
    if (text.startsWith("INSERT INTO habitat_nexus_workers")) {
      state.heartbeats.push({ workerId: params[0], at: params[2], state: params[3] });
      return [{ results: [] }];
    }
    if (text.startsWith("DELETE FROM habitat_nexus_workers")) return [{ results: [] }];
    if (text.startsWith("UPDATE habitat_command_tasks SET status = 'working'")) {
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
      // requeue: [attempts, at, at, id, fence]
      const [attempts, at, , id, fence] = params;
      const task = state.tasks.get(id);
      if (!task || task.status !== "working" || (task.fence ?? null) !== (fence ?? null)) return [{ results: [] }];
      Object.assign(task, { status: "queued", attempts, claimedBy: null, leaseUntil: null, fence: null, updatedAt: at });
      return [{ results: [{ id }] }];
    }
    if (text.startsWith("SELECT id, record_json") && text.includes("leaseUntil")) {
      const at = params[0];
      const floor = params[1];
      const expired = [...state.tasks.values()]
        .filter(task => task.status === "working" && (
          (task.leaseUntil && task.leaseUntil < at) ||
          (!task.leaseUntil && String(task.updatedAt || "") < floor)
        ))
        .slice(0, 10)
        .map(task => ({ id: task.id, record_json: JSON.stringify(task) }));
      return [{ results: expired }];
    }
    throw new Error("unexpected SQL in restart harness: " + text.slice(0, 80));
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

function engineOver(d1) {
  const patch = (taskId, changes) => {
    const task = d1.state.tasks.get(taskId);
    if (!task) return null;
    d1.state.tasks.set(taskId, { ...task, ...changes });
    return structuredClone(d1.state.tasks.get(taskId));
  };
  return {
    async complete(options) {
      assert.equal(options.result.evidence.length > 0, true, "completion requires evidence");
      return { ok: true, task: patch(options.taskId, { status: "done", result: { ...options.result, verifiedBy: options.verifiedBy }, error: null }) };
    },
    async fail(options) { return { ok: true, task: patch(options.taskId, { status: "failed", error: options.error }) }; },
    async list() { return { ok: true, tasks: [] }; }
  };
}

const quiet = { log() {}, warn() {}, error() {} };
const adapters = {
  "task.ok": async task => ({ summary: "did " + task.id, evidence: ["restart:" + task.id], decisions: [], blockers: [] })
};

function workerOver(d1, engine, workerId) {
  return createNexusWorker({
    repository: repositoryOver(d1),
    engine,
    query: d1.query,
    adapters,
    workerId,
    pollMs: 60_000,
    renewLease: false,
    log: quiet
  });
}

function crashedTask(id, extra = {}) {
  return {
    id,
    objective: "survive a restart",
    status: "working",
    role: "ax",
    adapter: "task.ok",
    attempts: 0,
    requestedBy: "ax",
    approvals: [],
    claimedBy: "worker-before-crash",
    fence: "fence-before-crash",
    leaseUntil: future(),
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    ...extra
  };
}

test("a restarted worker never steals a live lease from the crashed process", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_live", crashedTask("cmd_live"));

  const restarted = workerOver(d1, engine, "worker-after-restart");
  const outcome = await restarted.recoverExpired();

  assert.deepEqual(outcome, { requeued: 0, exhausted: 0, lost: 0 });
  const task = d1.state.tasks.get("cmd_live");
  assert.equal(task.status, "working", "live work is not requeued early");
  assert.equal(task.claimedBy, "worker-before-crash", "ownership is untouched while the lease is valid");
  assert.equal(task.fence, "fence-before-crash");
});

test("after the lease expires, a restarted worker recovers the task exactly once and counts the attempt", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_expired", crashedTask("cmd_expired", { leaseUntil: past() }));

  const restarted = workerOver(d1, engine, "worker-after-restart");
  const outcome = await restarted.recoverExpired();

  assert.deepEqual(outcome, { requeued: 1, exhausted: 0, lost: 0 });
  const task = d1.state.tasks.get("cmd_expired");
  assert.equal(task.status, "queued");
  assert.equal(task.attempts, 1, "the crash consumed one attempt");
  assert.equal(task.claimedBy, null, "the dead worker's ownership is released");
  assert.equal(task.fence, null, "the dead worker's fence is released");

  // A second recoverer sees nothing left to do: recovery is not cumulative.
  assert.deepEqual(await restarted.recoverExpired(), { requeued: 0, exhausted: 0, lost: 0 });
});

test("one tick after a restart recovers the dead lease and completes the task under the new worker", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_resume", crashedTask("cmd_resume", { leaseUntil: past() }));

  const restarted = workerOver(d1, engine, "worker-after-restart");
  const report = await restarted.tick();

  assert.equal(report.ok, true, report.error || "");
  assert.equal(report.recovered, 1, "the tick recovered expired work before claiming");
  assert.equal(report.claimed, 1);
  assert.equal(report.completed, 1);
  const task = d1.state.tasks.get("cmd_resume");
  assert.equal(task.status, "done");
  assert.equal(task.result.verifiedBy, "worker-after-restart");
  assert.deepEqual(task.result.evidence, ["restart:cmd_resume"]);
  assert.equal(task.attempts, 1);
});

test("restart recovery never resurrects completed or failed work", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  d1.state.tasks.set("cmd_done", crashedTask("cmd_done", { status: "done", leaseUntil: past() }));
  d1.state.tasks.set("cmd_failed", crashedTask("cmd_failed", { status: "failed", leaseUntil: past() }));

  const restarted = workerOver(d1, engine, "worker-after-restart");
  assert.deepEqual(await restarted.recoverExpired(), { requeued: 0, exhausted: 0, lost: 0 });
  assert.equal(d1.state.tasks.get("cmd_done").status, "done");
  assert.equal(d1.state.tasks.get("cmd_failed").status, "failed");
});

test("a task that never received a lease is recovered after the lease window, not immediately", async () => {
  const d1 = miniD1();
  const engine = engineOver(d1);
  // 'working' with no lease: the path a crash between status write and claim would leave behind.
  d1.state.tasks.set("cmd_nolease", crashedTask("cmd_nolease", {
    claimedBy: null,
    fence: null,
    leaseUntil: null,
    updatedAt: new Date().toISOString()
  }));

  const restarted = workerOver(d1, engine, "worker-after-restart");
  assert.deepEqual(await restarted.recoverExpired(), { requeued: 0, exhausted: 0, lost: 0 }, "fresh row is left to finish or time out");

  d1.state.tasks.get("cmd_nolease").updatedAt = past();
  assert.deepEqual(await restarted.recoverExpired(), { requeued: 1, exhausted: 0, lost: 0 });
  assert.equal(d1.state.tasks.get("cmd_nolease").status, "queued");
});
