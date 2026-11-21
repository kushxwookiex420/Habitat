import test from "node:test";
import assert from "node:assert/strict";
import {
  createNexusWorker,
  registerNexusRuntime,
  readQueueHealth,
  resolveNexusConfig,
  assertReadOnlyAdapters,
  NEXUS_HEARTBEAT_SQL,
  NEXUS_PRUNE_SQL,
  NEXUS_QUEUE_SQL,
  NEXUS_EXPIRED_SQL,
  NEXUS_CLAIM_SQL
} from "../nexus-runtime.mjs";

/**
 * Autonomous-execution foundation: the policy that keeps a 24/7 worker affordable and honest.
 *
 * Nothing here talks to D1 over the network. Each test states the behaviour an operator depends on:
 * bounded heartbeat writes, bounded retention, a queue alarm that means throughput, an adapter
 * policy that fails at mount, and status that never reports success it did not observe.
 */

const AX = "ax_bridge_" + "a".repeat(40);
const quiet = { log() {}, warn() {}, error() {} };

// ---- configuration -------------------------------------------------------

test("worker configuration has safe defaults and rejects values that defeat the write budget", () => {
  const defaults = resolveNexusConfig({});
  assert.equal(defaults.pollMs, 5000);
  assert.equal(defaults.leaseMs, 300000);
  assert.equal(defaults.maxAttempts, 3);
  assert.equal(defaults.heartbeatMs, 30000, "30 s floor by default");
  assert.equal(defaults.retentionDays, 7);
  assert.equal(defaults.staleQueueMs, 600000);

  // A heartbeat faster than the floor is rejected, not clamped: silently accepting it would
  // reintroduce the D1 write pressure the floor exists to prevent.
  assert.throws(() => resolveNexusConfig({ NEXUS_HEARTBEAT_SECONDS: "29" }), /NEXUS_HEARTBEAT_SECONDS/);
  assert.throws(() => resolveNexusConfig({ NEXUS_HEARTBEAT_SECONDS: "fast" }), /NEXUS_HEARTBEAT_SECONDS/);
  assert.throws(() => resolveNexusConfig({ NEXUS_MAX_ATTEMPTS: "0" }), /NEXUS_MAX_ATTEMPTS/);
  assert.throws(() => resolveNexusConfig({ NEXUS_RETENTION_DAYS: "0" }), /NEXUS_RETENTION_DAYS/);
  assert.equal(resolveNexusConfig({ NEXUS_HEARTBEAT_SECONDS: "120" }).heartbeatMs, 120000);
});

// ---- heartbeat throttle --------------------------------------------------

function countingQuery({ heartbeatRows = [], queueRow = null } = {}) {
  const calls = { heartbeat: 0, prune: 0, expired: 0, claim: 0, queue: 0 };
  const query = async (sql, params = []) => {
    if (sql === NEXUS_HEARTBEAT_SQL) { calls.heartbeat += 1; return [{ results: [] }]; }
    if (sql === NEXUS_PRUNE_SQL) { calls.prune += 1; return [{ results: heartbeatRows }]; }
    if (sql === NEXUS_EXPIRED_SQL) { calls.expired += 1; return [{ results: [] }]; }
    if (sql === NEXUS_CLAIM_SQL) { calls.claim += 1; return [{ results: [] }]; }
    if (sql === NEXUS_QUEUE_SQL) { calls.queue += 1; return [{ results: queueRow ? [queueRow] : [] }]; }
    return [{ results: [] }];
  };
  return { query, calls };
}

function idleWorker(query, overrides = {}) {
  return createNexusWorker({
    repository: { async get() { return null; }, async update() { return null; } },
    engine: { async complete() { return { ok: true }; }, async fail() { return { ok: true }; } },
    query,
    adapters: {},
    workerId: "nexus-test",
    log: quiet,
    ...overrides
  });
}

test("idle ticks do not write a heartbeat more than once per interval", async () => {
  const { query, calls } = countingQuery();
  const worker = idleWorker(query);

  await worker.tick();
  const afterFirst = calls.heartbeat;
  await worker.tick();
  await worker.tick();

  assert.equal(afterFirst, 1, "the first tick records liveness");
  assert.equal(calls.heartbeat, 1, "consecutive idle ticks inside 30 s write nothing");
  assert.equal(calls.prune, 1, "retention is attempted once, not once per tick");
});

test("the heartbeat policy still writes when the state actually changes", async () => {
  const { query, calls } = countingQuery();
  const worker = idleWorker(query);
  await worker.tick();
  const before = calls.heartbeat;
  await worker.start();
  await worker.stop("test");
  assert.ok(calls.heartbeat > before, "lifecycle transitions are never throttled");
  assert.equal(worker.isStopped(), true);
});

// ---- retention -----------------------------------------------------------

test("retention deletes only other workers' rows older than the cutoff", async () => {
  const { query } = countingQuery({ heartbeatRows: [{ worker_id: "old-a" }, { worker_id: "old-b" }] });
  const seen = [];
  const recording = async (sql, params) => { seen.push({ sql, params }); return query(sql, params); };
  const worker = idleWorker(recording, { retentionDays: 7, workerId: "nexus-current" });

  const result = await worker.pruneWorkerHeartbeats({ force: true });

  assert.equal(result.pruned, true);
  assert.equal(result.removed, 2);
  const prune = seen.find(call => call.sql === NEXUS_PRUNE_SQL);
  assert.ok(prune, "the prune statement ran");
  assert.equal(prune.params[0], "nexus-current", "never deletes this worker's own row");
  const cutoffAge = Date.now() - Date.parse(prune.params[1]);
  assert.ok(cutoffAge >= 6.9 * 86_400_000 && cutoffAge <= 7.1 * 86_400_000, "cutoff is about seven days ago");
});

test("retention failure never fails a tick", async () => {
  const query = async sql => {
    if (sql === NEXUS_PRUNE_SQL) throw new Error("D1 does not support that statement here");
    return [{ results: [] }];
  };
  const worker = idleWorker(query);
  const tick = await worker.tick();
  assert.equal(tick.ok, true, "housekeeping cannot break execution");
});

// ---- queue health and the alarm -----------------------------------------

test("queue health separates claimable work from work that waits for a human", async () => {
  const oldest = new Date(Date.now() - 700_000).toISOString();
  const { query } = countingQuery({ queueRow: { eligible: 2, blocked: 1, oldest } });
  const health = await readQueueHealth(query, { staleAfterMs: 600_000 });
  assert.equal(health.eligible, 2);
  assert.equal(health.blocked, 1);
  assert.equal(health.claimable, true);
  assert.equal(health.stale, true);
  assert.ok(health.oldestEligibleAgeSeconds >= 690 && health.oldestEligibleAgeSeconds <= 720);
});

test("an empty or young queue is not stale", async () => {
  const { query: empty } = countingQuery({ queueRow: { eligible: 0, blocked: 3, oldest: null } });
  assert.equal((await readQueueHealth(empty, { staleAfterMs: 600_000 })).stale, false);

  const young = new Date(Date.now() - 5_000).toISOString();
  const { query: fresh } = countingQuery({ queueRow: { eligible: 1, blocked: 0, oldest: young } });
  const health = await readQueueHealth(fresh, { staleAfterMs: 600_000 });
  assert.equal(health.eligible, 1);
  assert.equal(health.stale, false, "a five-second-old task is not an alarm");
});

// ---- adapter policy ------------------------------------------------------

test("side-effecting adapters are refused at mount, read-only ones are accepted", () => {
  assert.deepEqual(assertReadOnlyAdapters({ "runtime.health": async () => ({ ok: true }) }), ["runtime.health"]);
  assert.throws(() => assertReadOnlyAdapters({ "shell.exec": async () => ({ ok: true }) }), /disabled until idempotency/);
  assert.throws(
    () => assertReadOnlyAdapters({ "runtime.health": async () => ({ ok: true }), "android.command": async () => ({ ok: true }) }),
    /android\.command/
  );

  const app = { get() {}, post() {} };
  assert.throws(
    () => registerNexusRuntime(app, {
      env: { HABITAT_AX_BRIDGE_TOKEN: AX },
      repository: { async get() { return null; }, async initialize() {}, async list() {} },
      query: async () => [{ results: [] }],
      adapters: { "android.command": async () => ({ ok: true }) },
      handleSignals: false,
      log: quiet
    }),
    /disabled until idempotency/
  );
});

// ---- honest status -------------------------------------------------------

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "route exists: " + key);
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let index = 0;
  let called = true;
  while (index < handlers.length && called) {
    called = false;
    await handlers[index](req, res, () => { called = true; index += 1; });
  }
  return res;
}

function runtimeHarness({ workerRows = [], queueRow = null, env = {} } = {}) {
  const app = makeApp();
  const query = async sql => {
    if (typeof sql === "string" && sql.startsWith("SELECT worker_id")) return [{ results: workerRows }];
    if (sql === NEXUS_QUEUE_SQL) return [{ results: queueRow ? [queueRow] : [] }];
    return [{ results: [] }];
  };
  const runtime = registerNexusRuntime(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX, ...env },
    repository: { async get() { return null; }, async initialize() {}, async list() { return { ok: true, tasks: [] }; } },
    query,
    engine: { async list() { return { ok: true, tasks: [] }; }, async get() { return null; }, async approve() { return { ok: true }; }, async deny() { return { ok: true }; }, async cancel() { return { ok: true }; } },
    handleSignals: false,
    log: quiet
  });
  return { app, runtime };
}

test("status distinguishes not-mounted, not-started and running", async () => {
  const mounted = runtimeHarness();
  // Before initialize() the storage tables may not exist yet, so the honest state is "not ready".
  assert.equal(mounted.runtime.status().state, "mounted_not_ready");
  await mounted.runtime.initialize({ startWorker: false });
  assert.equal(mounted.runtime.status().state, "mounted_not_started");
  await mounted.runtime.startWorker();
  assert.equal(mounted.runtime.status().state, "running");
  assert.equal(mounted.runtime.status().lastTick.ok, true, "the start tick is reported");
  await mounted.runtime.shutdown("test");
});

test("the runtime endpoint says when nothing is executing instead of implying success", async () => {
  const asleep = runtimeHarness({ workerRows: [], queueRow: { eligible: 4, blocked: 0, oldest: new Date(Date.now() - 3_600_000).toISOString() } });
  await asleep.runtime.initialize({ startWorker: false });
  const body = await invoke(asleep.app, "GET /nexus/runtime", { headers: { authorization: "Bearer " + AX } });

  assert.equal(body.statusCode, 200);
  assert.equal(body.body.runtime.state, "mounted_not_started");
  assert.equal(body.body.runtime.asleep, true, "no live heartbeat is reported as asleep");
  assert.equal(body.body.runtime.heartbeatVerified, false);
  assert.equal(body.body.runtime.queue.stale, true, "a one-hour backlog is flagged");
  assert.equal(body.body.runtime.staleQueue, true);
  assert.match(body.body.runtime.sleepingNote, /nothing is executing/);
});

test("a live heartbeat and an empty queue report running without an alarm", async () => {
  const live = runtimeHarness({
    workerRows: [{ worker_id: "nexus-live", started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), state: "idle", claimed: 0, completed: 0, failed: 0, detail: null }],
    queueRow: { eligible: 0, blocked: 0, oldest: null }
  });
  await live.runtime.initialize({ startWorker: true });
  const body = await invoke(live.app, "GET /nexus/runtime", { headers: { authorization: "Bearer " + AX } });

  assert.equal(body.body.runtime.state, "running");
  assert.equal(body.body.runtime.asleep, false);
  assert.equal(body.body.runtime.staleQueue, false);
  assert.equal(body.body.runtime.queue.eligible, 0);
  await live.runtime.shutdown("test");
});

test("a claim failure is reported as a failed tick, not as an idle one", async () => {
  const query = async sql => {
    if (sql === NEXUS_CLAIM_SQL) throw new Error("D1 claim statement failed");
    return [{ results: [] }];
  };
  const worker = idleWorker(query);
  const tick = await worker.tick();

  assert.equal(tick.ok, false);
  assert.equal(tick.stage, "tick");
  assert.match(tick.error, /claim statement failed/);
  assert.equal(worker.lastTick().ok, false, "the failure survives for the status surface");
  assert.deepEqual(worker.counters().claimed, 0);
});
