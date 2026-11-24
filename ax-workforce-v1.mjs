import { randomBytes } from "node:crypto";
import { LEASE_STATES, WORKER_STATES, WORKFORCE_V1_MIGRATION } from "./d1-workforce-v1-repository.mjs";

/**
 * Autonomous workforce v1.
 *
 * This is not a second mission engine. The mission engine still plans, gates approvals, delegates through
 * the workforce registry and requires independent verification. This module adds the durable safety layer
 * around execution that an in-memory assignment cannot provide:
 *
 *   identity     a worker registers, declares capabilities, heartbeats, and can be deregistered
 *   leases       exactly one live lease per task, acquired atomically, renewable, releasable
 *   failure      missed heartbeats, stalled workers, expired leases, abandoned work, restarts
 *   at-most-once an execution ledger keyed by attempt, so a retry never repeats an external operation
 *   monitoring   worker health, assignments, expirations, retries, failures, stalled missions, durations
 *
 * Three rules are enforced here rather than trusted to callers:
 *
 *   1. A worker that cannot prove it is alive does not receive work. A stale heartbeat is a refusal, not a
 *      warning, because a worker that is merely slow will recover and ask again.
 *   2. A lease that has expired can never be renewed. A process that was partitioned from the store and
 *      wakes up later must not extend a grant another worker may already hold.
 *   3. An outcome that is unknown is never repeated automatically. A crash between "we called the outside
 *      world" and "we recorded the answer" leaves the attempt `uncertain`, and `uncertain` is terminal
 *      until a human decides what to do. Refusing to repeat is the only safe default.
 */

export const WORKFORCE_V1_FLAG = "HABITAT_WORKFORCE_ENABLED";

export const WORKFORCE_V1_LIMITS = Object.freeze({
  leaseTtlMs: 60_000,
  heartbeatIntervalMs: 30_000,
  /** A worker with no heartbeat for this long is stalled: its leases are allowed to expire. */
  stalledAfterMs: 120_000,
  /** A mission whose record has not moved for this long is reported as stalled, never silently retried. */
  missionStallAfterMs: 15 * 60_000,
  maxConcurrent: 1
});

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,119}$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const TERMINAL_LEASE_STATES = Object.freeze(["released", "completed", "abandoned", "uncertain"]);

function text(value, limit = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => text(item, 80)).filter(Boolean) : [];
}

function id(value) {
  const clean = text(value, 120);
  return ID_PATTERN.test(clean) ? clean : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function age(isoString, at) {
  const parsed = Date.parse(String(isoString || ""));
  return Number.isFinite(parsed) ? Math.max(0, at - parsed) : Infinity;
}

export function createWorkforceV1({
  repository,
  now = () => Date.now(),
  leaseTtlMs = WORKFORCE_V1_LIMITS.leaseTtlMs,
  heartbeatIntervalMs = WORKFORCE_V1_LIMITS.heartbeatIntervalMs,
  stalledAfterMs = WORKFORCE_V1_LIMITS.stalledAfterMs,
  missionStallAfterMs = WORKFORCE_V1_LIMITS.missionStallAfterMs,
  defaultMaxConcurrent = WORKFORCE_V1_LIMITS.maxConcurrent,
  log = console
} = {}) {
  if (!repository || typeof repository.saveWorker !== "function") {
    throw new Error("The workforce v1 needs a repository.");
  }
  let initialized = null;

  async function record(kind, { missionId = null, taskId = null, workerId = null, leaseId = null, detail = {} } = {}) {
    const entry = { at: iso(now()), kind, missionId, taskId, workerId, leaseId, detail };
    try {
      await repository.appendRecovery([entry]);
    } catch (error) {
      // The journal is audit. A storage hiccup must not turn a successful release into a failed one, but it
      // is reported so a silent hole in the recovery history is visible in the log.
      log.warn?.("WORKFORCE_RECOVERY_JOURNAL_FAILED", String(error?.message || error).slice(0, 160));
    }
    return entry;
  }

  function deriveHealth(worker, at = now()) {
    if (worker.state === "deregistered") return { status: "deregistered", heartbeatAgeMs: null, stale: false };
    if (!worker.heartbeatAt) return { status: "never_heartbeat", heartbeatAgeMs: null, stale: true, detail: "The worker has registered but never sent a heartbeat." };
    const heartbeatAgeMs = age(worker.heartbeatAt, at);
    if (heartbeatAgeMs > stalledAfterMs) {
      return { status: "stalled", heartbeatAgeMs, stale: true, detail: "No heartbeat for " + Math.round(heartbeatAgeMs / 1000) + "s; leases may expire." };
    }
    if (worker.state === "unavailable") return { status: "unavailable", heartbeatAgeMs, stale: false, detail: worker.detail || null };
    if (worker.state === "draining") return { status: "draining", heartbeatAgeMs, stale: false };
    if (heartbeatAgeMs > heartbeatIntervalMs * 2) return { status: "degraded", heartbeatAgeMs, stale: false, detail: "Heartbeat is later than expected." };
    return { status: worker.state === "busy" ? "busy" : "healthy", heartbeatAgeMs, stale: false };
  }

  async function initialize() {
    if (!initialized) {
      initialized = (async () => {
        const result = await repository.initialize();
        return { ok: true, ...result };
      })().catch((error) => { initialized = null; throw error; });
    }
    return initialized;
  }

  async function verifySchema() {
    if (typeof repository.verifySchema !== "function") return { ok: false, missing: [], expected: 0, migration: WORKFORCE_V1_MIGRATION };
    return repository.verifySchema();
  }

  /* ── worker identity ─────────────────────────────────────────────────────────────────────────── */

  async function registerWorker({
    id: rawId,
    label = null,
    specialty = "coding",
    adapterId = null,
    capabilities = [],
    maxConcurrent = defaultMaxConcurrent,
    accepting = true,
    state = "online",
    metadata = null
  } = {}) {
    const workerId = id(rawId);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const caps = [...new Set(list(capabilities))];
    if (caps.length === 0) return { ok: false, code: "capabilities_required" };
    const invalid = caps.filter((capability) => !CAPABILITY_PATTERN.test(capability));
    if (invalid.length) return { ok: false, code: "capability_invalid", invalid };
    if (!WORKER_STATES.includes(state) || state === "deregistered") return { ok: false, code: "worker_state_invalid" };
    const concurrency = Number(maxConcurrent);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return { ok: false, code: "max_concurrent_invalid" };

    const at = iso(now());
    const existing = await repository.getWorker(workerId);
    const worker = {
      id: workerId,
      label: text(label || workerId, 120),
      specialty: text(specialty, 60) || "coding",
      adapterId: adapterId ? text(adapterId, 120) : null,
      capabilities: caps,
      state,
      accepting: accepting !== false,
      maxConcurrent: concurrency,
      heartbeatAt: at,
      registeredAt: existing?.registeredAt || at,
      deregisteredAt: null,
      revision: existing ? Number(existing.revision) + 1 : 1,
      metadata: metadata && typeof metadata === "object" ? metadata : null
    };
    try {
      await repository.saveWorker(worker);
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    await record(existing ? "worker.updated" : "worker.registered", { workerId, detail: { capabilities: caps, maxConcurrent: concurrency, revision: worker.revision } });
    return { ok: true, worker, created: !existing };
  }

  /**
   * Deregistration never deletes history. Without `force` a worker holding live leases is refused: closing
   * it would strand the task with an owner that can never release it. With `force` its leases are marked
   * abandoned, so the task becomes eligible for a fresh acquisition instead of waiting for expiry.
   */
  async function deregisterWorker({ id: rawId, reason = null, force = false } = {}) {
    const workerId = id(rawId);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const worker = await repository.getWorker(workerId);
    if (!worker) return { ok: false, code: "worker_unknown" };
    const active = await repository.listLeases({ workerId, state: "active", limit: 200 });
    if (active.length > 0 && force !== true) {
      return { ok: false, code: "worker_has_active_leases", activeLeases: active.map((lease) => lease.leaseId) };
    }
    const at = iso(now());
    const abandoned = [];
    if (force === true) {
      for (const lease of active) {
        const released = await repository.releaseLease({ leaseId: lease.leaseId, workerId, state: "abandoned", releasedAt: at, reason: text(reason, 200) || "worker_deregistered" });
        if (released.ok) {
          abandoned.push(lease.leaseId);
          await record("lease.abandoned", { missionId: lease.missionId, taskId: lease.taskId, workerId, leaseId: lease.leaseId, detail: { reason: "worker_deregistered" } });
        }
      }
    }
    const next = { ...worker, state: "deregistered", accepting: false, deregisteredAt: at, revision: Number(worker.revision) + 1 };
    await repository.saveWorker(next);
    await record("worker.deregistered", { workerId, detail: { reason: text(reason, 200) || null, abandoned: abandoned.length } });
    return { ok: true, worker: next, abandoned };
  }

  async function heartbeat({ id: rawId, state = null, detail = null } = {}) {
    const workerId = id(rawId);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const worker = await repository.getWorker(workerId);
    if (!worker) return { ok: false, code: "worker_unknown" };
    if (worker.state === "deregistered") return { ok: false, code: "worker_deregistered" };
    const nextState = state === null || state === undefined ? (worker.state === "online" || worker.state === "busy" ? worker.state : "online") : text(state, 20);
    if (!WORKER_STATES.includes(nextState) || nextState === "deregistered") return { ok: false, code: "worker_state_invalid" };
    const at = iso(now());
    const next = { ...worker, state: nextState, heartbeatAt: at, detail: detail ? text(detail, 200) : null, revision: Number(worker.revision) + 1 };
    await repository.saveWorker(next);
    return { ok: true, worker: next, health: deriveHealth(next) };
  }

  async function workers({ capability = null, state = null, healthyOnly = false } = {}) {
    const at = now();
    return (await repository.listWorkers()).map((worker) => ({ ...worker, health: deriveHealth(worker, at), activeLeases: 0 }))
      .filter((worker) => (capability ? worker.capabilities.includes(capability) : true))
      .filter((worker) => (state ? worker.state === state : true))
      .filter((worker) => (healthyOnly ? ["healthy", "busy", "degraded"].includes(worker.health.status) : true));
  }

  async function workerDetail(rawId) {
    const workerId = id(rawId);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const worker = await repository.getWorker(workerId);
    if (!worker) return { ok: false, code: "worker_unknown" };
    const [leases, executions] = await Promise.all([
      repository.listLeases({ workerId, limit: 50 }),
      repository.listExecutions({ limit: 50 })
    ]);
    const active = leases.filter((lease) => lease.state === "active");
    return {
      ok: true,
      worker: { ...worker, health: deriveHealth(worker), activeLeases: active.length },
      assignments: active,
      leases: leases.slice(0, 20),
      executions: executions.filter((execution) => execution.workerId === workerId).slice(0, 20)
    };
  }

  /* ── leases ─────────────────────────────────────────────────────────────────────────────────── */

  async function guardWorkerFor(worker, requires = []) {
    if (!worker) return { ok: false, code: "worker_unknown" };
    if (worker.state === "deregistered") return { ok: false, code: "worker_deregistered" };
    if (worker.accepting !== true) return { ok: false, code: "worker_not_accepting" };
    const health = deriveHealth(worker);
    if (health.status === "stalled" || health.status === "never_heartbeat") return { ok: false, code: "worker_stalled", health };
    if (worker.state === "unavailable") return { ok: false, code: "worker_unavailable", health };
    if (worker.state === "draining") return { ok: false, code: "worker_draining", health };
    const needed = list(requires);
    const missing = needed.filter((capability) => !worker.capabilities.includes(capability));
    if (missing.length > 0) return { ok: false, code: "capability_missing", missing };
    return { ok: true, health };
  }

  /** Expire the live lease for one task when its owner has already run out of time. */
  async function expireTaskLease(taskId) {
    const current = await repository.activeLeaseForTask(taskId);
    if (!current) return null;
    if (Date.parse(current.expiresAt) > now()) return current;
    const at = iso(now());
    const closed = await repository.releaseLease({ leaseId: current.leaseId, workerId: current.workerId, state: "expired", releasedAt: at, reason: "lease_expired" });
    if (closed.ok) {
      await record("lease.expired", { missionId: current.missionId, taskId, workerId: current.workerId, leaseId: current.leaseId, detail: { attempt: current.attempt, expiresAt: current.expiresAt } });
      return null;
    }
    return repository.activeLeaseForTask(taskId);
  }

  /**
   * Acquire the right to execute one task. Capacity, heartbeat and capability are checked first; the last
   * step is a single INSERT whose unique index is what actually prevents two owners. A caller that loses
   * receives `lease_held` and the current holder, and must not run.
   */
  async function acquire({
    taskId: rawTask,
    missionId: rawMission,
    workerId: rawWorker,
    requires = [],
    ttlMs = leaseTtlMs,
    attempt = 1,
    idempotencyKey = null,
    scopes = []
  } = {}) {
    const taskId = text(rawTask, 200);
    const missionId = text(rawMission, 120);
    const workerId = id(rawWorker);
    if (!taskId) return { ok: false, code: "task_id_invalid" };
    if (!missionId) return { ok: false, code: "mission_id_invalid" };
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const ttl = Math.max(5_000, Math.min(30 * 60_000, Number(ttlMs) || leaseTtlMs));

    let worker;
    try {
      worker = await repository.getWorker(workerId);
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    const allowed = await guardWorkerFor(worker, requires);
    if (!allowed.ok) return allowed;

    let activeCount = 0;
    try {
      const counts = await repository.workerCounts();
      activeCount = Number(counts.activeByWorker?.[workerId] || 0);
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    if (activeCount >= Number(worker.maxConcurrent || 1)) return { ok: false, code: "worker_at_capacity", activeLeases: activeCount, maxConcurrent: worker.maxConcurrent };

    // A crashed owner must not block the task until someone notices. Expire its lease first, then let the
    // normal uniqueness rule decide which of the remaining contenders wins.
    let holder = null;
    try {
      holder = await expireTaskLease(taskId);
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    if (holder) {
      if (holder.workerId === workerId) {
        const renewed = await renew({ leaseId: holder.leaseId, workerId, ttlMs: ttl, attempt });
        return renewed.ok
          ? { ok: true, lease: renewed.lease, leaseId: holder.leaseId, renewed: true }
          : { ok: false, code: renewed.code, holder };
      }
      return { ok: false, code: "lease_held", holder: { workerId: holder.workerId, leaseId: holder.leaseId, expiresAt: holder.expiresAt } };
    }

    const at = now();
    const lease = {
      leaseId: "lse_" + randomBytes(12).toString("hex"),
      taskId,
      missionId,
      workerId,
      state: "active",
      attempt: Math.max(1, Number(attempt) || 1),
      idempotencyKey: text(idempotencyKey, 200) || missionId + "|" + taskId,
      acquiredAt: iso(at),
      renewedAt: null,
      expiresAt: iso(at + ttl),
      releasedAt: null,
      reason: null,
      requires: list(requires),
      scopes: list(scopes)
    };
    let created;
    try {
      created = await repository.createLease(lease);
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    if (!created.ok) {
      if (created.code === "lease_held") {
        const current = created.holder;
        if (current?.workerId === workerId) {
          const renewed = await renew({ leaseId: current.leaseId, workerId, ttlMs: ttl, attempt });
          if (renewed.ok) return { ok: true, lease: renewed.lease, leaseId: current.leaseId, renewed: true };
        }
        return { ok: false, code: "lease_held", holder: current ? { workerId: current.workerId, leaseId: current.leaseId, expiresAt: current.expiresAt } : null };
      }
      return { ok: false, code: created.code };
    }
    await record("lease.acquired", { missionId, taskId, workerId, leaseId: lease.leaseId, detail: { attempt: lease.attempt, expiresAt: lease.expiresAt } });
    return { ok: true, lease, leaseId: lease.leaseId, renewed: false };
  }

  /**
   * Renew only a live lease owned by this worker. `expires_at > now` is part of the UPDATE, so a worker
   * that was partitioned and comes back late gets `lease_expired` instead of a silent extension.
   */
  async function renew({ leaseId: rawLease, workerId: rawWorker, ttlMs = leaseTtlMs, attempt = null } = {}) {
    const leaseId = text(rawLease, 80);
    const workerId = id(rawWorker);
    if (!leaseId) return { ok: false, code: "lease_id_invalid" };
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const current = await repository.getLease(leaseId);
    if (!current) return { ok: false, code: "unknown_lease" };
    if (current.workerId !== workerId) return { ok: false, code: "lease_not_owned" };
    if (current.state !== "active") return { ok: false, code: "lease_not_active", state: current.state };
    const at = now();
    if (Date.parse(current.expiresAt) <= at) {
      await repository.releaseLease({ leaseId, workerId, state: "expired", releasedAt: iso(at), reason: "lease_expired" });
      await record("lease.expired", { missionId: current.missionId, taskId: current.taskId, workerId, leaseId, detail: { attempt: current.attempt } });
      return { ok: false, code: "lease_expired" };
    }
    const ttl = Math.max(5_000, Math.min(30 * 60_000, Number(ttlMs) || leaseTtlMs));
    const expiresAt = iso(at + ttl);
    const updated = await repository.renewLease({ leaseId, workerId, expiresAt, renewedAt: iso(at) });
    if (!updated.ok) return { ok: false, code: updated.code === "lease_expired" ? "lease_expired" : "lease_renewal_refused" };
    const lease = { ...(updated.lease || current), expiresAt, renewedAt: iso(at), attempt: attempt === null ? current.attempt : Math.max(1, Number(attempt) || 1) };
    return { ok: true, lease, expiresAt };
  }

  async function release({ leaseId: rawLease, workerId: rawWorker, state = "released", reason = null } = {}) {
    const leaseId = text(rawLease, 80);
    const workerId = id(rawWorker);
    if (!leaseId) return { ok: false, code: "lease_id_invalid" };
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    if (!TERMINAL_LEASE_STATES.includes(state)) return { ok: false, code: "lease_state_invalid" };
    const released = await repository.releaseLease({ leaseId, workerId, state, releasedAt: iso(now()), reason: text(reason, 200) || null });
    if (!released.ok) return { ok: false, code: released.code };
    await record(state === "completed" ? "lease.completed" : "lease.released", {
      missionId: released.lease.missionId,
      taskId: released.lease.taskId,
      workerId,
      leaseId,
      detail: { state, reason: text(reason, 200) || null, attempt: released.lease.attempt }
    });
    return { ok: true, lease: released.lease };
  }

  async function lease(rawLease) {
    const leaseId = text(rawLease, 80);
    if (!leaseId) return null;
    return repository.getLease(leaseId);
  }

  /* ── failure detection and recovery ─────────────────────────────────────────────────────────── */

  async function expireAbandonedLeases({ limit = 100 } = {}) {
    const at = iso(now());
    let outcome;
    try {
      outcome = await repository.expireLeases({ at, limit });
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    const expired = outcome.expired || [];
    for (const entry of expired) {
      await record("lease.expired", {
        missionId: entry.missionId,
        taskId: entry.taskId,
        workerId: entry.workerId,
        leaseId: entry.leaseId,
        detail: { attempt: entry.attempt, expiresAt: entry.expiresAt, detectedBy: "sweep" }
      });
    }
    if (expired.length === 0 && Number(outcome.expiredCount || 0) > 0) {
      await record("lease.expired", { detail: { count: Number(outcome.expiredCount), detectedBy: "sweep", identities: "unavailable" } });
    }
    return { ok: true, expired: expired.length || Number(outcome.expiredCount || 0), leases: expired };
  }

  /**
   * A worker with an old heartbeat is not deleted and not replaced. It is reported as stalled and its
   * leases are left to expire: reviving it automatically would hide the failure that stopped the heartbeats.
   */
  async function detectStalledWorkers() {
    const at = now();
    const known = await repository.listWorkers();
    const stalled = [];
    for (const worker of known) {
      if (worker.state === "deregistered") continue;
      const health = deriveHealth(worker, at);
      const isStalled = health.status === "stalled" || health.status === "never_heartbeat";
      const wasStalled = worker.stalled === true;
      if (isStalled !== wasStalled) {
        const next = { ...worker, stalled: isStalled, revision: Number(worker.revision) + 1 };
        await repository.saveWorker(next);
        await record(isStalled ? "worker.stalled" : "worker.recovered", {
          workerId: worker.id,
          detail: { heartbeatAt: worker.heartbeatAt, heartbeatAgeMs: health.heartbeatAgeMs, state: worker.state }
        });
      }
      if (isStalled) stalled.push(worker.id);
    }
    return { ok: true, stalled, checked: known.length };
  }

  /**
   * An attempt that was in flight when its owner died has an unknown external outcome. It is marked
   * `uncertain` and never retried automatically; that is the whole point of the ledger.
   */
  async function recoverUncertainExecutions() {
    const at = now();
    const inflight = await repository.listExecutions({ state: "inflight", limit: 200 });
    const uncertain = [];
    for (const execution of inflight) {
      let owner = null;
      if (execution.leaseId) owner = await repository.getLease(execution.leaseId).catch(() => null);
      const live = owner && owner.state === "active" && Date.parse(owner.expiresAt) > at;
      if (live) continue;
      const settled = await repository.finishExecution({
        idempotencyKey: execution.idempotencyKey,
        state: "uncertain",
        result: { reason: "lease_lost_without_outcome", leaseId: execution.leaseId || null },
        at: iso(at)
      });
      if (settled.ok) {
        uncertain.push(execution.idempotencyKey);
        await record("outcome.uncertain", {
          missionId: execution.missionId,
          taskId: execution.taskId,
          workerId: execution.workerId,
          leaseId: execution.leaseId,
          detail: { idempotencyKey: execution.idempotencyKey, reason: "lease_lost_without_outcome" }
        });
      }
    }
    return { ok: true, uncertain };
  }

  async function recover() {
    const expired = await expireAbandonedLeases();
    const stalled = await detectStalledWorkers();
    const uncertain = await recoverUncertainExecutions();
    return {
      ok: true,
      expired: expired.ok ? expired.expired : 0,
      stalled: stalled.ok ? stalled.stalled.length : 0,
      uncertain: uncertain.ok ? uncertain.uncertain.length : 0,
      errors: [expired, stalled, uncertain].filter((item) => !item.ok).map((item) => item.code)
    };
  }

  /* ── at-most-once execution ───────────────────────────────────────────────────────────────── */

  function executionKey({ missionId, taskId, attempt, idempotencyKey }) {
    return idempotencyKey || [missionId, taskId, "a" + Math.max(1, Number(attempt) || 1)].join("|");
  }

  /**
   * Decide whether this attempt may call the outside world. Returns `ok:true` only for a fresh attempt on a
   * live lease. Anything else — a completed attempt, an in-flight duplicate, a lost outcome — is a refusal,
   * because every one of those means the operation may already have happened.
   */
  async function executionBegin({
    missionId: rawMission,
    taskId: rawTask,
    workerId: rawWorker,
    attempt = 1,
    leaseId = null,
    idempotencyKey = null
  } = {}) {
    const missionId = text(rawMission, 120);
    const taskId = text(rawTask, 200);
    const workerId = id(rawWorker);
    if (!missionId || !taskId) return { ok: false, code: "execution_target_invalid" };
    if (!workerId) return { ok: false, code: "worker_id_invalid" };

    if (leaseId) {
      const owner = await repository.getLease(leaseId).catch(() => null);
      if (!owner) return { ok: false, code: "lease_expired" };
      if (owner.workerId !== workerId) return { ok: false, code: "lease_not_owned" };
      if (owner.state !== "active") return { ok: false, code: "lease_expired" };
      if (Date.parse(owner.expiresAt) <= now()) return { ok: false, code: "lease_expired" };
    }

    const key = executionKey({ missionId, taskId, attempt, idempotencyKey });
    const prior = await repository.listExecutions({ missionId, taskId, limit: 50 });

    const succeeded = prior.find((execution) => execution.state === "succeeded");
    if (succeeded) return { ok: false, code: "execution_already_succeeded", execution: succeeded };
    const uncertain = prior.find((execution) => execution.state === "uncertain");
    if (uncertain) return { ok: false, code: "outcome_uncertain", execution: uncertain };

    const foreignInflight = prior.find((execution) => execution.state === "inflight" && execution.idempotencyKey !== key);
    if (foreignInflight) {
      const ownerLease = foreignInflight.leaseId ? await repository.getLease(foreignInflight.leaseId).catch(() => null) : null;
      const live = ownerLease && ownerLease.state === "active" && Date.parse(ownerLease.expiresAt) > now();
      if (!live) {
        const settled = await repository.finishExecution({
          idempotencyKey: foreignInflight.idempotencyKey,
          state: "uncertain",
          result: { reason: "lease_lost_without_outcome" },
          at: iso(now())
        });
        await record("outcome.uncertain", {
          missionId, taskId, workerId: foreignInflight.workerId, leaseId: foreignInflight.leaseId,
          detail: { idempotencyKey: foreignInflight.idempotencyKey, reason: "lease_lost_without_outcome" }
        });
        return { ok: false, code: "outcome_uncertain", execution: settled.execution || { ...foreignInflight, state: "uncertain" } };
      }
      return { ok: false, code: "execution_in_flight", execution: foreignInflight };
    }

    let begun;
    try {
      begun = await repository.beginExecution({ idempotencyKey: key, missionId, taskId, workerId, leaseId, attempt, at: iso(now()) });
    } catch (error) {
      // Fail closed: with no ledger there is no way to prove this call is not a duplicate.
      return { ok: false, code: "execution_registry_unavailable", error: text(error?.message, 160) };
    }
    if (!begun.ok) {
      const existing = begun.execution || (await repository.getExecution(key));
      if (!existing) return { ok: false, code: "execution_registry_unavailable" };
      if (existing.state === "succeeded") return { ok: false, code: "execution_already_succeeded", execution: existing };
      if (existing.state === "failed") return { ok: false, code: "execution_already_failed", execution: existing };
      if (existing.state === "uncertain") return { ok: false, code: "outcome_uncertain", execution: existing };
      return { ok: false, code: "execution_in_flight", execution: existing };
    }
    await record("execution.started", { missionId, taskId, workerId, leaseId, detail: { idempotencyKey: key, attempt } });
    return { ok: true, execution: begun.execution, idempotencyKey: key };
  }

  /**
   * Settle an attempt. A settled outcome is final: in particular an `uncertain` row cannot be rewritten as
   * a failure, because a failure would invite the retry that uncertainty forbids.
   */
  async function executionComplete({ idempotencyKey, state, result = null } = {}) {
    const key = text(idempotencyKey, 200);
    if (!key) return { ok: false, code: "execution_key_invalid" };
    if (!["succeeded", "failed", "uncertain"].includes(state)) return { ok: false, code: "execution_state_invalid" };
    const existing = await repository.getExecution(key);
    if (!existing) return { ok: false, code: "execution_missing" };
    if (existing.state === state) return { ok: true, execution: existing, idempotent: true };
    if (existing.state === "uncertain") return { ok: false, code: "execution_outcome_uncertain", execution: existing };
    if (existing.state !== "inflight") return { ok: false, code: "execution_already_settled", execution: existing };
    const settled = await repository.finishExecution({ idempotencyKey: key, state, result, at: iso(now()) });
    if (!settled.ok) return { ok: false, code: settled.code, execution: settled.execution };
    await record(state === "uncertain" ? "outcome.uncertain" : "execution.settled", {
      missionId: existing.missionId,
      taskId: existing.taskId,
      workerId: existing.workerId,
      leaseId: existing.leaseId,
      detail: { idempotencyKey: key, state }
    });
    return { ok: true, execution: settled.execution };
  }

  async function executionsFor({ missionId, taskId = null, limit = 50 } = {}) {
    return repository.listExecutions({ missionId, taskId, limit });
  }

  async function execution(rawKey) {
    const key = text(rawKey, 200);
    if (!key) return null;
    return repository.getExecution(key);
  }

  /* ── monitoring ────────────────────────────────────────────────────────────────────────────── */

  async function status({ missions = [] } = {}) {
    const at = now();
    const [known, workerTotals, leaseTotals, executionTotals, recoveryTotals, spans, activeLeases, expiring] = await Promise.all([
      repository.listWorkers(),
      repository.workerCounts(),
      repository.leaseCounts(),
      repository.executionCounts(),
      repository.recoveryCounts(),
      repository.missionSpans({ limit: 50 }),
      repository.listLeases({ state: "active", limit: 100 }),
      repository.expiringLeases({ at: iso(at), before: iso(at + 60_000), limit: 50 })
    ]);

    const health = known.map((worker) => ({ workerId: worker.id, state: worker.state, health: deriveHealth(worker, at), activeLeases: Number(workerTotals.activeByWorker?.[worker.id] || 0) }));
    const byHealth = {};
    for (const entry of health) byHealth[entry.health.status] = (byHealth[entry.health.status] || 0) + 1;

    const tracked = Array.isArray(missions) ? missions : [];
    const stalledMissions = tracked
      .filter((mission) => ["running", "planned", "blocked", "approval_required", "verification_failed"].includes(mission.status))
      .filter((mission) => age(mission.updatedAt || mission.createdAt, at) > missionStallAfterMs)
      .map((mission) => ({ missionId: mission.id, status: mission.status, updatedAt: mission.updatedAt || null, idleMs: age(mission.updatedAt || mission.createdAt, at) }));

    const statusOf = new Map(tracked.map((mission) => [mission.id, mission.status]));
    const durations = spans.map((span) => {
      const started = Date.parse(span.startedAt);
      const ended = Date.parse(span.endedAt);
      const finished = statusOf.get(span.missionId) === "completed";
      return {
        missionId: span.missionId,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        leases: span.leases,
        status: statusOf.get(span.missionId) || "unknown",
        // Only a completed mission has a final duration; anything else is elapsed time so far.
        durationMs: Number.isFinite(started) && (finished || Number.isFinite(ended)) ? Math.max(0, (finished ? ended : Math.min(ended, at)) - started) : null,
        final: finished
      };
    });

    const unresponsive = health.filter((entry) => ["stalled", "never_heartbeat", "unavailable"].includes(entry.health.status)).length;
    return {
      ok: true,
      migration: WORKFORCE_V1_MIGRATION,
      generatedAt: iso(at),
      workers: {
        total: workerTotals.total,
        byState: workerTotals.byState,
        byHealth,
        accepting: known.filter((worker) => worker.accepting === true && worker.state !== "deregistered").length,
        stalled: health.filter((entry) => entry.health.status === "stalled" || entry.health.status === "never_heartbeat").map((entry) => entry.workerId),
        health
      },
      activeAssignments: {
        count: activeLeases.length,
        items: activeLeases.map((lease) => ({
          leaseId: lease.leaseId, missionId: lease.missionId, taskId: lease.taskId,
          workerId: lease.workerId, attempt: lease.attempt, expiresAt: lease.expiresAt, acquiredAt: lease.acquiredAt
        }))
      },
      leases: {
        active: Number(leaseTotals.byState?.active || 0),
        byState: leaseTotals.byState,
        total: leaseTotals.total,
        retries: leaseTotals.retries,
        expiringSoon: expiring.map((lease) => ({ leaseId: lease.leaseId, taskId: lease.taskId, workerId: lease.workerId, expiresAt: lease.expiresAt })),
        expired: Number(leaseTotals.byState?.expired || 0)
      },
      executions: {
        total: executionTotals.total,
        inFlight: Number(executionTotals.byState?.inflight || 0),
        succeeded: Number(executionTotals.byState?.succeeded || 0),
        failed: Number(executionTotals.byState?.failed || 0),
        uncertain: Number(executionTotals.byState?.uncertain || 0),
        failedTasks: executionTotals.failedTasks
      },
      recovery: { total: recoveryTotals.total, byKind: recoveryTotals.byKind },
      missions: { tracked: tracked.length, stalled: stalledMissions.length, items: stalledMissions, durations },
      health: {
        ok: unresponsive === 0 && stalledMissions.length === 0,
        unresponsiveWorkers: unresponsive,
        stalledMissions: stalledMissions.length,
        detail: unresponsive === 0 && stalledMissions.length === 0
          ? "Every registered worker is heartbeating and no tracked mission is idle."
          : "Attention: " + unresponsive + " unresponsive worker(s), " + stalledMissions.length + " stalled mission(s)."
      }
    };
  }

  async function recoveryHistory({ missionId = null, kind = null, limit = 50 } = {}) {
    return repository.listRecovery({ missionId, kind, limit });
  }

  async function missionWorkers({ missionId: rawMission } = {}) {
    const missionId = text(rawMission, 120);
    if (!missionId) return { ok: false, code: "mission_id_invalid" };
    const leases = await repository.listLeases({ missionId, limit: 200 });
    const byTask = new Map();
    for (const lease of leases) {
      const current = byTask.get(lease.taskId);
      if (!current) {
        byTask.set(lease.taskId, { taskId: lease.taskId, workerIds: [lease.workerId], leases: 1, attempts: lease.attempt, state: lease.state, active: lease.state === "active", leaseId: lease.leaseId, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt });
      } else {
        if (!current.workerIds.includes(lease.workerId)) current.workerIds.push(lease.workerId);
        current.leases += 1;
        current.attempts = Math.max(current.attempts, lease.attempt);
        if (lease.state === "active") {
          current.state = "active";
          current.active = true;
          current.leaseId = lease.leaseId;
          current.acquiredAt = lease.acquiredAt;
          current.expiresAt = lease.expiresAt;
        }
      }
    }
    return {
      ok: true,
      missionId,
      workers: [...new Set(leases.map((lease) => lease.workerId))],
      tasks: [...byTask.values()],
      active: leases.filter((lease) => lease.state === "active").length,
      history: leases.slice(0, 50)
    };
  }

  return Object.freeze({
    migration: WORKFORCE_V1_MIGRATION,
    initialize,
    verifySchema,
    registerWorker,
    deregisterWorker,
    heartbeat,
    worker: rawId => workerDetail(rawId),
    workers,
    acquire,
    renew,
    release,
    lease,
    expireAbandonedLeases,
    detectStalledWorkers,
    recoverUncertainExecutions,
    recover,
    executionBegin,
    executionComplete,
    execution,
    executionsFor,
    status,
    recoveryHistory,
    missionWorkers,
    healthOf: worker => deriveHealth(worker),
    configuration: () => ({ leaseTtlMs, heartbeatIntervalMs, stalledAfterMs, missionStallAfterMs, defaultMaxConcurrent }),
    states: { workers: WORKER_STATES, leases: LEASE_STATES }
  });
}
