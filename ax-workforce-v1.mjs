import { randomBytes } from "node:crypto";
import { LEASE_STATES, WORKER_STATES, WORKFORCE_V1_MIGRATION, WORKFORCE_IDENTITY_MIGRATION, OPERATION_STATES } from "./d1-workforce-v1-repository.mjs";
import {
  WORKER_REQUEST_WINDOW_MS,
  WORKER_OPERATIONS,
  capabilitiesFingerprint,
  createWorkerSecret,
  parseWorkerCredential,
  verifyWorkerRequest,
  workforceOwnerStatement
} from "./ax-worker-auth.mjs";

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
  // A worker whose heartbeat is stale but whose lease was renewed inside this window is executing, not
  // dead. Reviving it automatically would be wrong too: a slow executor still must not take new work.
  activeExecutionWindowMs = WORKFORCE_V1_LIMITS.stalledAfterMs,
  credentialGraceMs = 24 * 60 * 60_000,
  requestWindowMs = WORKER_REQUEST_WINDOW_MS,
  // The HTTP gateway always requires an owner attestation and passes it through. A process that
  // constructs this engine directly is the owner's own code, so registration is allowed without one
  // unless the caller opts into strict mode.
  requireOwnerAuthorization = false,
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

  function deriveHealth(worker, at = now(), lastActivityAt = null) {
    if (worker.state === "deregistered") return { status: "deregistered", heartbeatAgeMs: null, stale: false };
    if (!worker.heartbeatAt) return { status: "never_heartbeat", heartbeatAgeMs: null, stale: true, detail: "The worker has registered but never sent a heartbeat." };
    const heartbeatAgeMs = age(worker.heartbeatAt, at);
    if (heartbeatAgeMs > stalledAfterMs) {
      // Lease renewal is independent evidence of life: an executor that has been running for longer than the
      // heartbeat interval keeps renewing, while a dead worker cannot. Reporting both as "stalled" would
      // make an operator kill healthy long work; reporting both as healthy would hide a crashed process.
      const activityAgeMs = lastActivityAt ? age(lastActivityAt, at) : null;
      if (activityAgeMs !== null && activityAgeMs <= activeExecutionWindowMs) {
        return {
          status: "active_execution",
          heartbeatAgeMs,
          activityAgeMs,
          stale: false,
          detail: "Heartbeat is stale but the lease was renewed " + Math.round(activityAgeMs / 1000) + "s ago; an executor is active."
        };
      }
      return { status: "stalled", heartbeatAgeMs, activityAgeMs, stale: true, detail: "No heartbeat for " + Math.round(heartbeatAgeMs / 1000) + "s; leases may expire." };
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

  /**
   * Owner authority for a workforce mutation. The in-process runtime bootstraps workers with `trusted`;
   * every external registration, revocation or reconciliation must present an owner attestation, and the
   * statement is re-derived here so a signature cannot be moved to a different worker or capability set.
   */
  function authorize(authorization, trusted, expectedStatement) {
    if (trusted === true) return { ok: true, by: "runtime", statement: null };
    if (!authorization) {
      return requireOwnerAuthorization
        ? { ok: false, code: "owner_authorization_required" }
        : { ok: true, by: "in_process", statement: null };
    }
    if (authorization.ok !== true) return { ok: false, code: "owner_authorization_required" };
    if (expectedStatement && authorization.statement && String(authorization.statement) !== expectedStatement) {
      return { ok: false, code: "owner_authorization_mismatch", expected: expectedStatement };
    }
    return { ok: true, by: text(authorization.by, 64) || "owner", statement: authorization.statement || null };
  }

  async function registerWorker({
    id: rawId,
    label = null,
    specialty = "coding",
    adapterId = null,
    capabilities = [],
    maxConcurrent = defaultMaxConcurrent,
    accepting = true,
    state = "online",
    metadata = null,
    authorization = null,
    trusted = false
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
    const authority = authorize(
      authorization,
      trusted,
      workforceOwnerStatement({ operation: "worker.register", workerId, detail: capabilitiesFingerprint(caps) + ":" + concurrency })
    );
    if (!authority.ok) return authority;

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
    await record(existing ? "worker.updated" : "worker.registered", {
      workerId,
      detail: { capabilities: caps, maxConcurrent: concurrency, revision: worker.revision, authorizedBy: authority.by }
    });
    return { ok: true, worker, created: !existing, authorizedBy: authority.by };
  }

  /**
   * Deregistration never deletes history. Without `force` a worker holding live leases is refused: closing
   * it would strand the task with an owner that can never release it. With `force` its leases are marked
   * abandoned, so the task becomes eligible for a fresh acquisition instead of waiting for expiry.
   */
  async function deregisterWorker({ id: rawId, reason = null, force = false, authorization = null, trusted = false } = {}) {
    const workerId = id(rawId);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const authority = authorize(authorization, trusted, workforceOwnerStatement({ operation: "worker.revoke", workerId }));
    if (!authority.ok) return authority;
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
    // Deregistration is a revocation: every credential for this identity stops working immediately. Leaving
    // them active would let a retired worker keep acting as itself.
    const revoked = await revokeWorkerCredentials({ workerId, reason: text(reason, 200) || "worker_deregistered", trusted: true });
    for (const lease of active) await noteRecoveryDecision(lease, "worker_deregistered", at);
    await record("worker.deregistered", {
      workerId,
      detail: { reason: text(reason, 200) || null, abandoned: abandoned.length, credentialsRevoked: revoked.revoked || 0, authorizedBy: authority.by }
    });
    return { ok: true, worker: next, abandoned, credentialsRevoked: revoked.revoked || 0 };
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
    const counts = await repository.workerCounts();
    return (await repository.listWorkers()).map((worker) => ({
      ...worker,
      health: deriveHealth(worker, at, counts.lastActivityByWorker?.[worker.id] || null),
      activeLeases: Number(counts.activeByWorker?.[worker.id] || 0)
    }))
      .filter((worker) => (capability ? worker.capabilities.includes(capability) : true))
      .filter((worker) => (state ? worker.state === state : true))
      .filter((worker) => (healthyOnly ? ["healthy", "busy", "degraded", "active_execution"].includes(worker.health.status) : true));
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
    const counts = await repository.workerCounts();
    const credentials = typeof repository.listCredentials === "function"
      ? await repository.listCredentials({ workerId, limit: 50 })
      : [];
    return {
      ok: true,
      worker: {
        ...worker,
        health: deriveHealth(worker, now(), counts.lastActivityByWorker?.[workerId] || null),
        activeLeases: active.length
      },
      credentials,
      assignments: active,
      leases: leases.slice(0, 20),
      executions: executions.filter((execution) => execution.workerId === workerId).slice(0, 20)
    };
  }

  /* ── leases ─────────────────────────────────────────────────────────────────────────────────── */

  async function guardWorkerFor(worker, requires = [], lastActivityAt = null) {
    if (!worker) return { ok: false, code: "worker_unknown" };
    if (worker.state === "deregistered") return { ok: false, code: "worker_deregistered" };
    if (worker.accepting !== true) return { ok: false, code: "worker_not_accepting" };
    const health = deriveHealth(worker, now(), lastActivityAt);
    if (health.status === "active_execution") return { ok: false, code: "worker_executing", health };
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
    let activeCount = 0;
    let lastActivityAt = null;
    try {
      const counts = await repository.workerCounts();
      activeCount = Number(counts.activeByWorker?.[workerId] || 0);
      lastActivityAt = counts.lastActivityByWorker?.[workerId] || null;
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    const allowed = await guardWorkerFor(worker, requires, lastActivityAt);
    if (!allowed.ok) return allowed;
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

  /* ── worker credentials ─────────────────────────────────────────────────────────────────────── */

  function publicCredential(credential) {
    return {
      credentialId: credential.credentialId,
      workerId: credential.workerId,
      label: credential.label,
      scopes: credential.scopes,
      status: credential.status,
      createdAt: credential.createdAt,
      expiresAt: credential.expiresAt || null,
      graceUntil: credential.graceUntil || null,
      revokedAt: credential.revokedAt || null,
      revokeReason: credential.revokeReason || null,
      rotatedTo: credential.rotatedTo || null,
      lastUsedAt: credential.lastUsedAt || null
    };
  }

  async function identityStatus() {
    if (typeof repository.verifyIdentitySchema !== "function") {
      return { ok: false, missing: [], expected: 0, migration: WORKFORCE_IDENTITY_MIGRATION };
    }
    try {
      return await repository.verifyIdentitySchema();
    } catch (error) {
      return { ok: false, missing: [], expected: 0, migration: WORKFORCE_IDENTITY_MIGRATION, error: text(error?.message, 160) };
    }
  }

  /**
   * Issue a credential. The secret is returned exactly once; the store keeps the verification key and no API
   * ever reads it back. Registration and credential issuance are separate acts so a worker can be rotated
   * without touching its durable identity.
   */
  async function issueCredential({ workerId: rawWorker, label = null, scopes = ["worker"], ttlMs = null, authorization = null, trusted = false } = {}) {
    const workerId = id(rawWorker);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const readiness = await identityStatus();
    if (!readiness.ok) return { ok: false, code: "workforce_identity_schema_missing", missing: readiness.missing };
    const authority = authorize(authorization, trusted, workforceOwnerStatement({ operation: "credential.issue", workerId }));
    if (!authority.ok) return authority;
    const worker = await repository.getWorker(workerId);
    if (!worker) return { ok: false, code: "worker_unknown" };
    if (worker.state === "deregistered") return { ok: false, code: "worker_deregistered" };
    const wanted = [...new Set((Array.isArray(scopes) ? scopes : []).map((scope) => text(scope, 32)).filter(Boolean))];
    if (wanted.length === 0) return { ok: false, code: "credential_scopes_required" };

    const created = createWorkerSecret();
    const at = now();
    const credential = {
      credentialId: created.credentialId,
      workerId,
      label: text(label || worker.label + " credential", 120),
      secretKey: created.secret,
      scopes: wanted,
      status: "active",
      createdAt: iso(at),
      expiresAt: ttlMs ? iso(at + Math.max(60_000, Number(ttlMs))) : null,
      graceUntil: null,
      revokedAt: null,
      revokeReason: null,
      rotatedTo: null,
      lastUsedAt: null
    };
    await repository.saveCredential({ ...credential, record: { credentialId: credential.credentialId, workerId, label: credential.label, scopes: wanted, createdAt: credential.createdAt } });
    await record("worker.credential_issued", { workerId, detail: { credentialId: credential.credentialId, label: credential.label, authorizedBy: authority.by } });
    return { ok: true, credential: publicCredential(credential), secret: created.presented, authorizedBy: authority.by };
  }

  /** Rotation keeps the worker id; only the key changes, and the old key keeps working during a grace window. */
  async function rotateCredential({ credentialId: rawCredential, label = null, graceMs = credentialGraceMs, ttlMs = null, authorization = null, trusted = false } = {}) {
    const credentialId = text(rawCredential, 80);
    if (!credentialId) return { ok: false, code: "credential_id_invalid" };
    const readiness = await identityStatus();
    if (!readiness.ok) return { ok: false, code: "workforce_identity_schema_missing", missing: readiness.missing };
    const current = await repository.getCredential(credentialId);
    if (!current) return { ok: false, code: "worker_credential_unknown" };
    if (current.status === "revoked") return { ok: false, code: "worker_credential_revoked" };
    const authority = authorize(
      authorization,
      trusted,
      workforceOwnerStatement({ operation: "credential.rotate", workerId: current.workerId, credentialId })
    );
    if (!authority.ok) return authority;

    const created = createWorkerSecret();
    const at = now();
    const grace = Math.max(0, Math.min(7 * 24 * 60 * 60_000, Number(graceMs) || 0));
    const replacement = {
      credentialId: created.credentialId,
      workerId: current.workerId,
      label: text(label || current.label, 120),
      secretKey: created.secret,
      scopes: current.scopes,
      status: "active",
      createdAt: iso(at),
      expiresAt: ttlMs ? iso(at + Math.max(60_000, Number(ttlMs))) : current.expiresAt,
      graceUntil: null,
      revokedAt: null,
      revokeReason: null,
      rotatedTo: null,
      lastUsedAt: null
    };
    const rotated = { ...current, status: "rotated", rotatedTo: replacement.credentialId, graceUntil: iso(at + grace) };
    await repository.saveCredential({ ...rotated, record: { credentialId: rotated.credentialId, workerId: rotated.workerId, scopes: rotated.scopes, createdAt: rotated.createdAt } });
    await repository.saveCredential({ ...replacement, record: { credentialId: replacement.credentialId, workerId: replacement.workerId, scopes: replacement.scopes, createdAt: replacement.createdAt } });
    await record("worker.credential_rotated", {
      workerId: current.workerId,
      detail: { from: credentialId, to: replacement.credentialId, graceUntil: rotated.graceUntil, authorizedBy: authority.by }
    });
    return { ok: true, credential: publicCredential(replacement), previous: publicCredential(rotated), secret: created.presented, authorizedBy: authority.by };
  }

  async function revokeCredential({ credentialId: rawCredential, reason = null, authorization = null, trusted = false } = {}) {
    const credentialId = text(rawCredential, 80);
    if (!credentialId) return { ok: false, code: "credential_id_invalid" };
    const readiness = await identityStatus();
    if (!readiness.ok) return { ok: false, code: "workforce_identity_schema_missing", missing: readiness.missing };
    const current = await repository.getCredential(credentialId);
    if (!current) return { ok: false, code: "worker_credential_unknown" };
    const authority = authorize(authorization, trusted, workforceOwnerStatement({ operation: "credential.revoke", credentialId }));
    if (!authority.ok) return authority;
    if (current.status === "revoked") return { ok: true, credential: publicCredential(current), idempotent: true };
    const next = { ...current, status: "revoked", revokedAt: iso(now()), revokeReason: text(reason, 200) || "revoked", graceUntil: iso(now()) };
    await repository.saveCredential({ ...next, record: { credentialId: next.credentialId, workerId: next.workerId, scopes: next.scopes, createdAt: next.createdAt } });
    await record("worker.credential_revoked", { workerId: current.workerId, detail: { credentialId, reason: next.revokeReason, authorizedBy: authority.by } });
    return { ok: true, credential: publicCredential(next), authorizedBy: authority.by };
  }

  /** Any revocation that is not tied to one credential (deregistration) revokes every key the worker holds. */
  async function revokeWorkerCredentials({ workerId: rawWorker, reason = null, authorization = null, trusted = false } = {}) {
    const workerId = id(rawWorker);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const readiness = await identityStatus();
    if (!readiness.ok) return { ok: false, code: "workforce_identity_schema_missing", missing: readiness.missing, revoked: 0 };
    const authority = authorize(authorization, trusted, workforceOwnerStatement({ operation: "worker.revoke", workerId }));
    if (!authority.ok) return authority;
    const existing = await repository.listCredentials({ workerId, limit: 100 });
    let revoked = 0;
    for (const credential of existing) {
      if (credential.status === "revoked") continue;
      const loaded = await repository.getCredential(credential.credentialId);
      const next = { ...loaded, status: "revoked", revokedAt: iso(now()), revokeReason: text(reason, 200) || "worker_revoked" };
      await repository.saveCredential({ ...next, record: { credentialId: next.credentialId, workerId, scopes: next.scopes, createdAt: next.createdAt } });
      revoked += 1;
    }
    if (revoked > 0) await record("worker.credentials_revoked", { workerId, detail: { revoked, reason: text(reason, 200) || null, authorizedBy: authority.by } });
    return { ok: true, revoked, workerId };
  }

  async function workerCredentials({ workerId: rawWorker } = {}) {
    const workerId = id(rawWorker);
    if (!workerId) return { ok: false, code: "worker_id_invalid" };
    const readiness = await identityStatus();
    if (!readiness.ok) return { ok: false, code: "workforce_identity_schema_missing", credentials: [] };
    return { ok: true, credentials: await repository.listCredentials({ workerId, limit: 100 }) };
  }

  /**
   * Verify one signed request. Order matters: the MAC is checked before the nonce is spent, so a forged
   * request cannot burn a nonce, and the credential's status is checked before anything is written.
   */
  async function authenticateWorkerRequest({ presented = null, operation = null, nonce = null, timestamp = null, signature = null, body = {} } = {}) {
    const readiness = await identityStatus();
    if (!readiness.ok) return { ok: false, code: "workforce_identity_schema_missing", missing: readiness.missing };
    const operationName = text(operation, 40);
    if (!WORKER_OPERATIONS.includes(operationName)) return { ok: false, code: "worker_operation_invalid" };
    const parsed = parseWorkerCredential(presented);
    if (!parsed) return { ok: false, code: "worker_credential_invalid" };
    const credential = await repository.getCredential(parsed.credentialId);
    if (!credential) return { ok: false, code: "worker_credential_unknown" };
    if (credential.status === "revoked") return { ok: false, code: "worker_credential_revoked" };
    const at = now();
    if (credential.status === "rotated") {
      const grace = Date.parse(credential.graceUntil || "");
      if (!Number.isFinite(grace) || grace <= at) return { ok: false, code: "worker_credential_rotated" };
    }
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= at) return { ok: false, code: "worker_credential_expired" };
    const worker = await repository.getWorker(credential.workerId);
    if (!worker) return { ok: false, code: "worker_unknown" };
    if (worker.state === "deregistered") return { ok: false, code: "worker_deregistered" };

    const atMs = Number(timestamp);
    if (!Number.isFinite(atMs) || Math.abs(at - atMs) > requestWindowMs) return { ok: false, code: "worker_request_timestamp_invalid" };
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(nonce || ""))) return { ok: false, code: "worker_request_nonce_invalid" };
    const verified = verifyWorkerRequest({
      secret: credential.secretKey,
      signature,
      operation: operationName,
      workerId: credential.workerId,
      credentialId: credential.credentialId,
      nonce: String(nonce),
      timestamp: atMs,
      body
    });
    if (!verified.ok) return { ok: false, code: "worker_signature_invalid" };

    let used;
    try {
      used = await repository.useWorkerNonce({
        credentialId: credential.credentialId,
        nonce: String(nonce),
        operation: operationName,
        at: iso(at),
        expiresAt: iso(at + requestWindowMs)
      });
    } catch (error) {
      return { ok: false, code: "worker_replay_store_unavailable", error: text(error?.message, 160) };
    }
    if (!used.ok) return { ok: false, code: used.code || "worker_request_replayed" };

    try {
      await repository.saveCredential({ ...credential, lastUsedAt: iso(at), record: { credentialId: credential.credentialId, workerId: credential.workerId, scopes: credential.scopes, createdAt: credential.createdAt } });
    } catch { /* the request is authorised; a last-used timestamp is not worth failing it */ }
    return { ok: true, workerId: credential.workerId, credentialId: credential.credentialId, worker, credential: publicCredential(credential), operation: operationName };
  }

  /* ── provider operations and reconciliation ───────────────────────────────────────────────── */

  async function recordOperation({ idempotencyKey, missionId, taskId, workerId = null, provider = null, providerReference = null, state = "unknown", proof = null } = {}) {
    if (typeof repository.saveOperation !== "function") return { ok: false, code: "workforce_identity_schema_missing" };
    const key = text(idempotencyKey, 200);
    if (!key) return { ok: false, code: "execution_key_invalid" };
    const at = iso(now());
    return repository.saveOperation({
      idempotencyKey: key,
      missionId: text(missionId, 120),
      taskId: text(taskId, 200),
      workerId: workerId ? id(workerId) : null,
      provider: provider ? text(provider, 60) : null,
      providerReference: providerReference ? text(providerReference, 200) : null,
      state: OPERATION_STATES.includes(state) ? state : "unknown",
      proof,
      at,
      createdAt: at
    });
  }

  async function operation(rawKey) {
    if (typeof repository.getOperation !== "function") return null;
    const key = text(rawKey, 200);
    if (!key) return null;
    return repository.getOperation(key);
  }

  /** Every attempt whose external outcome is unknown, with the provider reference an operator needs. */
  async function uncertainOperations({ limit = 50, missionId = null } = {}) {
    if (typeof repository.listExecutions !== "function") return [];
    const executions = await repository.listExecutions({ state: "uncertain", missionId, limit });
    const items = [];
    for (const execution of executions) {
      const record = typeof repository.getOperation === "function" ? await repository.getOperation(execution.idempotencyKey).catch(() => null) : null;
      items.push({
        idempotencyKey: execution.idempotencyKey,
        missionId: execution.missionId,
        taskId: execution.taskId,
        workerId: execution.workerId,
        attempt: execution.attempt,
        startedAt: execution.startedAt,
        updatedAt: execution.updatedAt,
        provider: record?.provider || null,
        providerReference: record?.providerReference || null,
        operationState: record?.state || "unknown",
        proof: record?.proof || null,
        retryable: record?.state === "not_executed" && Boolean(record?.proof)
      });
    }
    return items;
  }

  /** Read-only inspection. It never changes a row and never calls a provider. */
  async function inspectUncertain({ idempotencyKey } = {}) {
    const key = text(idempotencyKey, 200);
    if (!key) return { ok: false, code: "execution_key_invalid" };
    const execution = await repository.getExecution(key);
    if (!execution) return { ok: false, code: "execution_missing" };
    const operationRow = typeof repository.getOperation === "function" ? await repository.getOperation(key) : null;
    const lease = execution.leaseId ? await repository.getLease(execution.leaseId).catch(() => null) : null;
    return {
      ok: true,
      readOnly: true,
      execution: { ...execution, result: execution.result || null },
      operation: operationRow,
      lease: lease ? { leaseId: lease.leaseId, state: lease.state, workerId: lease.workerId, expiresAt: lease.expiresAt, releasedAt: lease.releasedAt } : null,
      retryable: operationRow?.state === "not_executed" && Boolean(operationRow?.proof),
      detail: execution.state === "uncertain"
        ? (operationRow?.state === "unknown"
            ? "The external outcome is unknown. Inspect the provider by reference before deciding; do not retry."
            : "Provider verdict recorded: " + operationRow.state + ". " + (operationRow.state === "not_executed" ? "A retry is allowed because the provider proved the operation did not occur." : "The operation may have occurred; no automatic retry is allowed."))
        : "This attempt is not uncertain."
    };
  }

  /**
   * Owner reconciliation of one uncertain attempt. Only `not_executed` with proof converts the attempt into
   * a retryable failure; `confirmed_success` settles it as done; `confirmed_failure` and `unknown` keep the
   * at-most-once boundary intact.
   */
  async function reconcileUncertain({ idempotencyKey, verdict = "unknown", proof = null, providerReference = null, provider = null, by = "owner", authorization = null, trusted = false } = {}) {
    const key = text(idempotencyKey, 200);
    if (!key) return { ok: false, code: "execution_key_invalid" };
    if (!["unknown", "confirmed_success", "confirmed_failure", "not_executed"].includes(verdict)) return { ok: false, code: "reconciliation_verdict_invalid" };
    const readiness = await identityStatus();
    if (!readiness.ok) return { ok: false, code: "workforce_identity_schema_missing", missing: readiness.missing };
    const authority = authorize(authorization, trusted, workforceOwnerStatement({ operation: "reconcile", credentialId: key, detail: verdict }));
    if (!authority.ok) return authority;
    const execution = await repository.getExecution(key);
    if (!execution) return { ok: false, code: "execution_missing" };
    if (execution.state !== "uncertain") return { ok: false, code: "execution_not_uncertain", state: execution.state };
    if (verdict !== "unknown") {
      if (!proof || typeof proof !== "object" || !proof.evidence) return { ok: false, code: "reconciliation_proof_required" };
    }
    const at = iso(now());
    const inspectedBy = text(by, 64) || "owner";
    const existing = await repository.getOperation(key);
    const saved = await repository.saveOperation({
      idempotencyKey: key,
      missionId: execution.missionId,
      taskId: execution.taskId,
      workerId: execution.workerId,
      provider: provider ? text(provider, 60) : existing?.provider || null,
      providerReference: providerReference ? text(providerReference, 200) : existing?.providerReference || null,
      state: verdict,
      proof,
      inspectedAt: at,
      inspectedBy,
      at,
      createdAt: existing?.createdAt || execution.startedAt
    });

    let settled = null;
    if (verdict === "confirmed_success") {
      settled = await repository.settleUncertainExecution({
        idempotencyKey: key,
        state: "succeeded",
        result: { reconciled: true, verdict, proof, at, by: inspectedBy },
        at
      });
    } else if (verdict === "not_executed") {
      settled = await repository.settleUncertainExecution({
        idempotencyKey: key,
        state: "failed",
        result: { reconciled: true, verdict, proof, retryable: true, at, by: inspectedBy },
        at
      });
    }
    const decision = verdict === "confirmed_success" ? "completed" : verdict === "not_executed" ? "requeue" : "hold_uncertain";
    if (typeof repository.recordReassignment === "function") {
      try {
        await repository.recordReassignment({
          at,
          missionId: execution.missionId,
          taskId: execution.taskId,
          fromWorker: execution.workerId,
          toWorker: null,
          leaseId: execution.leaseId,
          reason: "reconciliation:" + verdict,
          decision,
          detail: { idempotencyKey: key, by: inspectedBy, providerReference: providerReference || existing?.providerReference || null }
        });
      } catch { /* the operation verdict above is authoritative */ }
    }
    await record("recovery.decision", {
      missionId: execution.missionId,
      taskId: execution.taskId,
      workerId: execution.workerId,
      leaseId: execution.leaseId,
      detail: { kind: "reconciliation", verdict, decision, by: inspectedBy, idempotencyKey: key }
    });
    return {
      ok: true,
      verdict,
      decision,
      retryable: verdict === "not_executed",
      operation: saved.operation,
      execution: settled?.execution || execution,
      authorizedBy: authority.by
    };
  }

  /* ── failure detection and recovery ─────────────────────────────────────────────────────────── */

  /**
   * Record what happens to a task whose lease ended without a clean release. An attempt that started is held
   * as uncertain — it must never be reassigned — while a lease that expired before any attempt is requeued.
   */
  async function noteRecoveryDecision(lease, reason, at = iso(now())) {
    if (!lease) return null;
    let executions = [];
    try {
      executions = typeof repository.listExecutions === "function"
        ? await repository.listExecutions({ leaseId: lease.leaseId, limit: 10 })
        : [];
    } catch { executions = []; }
    for (const execution of executions.filter((item) => item.state === "inflight")) {
      try {
        await repository.finishExecution({
          idempotencyKey: execution.idempotencyKey,
          state: "uncertain",
          result: { reason: "lease_expired_during_execution" },
          at
        });
        await record("outcome.uncertain", {
          missionId: lease.missionId,
          taskId: lease.taskId,
          workerId: lease.workerId,
          leaseId: lease.leaseId,
          detail: { idempotencyKey: execution.idempotencyKey, reason: "lease_expired_during_execution" }
        });
      } catch { /* the expiry below still prevents a silent retry */ }
    }
    const uncertain = executions.some((item) => item.state === "uncertain") || executions.some((item) => item.state === "inflight");
    const decision = uncertain ? "hold_uncertain" : "requeue";
    const entry = {
      at,
      missionId: lease.missionId,
      taskId: lease.taskId,
      fromWorker: lease.workerId || null,
      toWorker: null,
      leaseId: lease.leaseId,
      reason: String(reason || "lease_expired"),
      decision,
      detail: { attempt: lease.attempt, executionStates: executions.map((item) => item.state) }
    };
    try {
      if (typeof repository.recordReassignment === "function") await repository.recordReassignment(entry);
    } catch (error) {
      log.warn?.("WORKFORCE_REASSIGNMENT_LEDGER_FAILED", String(error?.message || error).slice(0, 160));
    }
    await record("recovery.decision", {
      missionId: lease.missionId,
      taskId: lease.taskId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      detail: { kind: "lease_recovery", reason: entry.reason, decision }
    });
    return entry;
  }

  async function expireAbandonedLeases({ limit = 100 } = {}) {
    const at = iso(now());
    let outcome;
    try {
      outcome = await repository.expireLeases({ at, limit });
    } catch (error) {
      return { ok: false, code: "workforce_storage_unavailable", error: text(error?.message, 160) };
    }
    const expired = outcome.expired || [];
    let held = 0;
    for (const entry of expired) {
      await record("lease.expired", {
        missionId: entry.missionId,
        taskId: entry.taskId,
        workerId: entry.workerId,
        leaseId: entry.leaseId,
        detail: { attempt: entry.attempt, expiresAt: entry.expiresAt, detectedBy: "sweep" }
      });
      // The decision is recorded with the expiry: requeue only if no attempt had started, otherwise hold it
      // uncertain. This is the point where a naive sweep would create a duplicate external effect.
      const decision = await noteRecoveryDecision(entry, "lease_expired", at);
      if (decision?.decision === "hold_uncertain") held += 1;
    }
    if (expired.length === 0 && Number(outcome.expiredCount || 0) > 0) {
      await record("lease.expired", { detail: { count: Number(outcome.expiredCount), detectedBy: "sweep", identities: "unavailable" } });
    }
    return { ok: true, expired: expired.length || Number(outcome.expiredCount || 0), uncertain: held, leases: expired };
  }

  /**
   * A worker with an old heartbeat is not deleted and not replaced. It is reported as stalled and its
   * leases are left to expire: reviving it automatically would hide the failure that stopped the heartbeats.
   */
  async function detectStalledWorkers() {
    const at = now();
    const known = await repository.listWorkers();
    const counts = await repository.workerCounts();
    const stalled = [];
    for (const worker of known) {
      if (worker.state === "deregistered") continue;
      // An executor that is still renewing its lease is working, not dead: lease activity is what separates
      // a slow operation from a crashed process.
      const health = deriveHealth(worker, at, counts.lastActivityByWorker?.[worker.id] || null);
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
      // Attempts the sweep had to hold unknown count as recovered uncertainty, not as nothing.
      uncertain: (expired.ok ? Number(expired.uncertain || 0) : 0) + (uncertain.ok ? uncertain.uncertain.length : 0),
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

  /* ── recovery queue and reassignment history ───────────────────────────────────────────────── */

  /**
   * Everything that needs a human decision, in one place: leases that ended without a release, the uncertain
   * attempts they left behind, and what the engine decided to do about each. Read-only.
   */
  async function recoveryQueue({ limit = 100 } = {}) {
    const capped = Math.max(1, Math.min(200, Number(limit) || 100));
    const [expired, abandoned] = await Promise.all([
      repository.listLeases({ state: "expired", limit: capped }),
      repository.listLeases({ state: "abandoned", limit: capped })
    ]);
    const uncertain = await uncertainOperations({ limit: capped });
    const items = [];
    for (const lease of [...expired, ...abandoned]) {
      let executions = [];
      try {
        executions = typeof repository.listExecutions === "function" ? await repository.listExecutions({ leaseId: lease.leaseId, limit: 10 }) : [];
      } catch { executions = []; }
      const held = executions.some((execution) => ["inflight", "uncertain"].includes(execution.state));
      items.push({
        leaseId: lease.leaseId,
        missionId: lease.missionId,
        taskId: lease.taskId,
        workerId: lease.workerId,
        attempt: lease.attempt,
        leaseState: lease.state,
        expiresAt: lease.expiresAt,
        releasedAt: lease.releasedAt || null,
        decision: held ? "hold_uncertain" : "requeue",
        reason: lease.state === "expired" ? "lease_expired" : "lease_abandoned",
        executionStates: executions.map((execution) => execution.state)
      });
    }
    return { ok: true, count: items.length, items, uncertain };
  }

  async function reassignments({ missionId = null, limit = 100 } = {}) {
    if (typeof repository.listReassignments !== "function") return { ok: true, items: [], count: 0 };
    const items = await repository.listReassignments({ missionId, limit });
    return { ok: true, count: items.length, items };
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

    const health = known.map((worker) => ({
      workerId: worker.id,
      state: worker.state,
      health: deriveHealth(worker, at, workerTotals.lastActivityByWorker?.[worker.id] || null),
      lastHeartbeatAt: worker.heartbeatAt || null,
      lastLeaseActivityAt: workerTotals.lastActivityByWorker?.[worker.id] || null,
      activeLeases: Number(workerTotals.activeByWorker?.[worker.id] || 0)
    }));
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

    const identity = await identityStatus();
    let activeCredentials = [];
    let reassignmentRows = [];
    if (identity.ok) {
      activeCredentials = await repository.listCredentials({ status: "active", limit: 500 }).catch(() => []);
      reassignmentRows = await reassignments({ limit: 50 }).then((result) => result.items).catch(() => []);
    }
    const uncertainCount = Number(executionTotals.byState?.uncertain || 0);
    return {
      ok: true,
      migration: WORKFORCE_V1_MIGRATION,
      identityMigration: WORKFORCE_IDENTITY_MIGRATION,
      generatedAt: iso(at),
      identity: {
        ready: identity.ok === true,
        missing: identity.missing || [],
        credentials: activeCredentials.length,
        workersWithCredentials: new Set(activeCredentials.map((credential) => credential.workerId)).size,
        unresolved: known.filter((worker) => worker.state !== "deregistered" && !activeCredentials.some((credential) => credential.workerId === worker.id)).map((worker) => worker.id)
      },
      workers: {
        total: workerTotals.total,
        byState: workerTotals.byState,
        byHealth,
        accepting: known.filter((worker) => worker.accepting === true && worker.state !== "deregistered").length,
        stalled: health.filter((entry) => entry.health.status === "stalled" || entry.health.status === "never_heartbeat").map((entry) => entry.workerId),
        executing: health.filter((entry) => entry.health.status === "active_execution").map((entry) => entry.workerId),
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
      uncertainOperations: {
        count: uncertainCount,
        // The queue is only built when the identity migration is present; the count still comes from 0018.
        items: identity.ok ? (await uncertainOperations({ limit: 25 })) : [],
        detail: uncertainCount === 0
          ? "No attempt has an unknown external outcome."
          : "Inspect the provider by reference before deciding anything: an unknown outcome must never be retried."
      },
      reassignments: {
        recorded: reassignmentRows.length,
        decisions: reassignmentRows.reduce((acc, row) => { acc[row.decision] = (acc[row.decision] || 0) + 1; return acc; }, {}),
        recent: reassignmentRows.slice(0, 10)
      },
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
    issueCredential,
    rotateCredential,
    revokeCredential,
    revokeWorkerCredentials,
    workerCredentials,
    authenticateWorkerRequest,
    identityStatus,
    recordOperation,
    operation,
    uncertainOperations,
    inspectUncertain,
    reconcileUncertain,
    recoveryQueue,
    reassignments,
    noteRecoveryDecision,
    status,
    recoveryHistory,
    missionWorkers,
    healthOf: worker => deriveHealth(worker),
    configuration: () => ({ leaseTtlMs, heartbeatIntervalMs, stalledAfterMs, activeExecutionWindowMs, missionStallAfterMs, credentialGraceMs, requestWindowMs, defaultMaxConcurrent, requireOwnerAuthorization }),
    states: { workers: WORKER_STATES, leases: LEASE_STATES, operations: OPERATION_STATES }
  });
}
