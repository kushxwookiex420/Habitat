import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  createWorkforceV1Repository,
  WORKFORCE_V1_MIGRATION,
  WORKFORCE_V1_TABLE_NAMES
} from "../d1-workforce-v1-repository.mjs";
import { createWorkforceV1 } from "../ax-workforce-v1.mjs";
import { buildMissionEnvironment } from "../mission-harness.mjs";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";

/**
 * Autonomous workforce v1: durable leases, worker identity, failure recovery and the at-most-once ledger.
 *
 * The tests are adversarial on purpose. Executor spies count how many times an external operation is
 * released, so "the task failed" and "the outside world was touched twice" stay separate facts.
 */

const ROOT = process.cwd();
const quiet = { log() {}, warn() {}, error() {} };

function sqliteQuery(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    // RETURNING statements write and answer in one call.
    if (/\breturning\b/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
}

function clock(start = "2026-06-01T00:00:00.000Z") {
  let ms = Date.parse(start);
  return {
    now: () => ms,
    iso: () => new Date(ms).toISOString(),
    advance: (delta) => { ms += delta; },
    set: (value) => { ms = Date.parse(value); }
  };
}

async function layer({ db = null, tick = clock(), log = quiet } = {}) {
  const database = db || new DatabaseSync(":memory:");
  const repository = createWorkforceV1Repository({ query: sqliteQuery(database), now: tick.iso });
  await repository.initialize();
  const engine = createWorkforceV1({ repository, now: tick.now, log });
  return { db: database, repository, engine, tick };
}

function worker(id, overrides = {}) {
  return {
    id,
    label: id,
    specialty: "engineering",
    capabilities: ["engineering", "repo_analysis"],
    maxConcurrent: 1,
    ...overrides
  };
}

test("migration 0018 creates worker, lease, execution and recovery tables with the one-lease-per-task index", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = await readFile(path.join(ROOT, "migrations", "0018_ax_workforce_v1.sql"), "utf8");
  db.exec(sql);
  db.exec(sql); // idempotent
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const name of WORKFORCE_V1_TABLE_NAMES) assert.ok(tables.includes(name), "missing table " + name);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'habitat_ax_workforce_leases_active_task'").get();
  assert.match(String(index.sql), /UNIQUE/i);
  assert.match(String(index.sql), /WHERE state = 'active'/i);

  const insert = db.prepare("INSERT INTO habitat_ax_workforce_leases (lease_id, task_id, mission_id, worker_id, state, attempt, acquired_at, expires_at, record_json) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, '{}')");
  insert.run("lse_1", "msn_a.t1", "msn_a", "worker-a", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z");
  assert.throws(() => insert.run("lse_2", "msn_a.t1", "msn_a", "worker-b", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"), /UNIQUE/);
  // A closed lease does not block the task: history accumulates, ownership does not.
  db.prepare("UPDATE habitat_ax_workforce_leases SET state = 'expired' WHERE lease_id = 'lse_1'").run();
  assert.doesNotThrow(() => insert.run("lse_3", "msn_a.t1", "msn_a", "worker-b", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"));
  db.close();
});

test("worker identity validates capabilities, stays durable and reports derived health", async () => {
  const { db, engine, tick } = await layer();
  const missing = await engine.registerWorker({ id: "worker-empty", capabilities: [] });
  assert.equal(missing.code, "capabilities_required");
  const bad = await engine.registerWorker({ id: "worker-bad", capabilities: ["Engineering Repo"] });
  assert.equal(bad.code, "capability_invalid");

  const registered = await engine.registerWorker(worker("worker-a"));
  assert.equal(registered.ok, true);
  assert.equal(registered.created, true);
  assert.equal(WORKFORCE_V1_MIGRATION, "0018_ax_workforce_v1");

  assert.equal((await engine.workers())[0].health.status, "healthy");
  tick.advance(130_000); // past stalledAfterMs with no heartbeat
  assert.equal((await engine.workers())[0].health.status, "stalled");

  const beat = await engine.heartbeat({ id: "worker-a" });
  assert.equal(beat.ok, true);
  assert.equal(beat.health.status, "healthy");
  assert.equal((await engine.workers())[0].health.status, "healthy");
  db.close();
});

test("twenty simultaneous claims produce exactly one owner, across two independent instances", async () => {
  const tick = clock();
  const first = await layer({ tick });
  const second = await layer({ db: first.db, tick }); // same database, separate engine instance
  await first.engine.registerWorker(worker("worker-a", { maxConcurrent: 4 }));
  await first.engine.registerWorker(worker("worker-b", { maxConcurrent: 4 }));

  const workers = ["worker-a", "worker-b"];
  const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const engine = index % 2 === 0 ? first.engine : second.engine;
    const workerId = workers[index % workers.length];
    return engine.acquire({ taskId: "msn_race.t1", missionId: "msn_race", workerId, ttlMs: 60_000 });
  }));

  const created = claims.filter((claim) => claim.ok && claim.renewed !== true);
  assert.equal(created.length, 1, "exactly one acquisition creates the lease");
  for (const claim of claims.filter((item) => !created.includes(item))) {
    assert.ok(claim.ok === true ? claim.renewed === true : claim.code === "lease_held", "loser is a renewal or lease_held: " + JSON.stringify(claim));
  }
  const active = await first.repository.listLeases({ state: "active" });
  assert.equal(active.length, 1);
  assert.equal(active[0].leaseId, created[0].leaseId);
  first.db.close();
});

test("a stale lease cannot be renewed by its owner or released by anyone else", async () => {
  const { db, engine, tick } = await layer();
  await engine.registerWorker(worker("worker-a"));
  await engine.registerWorker(worker("worker-b"));
  const claimed = await engine.acquire({ taskId: "msn_stale.t1", missionId: "msn_stale", workerId: "worker-a", ttlMs: 30_000 });
  assert.equal(claimed.ok, true);

  // A renewal before expiry extends the lease.
  const fresh = await engine.renew({ leaseId: claimed.leaseId, workerId: "worker-a", ttlMs: 30_000 });
  assert.equal(fresh.ok, true);

  tick.advance(30_001); // the renewal window passed without another heartbeat of ownership
  const stale = await engine.renew({ leaseId: claimed.leaseId, workerId: "worker-a", ttlMs: 30_000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "lease_expired");

  const other = await engine.renew({ leaseId: claimed.leaseId, workerId: "worker-b" });
  assert.equal(other.code, "lease_not_owned");

  const history = await engine.recoveryHistory({ missionId: "msn_stale" });
  assert.ok(history.some((entry) => entry.kind === "lease.expired"), "expiry is journaled");
  db.close();
});

test("a crashed worker's lease expires, the task is reassigned and the recovery is recorded", async () => {
  const { db, engine, tick } = await layer();
  await engine.registerWorker(worker("worker-a"));
  await engine.registerWorker(worker("worker-b"));
  const crashed = await engine.acquire({ taskId: "msn_crash.t1", missionId: "msn_crash", workerId: "worker-a", ttlMs: 20_000 });
  assert.equal(crashed.ok, true);

  // The worker stops heartbeating and its lease runs out: no clean release ever arrives.
  tick.advance(25_000);
  const blocked = await engine.acquire({ taskId: "msn_crash.t1", missionId: "msn_crash", workerId: "worker-b" });
  assert.equal(blocked.ok, true, "an expired lease does not block a new owner");
  assert.notEqual(blocked.leaseId, crashed.leaseId);

  const old = await engine.lease(crashed.leaseId);
  assert.equal(old.state, "expired");
  assert.equal(old.reason, "lease_expired");

  const history = await engine.recoveryHistory({ missionId: "msn_crash" });
  const expired = history.find((entry) => entry.kind === "lease.expired" && entry.leaseId === crashed.leaseId);
  assert.ok(expired, "expiry of the crashed lease is in the recovery journal");
  assert.equal(expired.workerId, "worker-a");
  db.close();
});

test("a missed heartbeat refuses new work and deregistration is guarded while a lease is live", async () => {
  const { db, engine, tick } = await layer();
  await engine.registerWorker(worker("worker-a", { maxConcurrent: 2 }));
  const live = await engine.acquire({ taskId: "msn_guard.t1", missionId: "msn_guard", workerId: "worker-a", ttlMs: 300_000 });
  assert.equal(live.ok, true);

  const refused = await engine.deregisterWorker({ id: "worker-a", reason: "maintenance" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "worker_has_active_leases");

  tick.advance(200_000); // heartbeat is now stale, lease is still live
  const stalled = await engine.acquire({ taskId: "msn_guard.t2", missionId: "msn_guard", workerId: "worker-a" });
  assert.equal(stalled.ok, false);
  assert.equal(stalled.code, "worker_stalled");

  const detection = await engine.detectStalledWorkers();
  assert.deepEqual(detection.stalled, ["worker-a"]);
  const journaled = await engine.recoveryHistory({ missionId: null, kind: "worker.stalled" });
  assert.ok(journaled.some((entry) => entry.workerId === "worker-a"), "stall is journaled once");

  // A heartbeat restores availability; the lease itself is untouched.
  await engine.heartbeat({ id: "worker-a" });
  assert.equal((await engine.acquire({ taskId: "msn_guard.t2", missionId: "msn_guard", workerId: "worker-a" })).ok, true);

  const forced = await engine.deregisterWorker({ id: "worker-a", reason: "retired", force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.worker.state, "deregistered");
  assert.ok(forced.abandoned.length >= 1, "forced deregistration abandons live leases");
  assert.equal((await engine.heartbeat({ id: "worker-a" })).code, "worker_deregistered");
  assert.equal((await engine.acquire({ taskId: "msn_guard.t3", missionId: "msn_guard", workerId: "worker-a" })).code, "worker_deregistered");
  db.close();
});

test("capability declarations and capacity are enforced before a lease is written", async () => {
  const { db, engine } = await layer();
  await engine.registerWorker(worker("worker-a", { capabilities: ["engineering"], maxConcurrent: 1 }));
  const mismatch = await engine.acquire({ taskId: "msn_cap.t1", missionId: "msn_cap", workerId: "worker-a", requires: ["engineering", "finance"] });
  assert.equal(mismatch.code, "capability_missing");
  assert.deepEqual(mismatch.missing, ["finance"]);

  assert.equal((await engine.acquire({ taskId: "msn_cap.t1", missionId: "msn_cap", workerId: "worker-a", requires: ["engineering"] })).ok, true);
  const second = await engine.acquire({ taskId: "msn_cap.t2", missionId: "msn_cap", workerId: "worker-a", requires: ["engineering"] });
  assert.equal(second.code, "worker_at_capacity");
  db.close();
});

test("the execution ledger is at-most-once: in-flight, succeeded and uncertain attempts are refused", async () => {
  const { db, engine } = await layer();
  await engine.registerWorker(worker("worker-a"));
  const lease = await engine.acquire({ taskId: "msn_once.t1", missionId: "msn_once", workerId: "worker-a" });

  const first = await engine.executionBegin({ missionId: "msn_once", taskId: "msn_once.t1", workerId: "worker-a", attempt: 1, leaseId: lease.leaseId });
  assert.equal(first.ok, true);
  assert.equal(first.execution.state, "inflight");

  const duplicate = await engine.executionBegin({ missionId: "msn_once", taskId: "msn_once.t1", workerId: "worker-a", attempt: 1, leaseId: lease.leaseId });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "execution_in_flight");

  assert.equal((await engine.executionComplete({ idempotencyKey: first.idempotencyKey, state: "succeeded", result: { ok: true } })).ok, true);
  const afterSuccess = await engine.executionBegin({ missionId: "msn_once", taskId: "msn_once.t1", workerId: "worker-a", attempt: 2, leaseId: lease.leaseId });
  assert.equal(afterSuccess.code, "execution_already_succeeded");

  // A separate task: unknown outcome is terminal and cannot be rewritten as a retryable failure.
  const lease2 = await engine.acquire({ taskId: "msn_once.t2", missionId: "msn_once", workerId: "worker-a" });
  const started = await engine.executionBegin({ missionId: "msn_once", taskId: "msn_once.t2", workerId: "worker-a", attempt: 1, leaseId: lease2.leaseId });
  assert.equal((await engine.executionComplete({ idempotencyKey: started.idempotencyKey, state: "uncertain" })).ok, true);
  const downgrade = await engine.executionComplete({ idempotencyKey: started.idempotencyKey, state: "failed" });
  assert.equal(downgrade.code, "execution_outcome_uncertain");
  const retry = await engine.executionBegin({ missionId: "msn_once", taskId: "msn_once.t2", workerId: "worker-a", attempt: 2, leaseId: lease2.leaseId });
  assert.equal(retry.code, "outcome_uncertain");
  db.close();
});

test("an attempt left in flight by a dead owner becomes uncertain and is never retried", async () => {
  const { db, engine, tick } = await layer();
  await engine.registerWorker(worker("worker-a"));
  await engine.registerWorker(worker("worker-b"));
  const lease = await engine.acquire({ taskId: "msn_lost.t1", missionId: "msn_lost", workerId: "worker-a", ttlMs: 15_000 });
  const started = await engine.executionBegin({ missionId: "msn_lost", taskId: "msn_lost.t1", workerId: "worker-a", attempt: 1, leaseId: lease.leaseId });
  assert.equal(started.ok, true);

  tick.advance(20_000); // the owner dies without reporting an outcome
  const sweep = await engine.recoverUncertainExecutions();
  assert.deepEqual(sweep.uncertain, [started.idempotencyKey]);

  const record = await engine.execution(started.idempotencyKey);
  assert.equal(record?.state, "uncertain");
  const journal = await engine.recoveryHistory({ missionId: "msn_lost", kind: "outcome.uncertain" });
  assert.equal(journal.length, 1);

  // Even a fresh worker on a fresh lease cannot repeat a call whose outcome is unknown.
  const next = await engine.acquire({ taskId: "msn_lost.t1", missionId: "msn_lost", workerId: "worker-b" });
  assert.equal(next.ok, true);
  const refused = await engine.executionBegin({ missionId: "msn_lost", taskId: "msn_lost.t1", workerId: "worker-b", attempt: 2, leaseId: next.leaseId });
  assert.equal(refused.code, "outcome_uncertain");
  db.close();
});

test("state survives a process restart: worker, lease and ledger are re-read, not re-created", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "habitat-workforce-v1-" + process.pid + "-"));
  const dbPath = path.join(dir, "workforce.sqlite");
  const tick = clock();
  try {
    const firstDb = new DatabaseSync(dbPath);
    const first = await layer({ db: firstDb, tick });
    await first.engine.registerWorker(worker("worker-a"));
    await first.engine.registerWorker(worker("worker-b"));
    const lease = await first.engine.acquire({ taskId: "msn_restart.t1", missionId: "msn_restart", workerId: "worker-a", ttlMs: 600_000 });
    const started = await first.engine.executionBegin({ missionId: "msn_restart", taskId: "msn_restart.t1", workerId: "worker-a", attempt: 1, leaseId: lease.leaseId });
    assert.equal(started.ok, true);
    firstDb.close();

    const secondDb = new DatabaseSync(dbPath);
    const second = await layer({ db: secondDb, tick });
    const schema = await second.engine.verifySchema();
    assert.equal(schema.ok, true);
    const detail = await second.engine.worker("worker-a");
    assert.equal(detail.ok, true);
    assert.equal(detail.assignments.length, 1, "the live lease survived the restart");
    assert.equal(detail.assignments[0].leaseId, lease.leaseId);

    // A second worker still cannot take the task: the ownership row, not process memory, decides.
    const blocked = await second.engine.acquire({ taskId: "msn_restart.t1", missionId: "msn_restart", workerId: "worker-b" });
    assert.equal(blocked.code, "lease_held");

    // And the ledger still refuses the attempt that was already in flight.
    const refused = await second.engine.executionBegin({ missionId: "msn_restart", taskId: "msn_restart.t1", workerId: "worker-a", attempt: 1, leaseId: lease.leaseId });
    assert.equal(refused.code, "execution_in_flight");
    secondDb.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("monitoring reports health, assignments, expirations, retries, recovery events and durations", async () => {
  const tick = clock();
  const { db, engine } = await layer({ tick });
  await engine.registerWorker(worker("worker-a"));
  await engine.registerWorker(worker("worker-b"));
  const done = await engine.acquire({ taskId: "msn_monitor.t1", missionId: "msn_monitor", workerId: "worker-a", ttlMs: 60_000 });
  const execution = await engine.executionBegin({ missionId: "msn_monitor", taskId: "msn_monitor.t1", workerId: "worker-a", attempt: 1, leaseId: done.leaseId });
  await engine.executionComplete({ idempotencyKey: execution.idempotencyKey, state: "succeeded" });
  await engine.release({ leaseId: done.leaseId, workerId: "worker-a", state: "completed", reason: "verified" });

  await engine.acquire({ taskId: "msn_monitor.t2", missionId: "msn_monitor", workerId: "worker-b", ttlMs: 60_000 });
  tick.advance(90_000);
  await engine.expireAbandonedLeases();

  const missions = [
    { id: "msn_monitor", status: "completed", updatedAt: tick.iso() },
    { id: "msn_idle", status: "running", updatedAt: new Date(tick.now() - 30 * 60_000).toISOString() }
  ];
  const status = await engine.status({ missions });
  assert.equal(status.workers.total, 2);
  assert.equal(status.leases.total >= 2, true);
  assert.equal(status.leases.expired, 1);
  assert.equal(status.executions.succeeded, 1);
  assert.equal(status.recovery.total > 0, true);
  assert.equal(status.missions.stalled, 1);
  assert.equal(status.missions.items.length, 1);
  assert.equal(status.health.ok, false);
  assert.ok(status.missions.durations.some((entry) => entry.missionId === "msn_monitor" && entry.final === true), "a completed mission has a final duration");
  db.close();
});

/* ── mission engine integration ─────────────────────────────────────────────────────────────── */

async function missionStack({ tick, executorOverrides = {}, verifierOverride = null, maxTaskAttempts = 1 }) {
  const base = await mkdtemp(path.join(os.tmpdir(), "habitat-workforce-mission-" + process.pid + "-"));
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(base, "artifacts"),
    dbPath: ":memory:",
    maxTaskAttempts,
    verifierOverride,
    executorOverrides,
    ownerVerifier: createOwnerAttestation({ secret: "workforce-v1-secret-" + "s".repeat(24), now: tick.iso }),
    leases: async ({ query }) => {
      const repository = createWorkforceV1Repository({ query, now: tick.iso });
      await repository.initialize();
      return createWorkforceV1({ repository, now: tick.now, log: quiet });
    }
  });
  for (const agent of env.workforce.agents()) {
    const registered = await env.leases.registerWorker({
      id: agent.id,
      label: agent.name,
      specialty: agent.specialty,
      adapterId: agent.adapterId,
      capabilities: agent.capabilities,
      maxConcurrent: agent.availability?.maxConcurrent || 1
    });
    assert.equal(registered.ok, true, "worker registration for " + agent.id);
  }
  return { base, env };
}

const CRITERIA = ["Repository analysed"];
const TASKS = [{ id: "t1", title: "Analyse the repository", requires: ["engineering"], criteria: [0] }];

test("a verification failure fails the task but never repeats the external operation", async () => {
  const tick = clock();
  const calls = { implementation: 0, verification: 0, executionKey: null };
  const { base, env } = await missionStack({
    tick,
    executorOverrides: {
      "eng.repo": async ({ task }) => {
        calls.implementation += 1;
        // The executor is handed the idempotency key it must forward to any external provider.
        calls.executionKey = task.executionKey || null;
        return { result: { status: "completed", evidence: ["spy:" + task.id], changedFiles: [], tests: { ran: 1, passed: 1, failed: 0 } } };
      }
    },
    verifierOverride: async () => {
      calls.verification += 1;
      return { ok: false, evidence: ["verifier:rejected"], tests: { ran: 1, passed: 0, failed: 1 } };
    }
  });
  try {
    const submitted = await env.missions.intake({ project: "habitat", objective: "Analyse only", acceptanceCriteria: CRITERIA, tasks: TASKS });
    assert.equal(submitted.ok, true);
    await env.missions.execute(submitted.missionId);
    assert.equal(calls.implementation, 1);
    assert.equal(typeof calls.executionKey, "string");
    // mission|mission.task|attempt — the same key the ledger uses, handed to the executor.
    assert.equal(calls.executionKey, submitted.missionId + "|" + submitted.missionId + ".t1|a1");

    const stored = await env.missionStore.get(submitted.missionId);
    assert.equal(stored.record.tasks[0].status, "failed");
    assert.match(String(stored.record.tasks[0].error), /verification/);
    const executions = await env.leases.executionsFor({ missionId: submitted.missionId });
    assert.equal(executions.length, 1);
    assert.equal(executions[0].state, "succeeded", "the operation is recorded as having happened");

    // A repair run must not re-release the operation just because its proof was refused.
    await env.missions.execute(submitted.missionId);
    assert.equal(calls.implementation, 1, "spy: no duplicate external operation");
    assert.equal(calls.verification, 1);
  } finally {
    env.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("an uncertain external outcome stops the task without a retry and leaves an uncertain lease", async () => {
  const tick = clock();
  const calls = { implementation: 0 };
  const { base, env } = await missionStack({
    tick,
    executorOverrides: {
      "eng.repo": async () => {
        calls.implementation += 1;
        const error = new Error("gateway timeout after submit");
        error.uncertain = true;
        throw error;
      }
    }
  });
  try {
    const submitted = await env.missions.intake({ project: "habitat", objective: "Contact the outside world", acceptanceCriteria: CRITERIA, tasks: TASKS });
    assert.equal(submitted.ok, true);
    const first = await env.missions.execute(submitted.missionId);
    assert.equal(first.status, "failed");
    assert.equal(calls.implementation, 1);

    const stored = await env.missionStore.get(submitted.missionId);
    assert.equal(stored.record.tasks[0].error, "outcome_uncertain");
    assert.ok(stored.record.tasks[0].leaseId, "the refused lease stays on the task for the audit trail");
    assert.equal((await env.leases.lease(stored.record.tasks[0].leaseId)).state, "uncertain");

    const executions = await env.leases.executionsFor({ missionId: submitted.missionId });
    assert.equal(executions.length, 1);
    assert.equal(executions[0].state, "uncertain");

    // Nothing about a later run may release the operation again.
    await env.missions.execute(submitted.missionId);
    await env.missions.recover({ limit: 5 });
    assert.equal(calls.implementation, 1, "spy: uncertain outcome is never retried");
  } finally {
    env.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a mission resumes through recovery after its leased attempt lost ownership", async () => {
  const tick = clock();
  const calls = { implementation: 0 };
  const { base, env } = await missionStack({
    tick,
    executorOverrides: {
      "eng.repo": async ({ task }) => {
        calls.implementation += 1;
        return { result: { status: "completed", evidence: ["spy:" + task.id], changedFiles: [], tests: { ran: 1, passed: 1, failed: 0 } } };
      }
    }
  });
  try {
    const submitted = await env.missions.intake({ project: "habitat", objective: "Resume after a crash", acceptanceCriteria: CRITERIA, tasks: TASKS });
    assert.equal(submitted.ok, true);

    // Simulate a crash mid-task: an active lease and an in-flight execution exist, the task is running, and
    // no process is around to finish it.
    const taskKey = submitted.missionId + ".t1";
    const lease = await env.leases.acquire({ taskId: taskKey, missionId: submitted.missionId, workerId: "worker-engineering", ttlMs: 10_000 });
    assert.equal(lease.ok, true);
    const started = await env.leases.executionBegin({ missionId: submitted.missionId, taskId: taskKey, workerId: "worker-engineering", attempt: 1, leaseId: lease.leaseId });
    assert.equal(started.ok, true);
    const loaded = await env.missionStore.get(submitted.missionId);
    loaded.record.status = "running";
    loaded.record.tasks[0].status = "running";
    loaded.record.tasks[0].assignmentId = "asg_manual";
    loaded.record.tasks[0].leaseId = lease.leaseId;
    await env.missionStore.save(loaded.record, loaded.version);

    tick.advance(60_000); // the worker is gone; its lease and its heartbeat are stale
    const recovery = await env.missions.recover({ limit: 5 });
    assert.equal(recovery.recovered, 1);
    assert.equal(recovery.leaseRecovery.uncertain >= 1, true, "the orphaned attempt is marked uncertain");

    const events = await env.missionStore.events(submitted.missionId);
    assert.ok(events.some((event) => event.type === "mission.resumed"), "the resume is journaled");
    assert.ok(events.some((event) => event.type === "task.outcome_uncertain"), "the unknown outcome is recorded");
    assert.equal(calls.implementation, 0, "spy: the uncertain operation is not repeated on resume");

    const after = await env.missionStore.get(submitted.missionId);
    assert.equal(after.record.tasks[0].status, "failed");
    assert.equal(after.record.tasks[0].error, "outcome_uncertain");
  } finally {
    env.close();
    await rm(base, { recursive: true, force: true });
  }
});
