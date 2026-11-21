import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createD1CommandTaskRepository, d1DatabaseEndpoint } from "./d1-command-task-repository.mjs";
import { createUniversalCommandEngine, TASK_STATES } from "./universal-command-engine.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { READ_ONLY_ADAPTER_NAMES } from "./nexus-adapter-registration.mjs";

/**
 * NEXUS RUNTIME — the executor behind habitat_command_tasks.
 *
 * Corrections from review:
 *  - Approvals are OWNER-ONLY. A paired device that is not the configured owner gets 403; if no
 *    owner is configured the routes fail closed with 503. Ax bridge credentials are a separate
 *    authentication domain and never authorize an approval.
 *  - Device auth comes from the DEVICE repository, never the task repository: the two are different
 *    objects in Habitat. `device-command-bridge.mjs` keeps the device store from
 *    `createD1DeviceCommandRepository` (which owns verifyDeviceToken) and the task store from
 *    `createD1CommandTaskRepository` (which does not). Pass that device store as `deviceRepository`,
 *    or pass its `verifyDeviceToken` bound as `verifyDevice(token, deviceId)`. Passing the task
 *    repository is rejected at construction, so the wiring mistake fails at boot instead of at 2am.
 *  - A real D1 query is provided (`createD1Query`) and built from env by default, so atomic claims
 *    do not need hand wiring.
 *  - `initialize()` actually starts the worker and registers SIGTERM/SIGINT handlers. Because
 *    Habitat installs no signal handler of its own (server.mjs only calls app.listen), the handler
 *    stops the worker and then exits the process itself; otherwise SIGTERM would be swallowed and
 *    Render would have to SIGKILL. Render's real behaviour remains unverified without a deployment.
 *
 *  Retries: an adapter failure is terminal - it goes through engine.fail and the task is 'failed',
 *  and the claim statement only ever selects status='queued', so a failed task is never reclaimed.
 *  Only an expired lease is retried, at most `maxAttempts` times, after which the task is failed.
 *  - Engine contracts match the real implementation: `fail({ taskId, error, by })` and
 *    `complete({ taskId, result, verifiedBy })`.
 *  - Lease recovery is bounded by maxAttempts: expired work is retried a finite number of times and
 *    then failed, never requeued forever.
 */

const HEARTBEAT_TABLE = `CREATE TABLE IF NOT EXISTS habitat_nexus_workers (
  worker_id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  detail TEXT
)`;

/** Exported so a one-shot tick can create the table without mounting the runtime. */
export const NEXUS_HEARTBEAT_TABLE_SQL = HEARTBEAT_TABLE;

/**
 * Heartbeat retention. Bounded, additive and never touches this worker's own row. It runs at most
 * once per `pruneIntervalMs`, so a crash-looping service cannot turn retention into write pressure.
 */
export const NEXUS_PRUNE_SQL =
  "DELETE FROM habitat_nexus_workers WHERE worker_id <> ? AND heartbeat_at < ? RETURNING worker_id";

/**
 * One query for queue health. `eligible` counts queued rows that name an adapter (the only rows a
 * worker may claim), `blocked` counts queued rows that name none and therefore wait for a human,
 * and `oldest` is the `updated_at` of the oldest eligible row — the age of the backlog.
 */
export const NEXUS_QUEUE_SQL =
  "SELECT " +
  "SUM(CASE WHEN status = 'queued' AND json_extract(record_json, '$.adapter') IS NOT NULL " +
  "AND json_extract(record_json, '$.adapter') <> '' THEN 1 ELSE 0 END) AS eligible, " +
  "SUM(CASE WHEN status = 'queued' AND (json_extract(record_json, '$.adapter') IS NULL " +
  "OR json_extract(record_json, '$.adapter') = '') THEN 1 ELSE 0 END) AS blocked, " +
  "MIN(CASE WHEN status = 'queued' AND json_extract(record_json, '$.adapter') IS NOT NULL " +
  "AND json_extract(record_json, '$.adapter') <> '' THEN updated_at END) AS oldest " +
  "FROM habitat_command_tasks";

function configInteger(env, name, fallback, min, max) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + " must be an integer between " + min + " and " + max + " (received " + JSON.stringify(raw) + ").");
  }
  return value;
}

/**
 * One resolver for every worker knob, used by the mounted runtime and by the one-shot tick, so a
 * scheduled run and an in-process run can never disagree about lease length or retry limits.
 *
 * Heartbeat intervals below 30 s are rejected rather than clamped: the point of the floor is to
 * keep D1 writes bounded, and silently accepting a smaller number would defeat it.
 */
export function resolveNexusConfig(env = {}) {
  return Object.freeze({
    pollMs: configInteger(env, "NEXUS_POLL_MS", 5000, 50, 3_600_000),
    leaseMs: configInteger(env, "NEXUS_LEASE_MS", 300_000, 200, 86_400_000),
    maxAttempts: configInteger(env, "NEXUS_MAX_ATTEMPTS", 3, 1, 100),
    adapterTimeoutMs: configInteger(env, "NEXUS_ADAPTER_TIMEOUT_MS", 120_000, 100, 86_400_000),
    shutdownTimeoutMs: configInteger(env, "NEXUS_SHUTDOWN_TIMEOUT_MS", 15_000, 0, 600_000),
    // Stored as seconds in the environment; the floor of 30 is the write budget guard.
    heartbeatMs: configInteger(env, "NEXUS_HEARTBEAT_SECONDS", 30, 30, 3_600) * 1000,
    retentionDays: configInteger(env, "NEXUS_RETENTION_DAYS", 7, 1, 365),
    staleQueueMs: configInteger(env, "NEXUS_STALE_QUEUE_SECONDS", 600, 60, 86_400) * 1000
  });
}

/**
 * Side-effecting adapters stay disabled until idempotency protection exists and is tested.
 * The worker retries an expired lease, so an adapter that cannot prove it is idempotent must never
 * be mounted: this guard turns that policy into a boot failure instead of a comment.
 */
export const SIDE_EFFECTING_ADAPTERS_ENABLED = false;

export function assertReadOnlyAdapters(adapters = {}) {
  const names = Object.keys(adapters || {});
  if (SIDE_EFFECTING_ADAPTERS_ENABLED) return names;
  const offending = names.filter(name => !READ_ONLY_ADAPTER_NAMES.includes(name));
  if (offending.length) {
    throw new Error(
      "Side-effecting adapters are disabled until idempotency protection is implemented and tested; refused: " +
      offending.join(", ") + ". Allowed read-only adapters: " + READ_ONLY_ADAPTER_NAMES.join(", ") + "."
    );
  }
  return names;
}

/** Queue depth and backlog age, from one query, for the runtime endpoint and the tick report. */
export async function readQueueHealth(query, { now = Date.now(), staleAfterMs = 600_000 } = {}) {
  const rows = await query(NEXUS_QUEUE_SQL);
  const row = rows?.[0]?.results?.[0] || {};
  const eligible = Number(row.eligible || 0);
  const blocked = Number(row.blocked || 0);
  const oldest = row.oldest || null;
  const parsed = oldest ? Date.parse(oldest) : NaN;
  const ageMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
  return {
    eligible,
    blocked,
    claimable: eligible > 0,
    oldestEligibleAt: oldest,
    oldestEligibleAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    staleAfterSeconds: Math.round(staleAfterMs / 1000),
    // Stale means eligible work has been waiting longer than the operator's deadline. It is an
    // alarm about throughput, not about correctness.
    stale: eligible > 0 && ageMs !== null && ageMs >= staleAfterMs
  };
}

export const NEXUS_HEARTBEAT_SQL =
  "INSERT INTO habitat_nexus_workers (worker_id, started_at, heartbeat_at, state, claimed, completed, failed, detail) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id) DO UPDATE SET " +
  "heartbeat_at = excluded.heartbeat_at, state = excluded.state, claimed = excluded.claimed, " +
  "completed = excluded.completed, failed = excluded.failed, detail = excluded.detail";

export const NEXUS_CLAIM_SQL =
  // A task is claimable only when it is queued (or approved working with no fence) AND it names an
  // adapter. Legacy or adapter-less rows stay queued for manual handling instead of being silently
  // claimed and failed by the worker. An unknown non-empty adapter is still claimed so the worker
  // can fail it with an explicit "no adapter registered" error.
  "UPDATE habitat_command_tasks SET status = 'working', " +
  "record_json = json_set(record_json, '$.status', 'working', '$.claimedBy', ?, '$.leaseUntil', ?, '$.fence', ?, '$.updatedAt', ?), " +
  "updated_at = ? WHERE id = (SELECT id FROM habitat_command_tasks WHERE (status = 'queued' " +
  "OR (status = 'working' AND json_extract(record_json, '$.fence') IS NULL)) " +
  "AND json_extract(record_json, '$.adapter') IS NOT NULL " +
  "AND json_extract(record_json, '$.adapter') <> '' " +
  "ORDER BY updated_at ASC LIMIT 1) " +
  "AND (status = 'queued' OR (status = 'working' AND json_extract(record_json, '$.fence') IS NULL)) " +
  "AND json_extract(record_json, '$.adapter') IS NOT NULL " +
  "AND json_extract(record_json, '$.adapter') <> '' " +
  "RETURNING record_json";

export const NEXUS_RENEW_SQL =
  // Extends a live lease, but only for the worker that still owns the fence.
  "UPDATE habitat_command_tasks SET record_json = json_set(record_json, '$.leaseUntil', ?, '$.updatedAt', ?), " +
  "updated_at = ? WHERE id = ? AND status = 'working' " +
  "AND json_extract(record_json, '$.fence') IS ? RETURNING id";

export const NEXUS_REQUEUE_SQL =
  // Atomic recovery: only one recoverer can move a given fence back to queued.
  "UPDATE habitat_command_tasks SET status = 'queued', " +
  "record_json = json_set(record_json, '$.status', 'queued', '$.attempts', ?, '$.leaseUntil', NULL, " +
  "'$.claimedBy', NULL, '$.fence', NULL, '$.updatedAt', ?), " +
  "updated_at = ? WHERE id = ? AND status = 'working' " +
  "AND json_extract(record_json, '$.fence') IS ? RETURNING id";

export const NEXUS_SEIZE_SQL =
  // Atomic takeover before failing exhausted work, so two recoverers cannot fail it twice.
  "UPDATE habitat_command_tasks SET record_json = json_set(record_json, '$.claimedBy', ?, '$.fence', ?, '$.updatedAt', ?), " +
  "updated_at = ? WHERE id = ? AND status = 'working' " +
  "AND json_extract(record_json, '$.fence') IS ? RETURNING id";

export const NEXUS_EXPIRED_SQL =
  // Two cases are expired: a lease that has run out, and a 'working' row that never got a lease
  // (for example a task moved to working by another path). Without the second case such a row
  // would stay 'working' forever. ISO-8601 strings compare correctly as text in SQLite/D1.
  "SELECT id, record_json FROM habitat_command_tasks WHERE status = 'working' " +
  "AND (json_extract(record_json, '$.leaseUntil') < ? " +
  "OR (json_extract(record_json, '$.leaseUntil') IS NULL AND updated_at < ?)) LIMIT 10";

/** Real D1 HTTP query for claims, lease recovery and heartbeats. Same database as the repo. */
export function createD1Query({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("Nexus runtime D1 access requires Cloudflare D1 credentials.");
  }
  // Same builder as the task repository: one database id, one endpoint, by construction.
  const endpoint = d1DatabaseEndpoint({ accountId, databaseId });
  return async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000)
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.success !== true) {
      throw new Error("D1 runtime query failed with HTTP " + response.status + "; verify D1 configuration.");
    }
    return payload.result || [];
  };
}

/*
 * There are no built-in adapters. The previous nexus.echo/nexus.inspect defaults fabricated
 * evidence from a task id, which let a task look completed without any real operation. An
 * unregistered adapter now fails closed, and callers must register adapters that do real work
 * and return evidence they actually obtained.
 */

function bearer(req) {
  const value = String(req.headers?.authorization || "");
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function same(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Resolve the device verifier. Accepts the device repository itself (preferred, because it names
 * the right object) or an already-bound function. A repository without verifyDeviceToken is a
 * wiring error and throws here, rather than silently disabling approvals.
 */
/** Owner devices come from explicit config; there is no "first paired device wins" default. */
function resolveOwnerDevices({ ownerDeviceId = null, ownerDeviceIds = null, env = {} } = {}) {
  const owners = new Set();
  const add = value => String(value || "").split(",").map(part => part.trim()).filter(Boolean).forEach(id => owners.add(id));
  add(ownerDeviceId);
  add(ownerDeviceIds);
  add(env.HABITAT_OWNER_DEVICE_ID);
  add(env.HABITAT_OWNER_DEVICE_IDS);
  return owners;
}

function resolveDeviceVerifier({ verifyDevice, deviceRepository }) {
  if (verifyDevice && typeof verifyDevice === "function") return verifyDevice;
  if (deviceRepository) {
    if (typeof deviceRepository.verifyDeviceToken !== "function") {
      throw new Error("deviceRepository must be the D1 device repository (verifyDeviceToken); the command-task repository cannot verify devices.");
    }
    return (token, deviceId) => deviceRepository.verifyDeviceToken(token, deviceId);
  }
  if (verifyDevice && typeof verifyDevice.verifyDeviceToken === "function") {
    return (token, deviceId) => verifyDevice.verifyDeviceToken(token, deviceId);
  }
  if (verifyDevice) {
    throw new Error("verifyDevice must be a function or an object with verifyDeviceToken().");
  }
  return null;
}

function validDeviceId(value) {
  const id = String(value || "").trim();
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(id);
}

function requireInteger(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error("Nexus worker config: " + name + " must be an integer between " + min + " and " + max + ".");
  }
}

export function createNexusWorker({
  repository,
  engine,
  query,
  adapters = {},
  workerId = "nexus-" + randomUUID().slice(0, 8),
  pollMs = 5000,
  leaseMs = 5 * 60 * 1000,
  adapterTimeoutMs = 120_000,
  maxAttempts = 3,
  shutdownTimeoutMs = 15_000,
  // Routine liveness beats are throttled to this interval; lifecycle transitions are not.
  heartbeatMs = 30_000,
  retentionDays = 7,
  pruneIntervalMs = 60 * 60 * 1000,
  renewLease = true,
  now = () => new Date().toISOString(),
  log = console
} = {}) {
  if (!repository) throw new Error("The Nexus worker needs a task repository.");
  if (!engine) throw new Error("The Nexus worker needs the command engine.");
  if (typeof query !== "function") throw new Error("The Nexus worker needs a D1 query function for atomic claims.");
  if (!adapters || typeof adapters !== "object") throw new Error("Nexus worker config: adapters must be an object.");
  requireInteger("pollMs", pollMs, 50, 3_600_000);
  requireInteger("leaseMs", leaseMs, 200, 86_400_000);
  requireInteger("adapterTimeoutMs", adapterTimeoutMs, 100, 86_400_000);
  requireInteger("maxAttempts", maxAttempts, 1, 100);
  requireInteger("shutdownTimeoutMs", shutdownTimeoutMs, 0, 600_000);
  requireInteger("heartbeatMs", heartbeatMs, 30_000, 3_600_000);
  requireInteger("retentionDays", retentionDays, 1, 365);
  requireInteger("pruneIntervalMs", pruneIntervalMs, 60_000, 86_400_000);

  let stopped = false;
  let aborted = false;
  let timer = null;
  let running = false;
  const counters = { claimed: 0, completed: 0, failed: 0, recovered: 0, exhausted: 0, stale: 0, renewals: 0 };
  const renewals = new Map();

  // Lifecycle and execution transitions are written immediately; routine liveness beats are
  // written at most once per heartbeatMs. `polling` and `idle` are the same routine state, so an
  // idle tick does not write twice just by naming itself differently — which is what made the old
  // policy cost two D1 writes every five seconds.
  const IMMEDIATE_HEARTBEAT_STATES = new Set(["starting", "executing", "stopped", "error"]);
  const ROUTINE_HEARTBEAT_STATES = new Set(["polling", "idle"]);
  let lastHeartbeat = { at: 0, state: null };
  let lastPruneAt = 0;
  let lastTick = null;

  async function heartbeat(state, detail = null) {
    const sameRoutineState = ROUTINE_HEARTBEAT_STATES.has(state) &&
      ROUTINE_HEARTBEAT_STATES.has(String(lastHeartbeat.state || ""));
    if (!IMMEDIATE_HEARTBEAT_STATES.has(state) && sameRoutineState && Date.now() - lastHeartbeat.at < heartbeatMs) {
      return false;
    }
    await query(NEXUS_HEARTBEAT_SQL, [workerId, now(), now(), state, counters.claimed, counters.completed, counters.failed, detail]);
    lastHeartbeat = { at: Date.now(), state };
    return true;
  }

  /**
   * Delete heartbeat rows for workers that stopped reporting long ago. Never deletes this worker's
   * row, never runs more than once per pruneIntervalMs, and never fails a tick: retention is
   * housekeeping, not execution.
   */
  async function pruneWorkerHeartbeats({ olderThanDays = retentionDays, force = false } = {}) {
    if (!force && Date.now() - lastPruneAt < pruneIntervalMs) return { pruned: false, reason: "not_due" };
    lastPruneAt = Date.now();
    const cutoff = new Date(Date.now() - Math.max(1, olderThanDays) * 86_400_000).toISOString();
    try {
      const rows = await query(NEXUS_PRUNE_SQL, [workerId, cutoff]);
      const removed = (rows?.[0]?.results || []).length;
      if (removed) log.log?.("NEXUS_WORKER: pruned " + removed + " heartbeat row(s) older than " + cutoff);
      return { pruned: true, cutoff, removed };
    } catch (error) {
      // A missing RETURNING support or a transient D1 failure must not break execution.
      log.warn?.("NEXUS_WORKER: heartbeat retention failed: " + String(error?.message || error));
      return { pruned: false, reason: "error", error: String(error?.message || error) };
    }
  }

  /** Re-read the row and confirm this worker still owns the fence. */
  async function owned(taskId, fence) {
    const current = await repository.get(taskId);
    if (!current) return null;
    if (current.status !== "working") return null;
    if (current.claimedBy !== workerId) return null;
    if (!fence || current.fence !== fence) return null;
    return current;
  }

  function stopRenewal(taskId) {
    const handle = renewals.get(taskId);
    if (handle) clearInterval(handle);
    renewals.delete(taskId);
  }

  function startRenewal(task) {
    if (!renewLease) return;
    stopRenewal(task.id);
    const every = Math.max(100, Math.floor(leaseMs / 3));
    const handle = setInterval(async () => {
      try {
        const rows = await query(NEXUS_RENEW_SQL, [new Date(Date.now() + leaseMs).toISOString(), now(), now(), task.id, task.fence]);
        if ((rows?.[0]?.results || []).length === 1) {
          counters.renewals += 1;
        } else {
          log.warn?.("NEXUS_WORKER: lease lost for " + task.id);
          stopRenewal(task.id);
        }
      } catch (error) {
        // A transient D1 failure is not proof of loss; the next heartbeat retries.
        log.warn?.("NEXUS_WORKER: lease renewal failed for " + task.id + ": " + String(error?.message || error));
      }
    }, every);
    if (typeof handle.unref === "function") handle.unref();
    renewals.set(task.id, handle);
  }

  /**
   * Lease recovery with a hard attempt ceiling. Requeue and takeover are conditional on the fence,
   * so competing recoverers cannot both requeue the same task or fail it twice.
   */
  async function recoverExpired() {
    const leaseFloor = new Date(Date.now() - leaseMs).toISOString();
    const rows = await query(NEXUS_EXPIRED_SQL, [now(), leaseFloor]);
    const expired = rows?.[0]?.results || [];
    let requeued = 0;
    let exhausted = 0;
    let lost = 0;
    for (const row of expired) {
      let task = null;
      try { task = JSON.parse(row.record_json); } catch { continue; }
      const fence = task?.fence ?? null;
      const attempts = Number(task?.attempts || 0) + 1;
      if (attempts >= maxAttempts) {
        const takeoverFence = randomUUID();
        const seized = await query(NEXUS_SEIZE_SQL, [workerId, takeoverFence, now(), now(), task.id, fence]);
        if ((seized?.[0]?.results || []).length !== 1) { lost += 1; continue; }
        const outcome = await engine.fail({
          taskId: task.id,
          error: "Lease expired after " + attempts + " attempt(s); retry limit reached.",
          by: workerId,
          claim: { fence: takeoverFence, workerId }
        });
        if (outcome?.ok === false) { lost += 1; continue; }
        exhausted += 1;
        counters.exhausted += 1;
        counters.failed += 1;
        continue;
      }
      const updated = await query(NEXUS_REQUEUE_SQL, [attempts, now(), now(), task.id, fence]);
      if ((updated?.[0]?.results || []).length === 1) {
        requeued += 1;
        counters.recovered += 1;
      } else {
        lost += 1;
      }
    }
    if (requeued || exhausted || lost) {
      log.warn?.("NEXUS_WORKER: recovered " + requeued + ", exhausted " + exhausted + ", lost " + lost);
    }
    return { requeued, exhausted, lost };
  }

  async function claim() {
    const at = now();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const fence = randomUUID();
    const rows = await query(NEXUS_CLAIM_SQL, [workerId, leaseUntil, fence, at, at]);
    const row = rows?.[0]?.results?.[0];
    if (!row?.record_json) return null;
    let task = null;
    try { task = JSON.parse(row.record_json); } catch { return null; }
    task.fence = fence;
    counters.claimed += 1;
    return task;
  }

  function adapterFor(task) {
    const name = String(task?.adapter || task?.tool || "").trim();
    return { name, run: name ? adapters[name] || null : null };
  }

  /** Fail only if this worker still owns the fence; never touch another worker's task. */
  async function failTask(task, error) {
    if (aborted) return { ok: false, reason: "shutdown_timeout" };
    const current = await owned(task.id, task.fence);
    if (!current) {
      counters.stale += 1;
      return { ok: false, reason: "stale_claim" };
    }
    counters.failed += 1;
    // The engine enforces the fence in the database transition, so a takeover between the check
    // above and this write still cannot overwrite the newer claim.
    const outcome = await engine.fail({
      taskId: task.id,
      error: String(error).slice(0, 1000),
      by: workerId,
      claim: { fence: task.fence ?? null, workerId }
    });
    if (outcome?.code === "stale_claim") {
      counters.failed -= 1;
      counters.stale += 1;
      return { ok: false, reason: "stale_claim", outcome };
    }
    if (outcome?.ok === false) counters.failed -= 1;
    return { ok: false, reason: "failed", outcome };
  }

  async function execute(task) {
    const pending = (Array.isArray(task.approvals) ? task.approvals : []).filter(entry => entry.state === "requested");
    if (pending.length) {
      const next = { ...task, status: "needs_approval", updatedAt: new Date().toISOString() };
      // Parking for owner approval releases the worker fence. Otherwise the owner's decision route
      // would see a fenced task and refuse it forever.
      delete next.fence;
      delete next.claimedBy;
      delete next.leaseUntil;
      // An unclaimed record has no fence: a plain update is the correct legacy path.
      if (!task.fence) {
        await repository.update(task.id, next);
        return { ok: false, reason: "approval_pending" };
      }
      // A worker-owned record moves with the same fenced compare-and-set used for completion,
      // so a takeover wins and this worker reports stale instead of overwriting it.
      const stillOwned = await owned(task.id, task.fence);
      if (!stillOwned) {
        counters.stale += 1;
        return { ok: false, reason: "stale_claim" };
      }
      const moved = typeof repository.transition === "function"
        ? await repository.transition(task.id, {
            expect: { status: "working", fence: task.fence, claimedBy: workerId },
            next
          })
        : await repository.update(task.id, next);
      if (!moved) {
        counters.stale += 1;
        return { ok: false, reason: "stale_claim" };
      }
      return { ok: false, reason: "approval_pending" };
    }

    const { name, run } = adapterFor(task);
    if (!run) {
      // Fail closed: an unknown or unavailable adapter must never look like success.
      return failTask(task, name ? 'No adapter registered for "' + name + '".' : "Task has no adapter and cannot be executed.");
    }

    startRenewal(task);
    let result;
    let timeout = null;
    const controller = new AbortController();
    try {
      // Bound every adapter. A hung adapter currently renews its own lease forever, so the task
      // never reaches the recovery path. The signal is advisory for adapters that support it; the
      // race is the authoritative deadline. A late result is ignored.
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("adapter timed out after " + adapterTimeoutMs + "ms"));
        }, adapterTimeoutMs);
        // A shutdown can give up on a hung adapter before this deadline. Do not let the pending
        // deadline keep a test process or a draining worker alive; the task lease remains the
        // durable recovery mechanism if the process exits first.
        if (typeof timeout.unref === "function") timeout.unref();
      });
      result = await Promise.race([
        Promise.resolve().then(() => run(task, { signal: controller.signal, timeoutMs: adapterTimeoutMs })),
        deadline
      ]);
    } catch (error) {
      clearTimeout(timeout);
      stopRenewal(task.id);
      return failTask(task, "adapter failed: " + String(error?.message || error));
    }
    clearTimeout(timeout);
    stopRenewal(task.id);

    // The lease may have expired and another worker may own the task by now.
    if (!(await owned(task.id, task.fence))) {
      counters.stale += 1;
      return { ok: false, reason: "stale_claim" };
    }

    if (result?.ok === false) {
      return failTask(task, "adapter reported failure: " + String(result?.error || "unspecified"));
    }
    const blockers = Array.isArray(result?.blockers) ? result.blockers.map(value => String(value || "").trim()).filter(Boolean) : [];
    if (blockers.length) {
      return failTask(task, "Adapter reported blockers: " + blockers.join("; ").slice(0, 500));
    }
    const evidence = Array.isArray(result?.evidence) ? result.evidence.map(value => String(value || "").trim()).filter(Boolean) : [];
    if (evidence.length === 0) {
      return failTask(task, "Adapter returned no evidence.");
    }
    const summary = String(result?.summary || "").trim();
    if (summary.length < 3) {
      return failTask(task, "Adapter returned no usable summary.");
    }
    // Shutdown already gave up on this task: do not write a completion the process may not live
    // to finish. The lease will expire and recovery will requeue it.
    if (aborted) {
      return { ok: false, reason: "shutdown_timeout" };
    }

    const outcome = await engine.complete({
      taskId: task.id,
      verifiedBy: workerId,
      claim: { fence: task.fence ?? null, workerId },
      result: {
        summary: summary.slice(0, 2000),
        decisions: Array.isArray(result?.decisions) ? result.decisions : [],
        blockers: [],
        evidence: evidence.slice(0, 20)
      }
    });
    if (outcome?.code === "stale_claim") {
      counters.stale += 1;
      return { ok: false, reason: "stale_claim", outcome };
    }
    if (outcome?.ok === false) {
      return failTask(task, outcome.error || "completion rejected");
    }
    counters.completed += 1;
    return { ok: true, outcome };
  }

  /**
   * One unit of work. Returns a result instead of swallowing it, so a one-shot runner can choose an
   * exit code and an operator can tell "nothing to do" from "could not talk to D1".
   */
  async function tick() {
    if (stopped || running) {
      return { ok: false, skipped: true, reason: stopped ? "stopped" : "already_running" };
    }
    running = true;
    const at = now();
    const before = { ...counters };
    const delta = () => ({
      claimed: Math.max(0, counters.claimed - before.claimed),
      completed: Math.max(0, counters.completed - before.completed),
      failed: Math.max(0, counters.failed - before.failed),
      recovered: Math.max(0, counters.recovered - before.recovered)
    });
    try {
      await heartbeat("idle");
      await pruneWorkerHeartbeats();
      await recoverExpired();
      const task = await claim();
      if (task) {
        await heartbeat("executing", task.id);
        await execute(task);
      }
      await heartbeat(stopped ? "stopped" : "idle");
      lastTick = { ok: true, at, finishedAt: now(), ...delta(), error: null, stage: "complete" };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      lastTick = { ok: false, at, finishedAt: now(), ...delta(), error: message, stage: "tick" };
      log.error?.("NEXUS_WORKER_TICK_FAILED", message);
      try { await heartbeat("error", message.slice(0, 200)); } catch {}
    } finally {
      running = false;
    }
    return lastTick;
  }

  /** Idempotent: a second start on a running worker leaves the existing timer alone. */
  async function start() {
    if (timer) return { started: true, alreadyRunning: true };
    stopped = false;
    await heartbeat("starting");
    log.log?.("NEXUS_WORKER: started as " + workerId);
    timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
    if (typeof timer.unref === "function") timer.unref();
    await tick();
    return { started: true, alreadyRunning: false };
  }

  /**
   * Stop claiming and wait for the in-flight task, but never longer than shutdownTimeoutMs.
   * Returns whether the wait timed out so callers can log an interrupted task honestly.
   */
  async function stop(reason = "shutdown") {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const id of [...renewals.keys()]) stopRenewal(id);
    const deadline = Date.now() + shutdownTimeoutMs;
    while (running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const timedOut = running;
    if (timedOut) aborted = true;
    try {
      await heartbeat("stopped", timedOut ? reason + ": timed out waiting for in-flight task" : reason);
    } catch {}
    log.log?.("NEXUS_WORKER: stopped (" + reason + ")" + (timedOut ? " with task still running" : ""));
    return { stopped: true, timedOut };
  }

  return Object.freeze({
    workerId,
    tick,
    start,
    stop,
    claim,
    recoverExpired,
    execute,
    pruneWorkerHeartbeats,
    lastTick: () => lastTick,
    heartbeat: () => ({ ...lastHeartbeat }),
    counters: () => ({ ...counters }),
    isRunning: () => running,
    isStarted: () => timer !== null,
    isStopped: () => stopped,
    maxAttempts,
    leaseMs,
    adapterTimeoutMs,
    shutdownTimeoutMs,
    heartbeatMs,
    retentionDays
  });
}

/**
 * Runtime + device approval routes.
 *
 * `verifyDevice(token, deviceId)` MUST be supplied by the server (the device bridge's
 * `store.verifyDeviceToken`). Without it the approval routes refuse with 503 rather than trusting
 * anything: this module never re-implements device authentication.
 */
export function registerNexusRuntime(app, {
  env = process.env,
  fetchImpl = fetch,
  repository = null,
  registry = null,
  query = null,
  worker = null,
  engine: engineOverride = null,
  adapters = null,
  verifyDevice = null,
  deviceRepository = null,
  ownerDeviceId = null,
  ownerDeviceIds = null,
  audit = null,
  // Refuse to mount an adapter that is not in the read-only set. Side-effecting adapters stay off
  // until idempotency protection exists; an embedder may only lower this after that work lands.
  enforceReadOnlyAdapters = true,
  handleSignals = true,
  exitOnSignal = true,
  exit = code => process.exit(code),
  log = console
} = {}) {
  const hasD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]
    .every(key => String(env[key] || "").trim());
  const store = repository || (hasD1 ? createD1CommandTaskRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const d1Query = query || (hasD1 ? createD1Query({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const toolRegistry = registry || createToolRegistry({ env });
  const engine = engineOverride || (store ? createUniversalCommandEngine({ repository: store, registry: toolRegistry }) : null);
  // Resolve knobs and the adapter policy before construction: an invalid value or a
  // side-effecting adapter disables the mount with a stated reason instead of running with
  // silently different semantics.
  const config = resolveNexusConfig(env);
  // An injected worker already owns its adapters, so the policy applies only to a worker this call
  // constructs from the supplied adapter map.
  if (!worker && adapters && enforceReadOnlyAdapters) assertReadOnlyAdapters(adapters);
  const runtime = worker || (store && d1Query ? createNexusWorker({
    repository: store, engine, query: d1Query, log,
    ...config,
    ...(adapters ? { adapters } : {})
  }) : null);

  const verify = resolveDeviceVerifier({ verifyDevice, deviceRepository });
  const owners = resolveOwnerDevices({ ownerDeviceId, ownerDeviceIds, env });
  // Non-secret identity for the database this process is actually using. A D1 database id is an
  // identifier, not a credential, but it is still not printed: a truncated SHA-256 lets an operator
  // confirm live and nonproduction point at different databases without exposing either id.
  const configuredDatabaseId = String(env.HABITAT_D1_DATABASE_ID || "").trim();
  const databaseFingerprint = configuredDatabaseId
    ? createHash("sha256").update(configuredDatabaseId, "utf8").digest("hex").slice(0, 12)
    : null;

  let ready = false;
  let started = false;
  let signalsAttached = false;
  let shuttingDown = false;
  const recordAudit = async entry => {
    if (typeof audit !== "function") return;
    try { await audit(entry); } catch (error) { console.error("NEXUS_AUDIT_FAILED", String(error?.message || error)); }
  };

  async function deviceFrom(req) {
    if (typeof verify !== "function") return { deviceId: null, reason: "unconfigured" };
    const deviceId = String(req.query?.deviceId || req.body?.deviceId || "").trim();
    const token = bearer(req);
    if (!validDeviceId(deviceId) || !token) return { deviceId: null, reason: "missing" };
    try {
      // Strict true: a verifier that returns a hash or any other truthy value has not proven
      // possession of the device token.
      return { deviceId: (await verify(token, deviceId)) === true ? deviceId : null, reason: "invalid" };
    } catch {
      // Infrastructure failure is NOT a credential failure. It is reported as 503, never 401,
      // and never as success.
      return { deviceId: null, reason: "error" };
    }
  }

  async function authorizeOwner(req) {
    const device = await deviceFrom(req);
    if (!device.deviceId) return device;
    if (owners.size === 0) return { deviceId: null, reason: "owner_unconfigured" };
    if (!owners.has(device.deviceId)) return { deviceId: null, reason: "not_owner" };
    return device;
  }

  function refuseDevice(res, reason) {
    if (reason === "unconfigured") {
      return res.status(503).json({ ok: false, error: "Device verification is not configured on this process." });
    }
    if (reason === "error") {
      return res.status(503).json({ ok: false, error: "Device verification is unavailable; no decision was made." });
    }
    if (reason === "owner_unconfigured") {
      return res.status(503).json({ ok: false, error: "Owner authorization is not configured; refusing to authorize approvals." });
    }
    if (reason === "not_owner") {
      return res.status(403).json({ ok: false, error: "This paired device is not the configured owner and cannot approve Nexus tasks." });
    }
    return res.status(401).json({ ok: false, error: "A paired owner deviceId and device token are required." });
  }

  function unavailable(res) {
    return res.status(503).json({ ok: false, error: "The command engine is not available on this process." });
  }

  app.get("/device/command/approvals", async (req, res) => {
    if (!store || !engine || !ready) return unavailable(res);
    const owner = await authorizeOwner(req);
    if (!owner.deviceId) return refuseDevice(res, owner.reason);
    const { deviceId } = owner;
    try {
      const list = await engine.list({ status: "needs_approval", limit: 50 });
      const tasks = (list?.tasks || []).map(task => {
        const pending = (Array.isArray(task.approvals) ? task.approvals : []).filter(a => a.state === "requested").slice(-1)[0];
        return {
          taskId: task.id,
          objective: String(task.objective || "").slice(0, 300),
          role: task.role || null,
          requestedBy: task.requestedBy || null,
          requestedAt: pending?.requestedAt || task.updatedAt || null,
          reason: pending?.reason || "Approval required before this task may run."
        };
      });
      return res.json({ ok: true, count: tasks.length, approvals: tasks });
    } catch (error) {
      console.error("DEVICE_APPROVALS_FAILED", String(error?.message || error));
      return res.status(502).json({ ok: false, error: "Could not read pending approvals." });
    }
  });

  app.post("/device/command/tasks/:id/approval", async (req, res) => {
    if (!store || !engine || !ready) return unavailable(res);
    const owner = await authorizeOwner(req);
    if (!owner.deviceId) return refuseDevice(res, owner.reason);
    const { deviceId } = owner;
    const taskId = String(req.params?.id || "").trim();
    const approved = req.body?.approved;
    if (!taskId || typeof approved !== "boolean") {
      return res.status(400).json({ ok: false, error: "taskId and a boolean approved field are required." });
    }
    try {
      const task = await store.get(taskId);
      if (!task) return res.status(404).json({ ok: false, error: "No such task." });
      const input = { taskId, by: "phone:" + deviceId, reason: String(req.body?.reason || "").slice(0, 200) || null };
      const outcome = approved ? await engine.approve(input) : await engine.deny(input);
      if (outcome?.ok === false) {
        return res.status(409).json({ ok: false, error: outcome.error || "The decision was rejected.", details: outcome.details || null });
      }
      const after = outcome?.task || await store.get(taskId) || {};
      await recordAudit({
        event: approved ? "device.command.approved" : "device.command.denied",
        actorDeviceId: deviceId,
        targetDeviceId: taskId
      });
      return res.json({
        ok: true,
        taskId,
        decision: approved ? "approved" : "denied",
        decidedBy: "phone:" + deviceId,
        decidedAt: new Date().toISOString(),
        status: after.status || null
      });
    } catch (error) {
      console.error("DEVICE_APPROVAL_FAILED", String(error?.message || error));
      return res.status(502).json({ ok: false, error: "Could not record the decision." });
    }
  });

  app.post("/device/command/tasks/:id/cancel", async (req, res) => {
    if (!store || !engine || !ready) return unavailable(res);
    const owner = await authorizeOwner(req);
    if (!owner.deviceId) return refuseDevice(res, owner.reason);
    const { deviceId } = owner;
    const taskId = String(req.params?.id || "").trim();
    if (!taskId) return res.status(400).json({ ok: false, error: "taskId is required." });
    try {
      const task = await store.get(taskId);
      if (!task) return res.status(404).json({ ok: false, error: "No such task." });
      const outcome = await engine.cancel({
        taskId,
        by: "phone:" + deviceId,
        reason: String(req.body?.reason || "").slice(0, 200) || null
      });
      if (outcome?.ok === false) {
        return res.status(409).json({
          ok: false,
          code: outcome.code || "cancel_rejected",
          error: outcome.error || "The cancellation was rejected.",
          status: outcome.status || null
        });
      }
      await recordAudit({ event: "device.command.cancelled", actorDeviceId: deviceId, targetDeviceId: taskId });
      return res.json({ ok: true, taskId, status: "cancelled" });
    } catch (error) {
      console.error("DEVICE_CANCEL_FAILED", String(error?.message || error));
      return res.status(502).json({ ok: false, error: "Could not cancel the task." });
    }
  });

  /**
   * One description of the executor, shared by /nexus/runtime (operator view) and the command
   * API's /ax/command/presence (Ax view), so the two views cannot drift apart.
   */
  async function describeRuntime() {
    if (!store || !d1Query) return { ok: false, reason: "no_query" };
    {
      const rows = await d1Query("SELECT worker_id, started_at, heartbeat_at, state, claimed, completed, failed, detail FROM habitat_nexus_workers ORDER BY heartbeat_at DESC LIMIT 5");
      const workers = (rows?.[0]?.results || []).map(row => ({
        workerId: row.worker_id,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        state: row.state,
        claimed: row.claimed,
        completed: row.completed,
        failed: row.failed,
        ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(row.heartbeat_at)) / 1000)),
        stale: Date.now() - Date.parse(row.heartbeat_at) > 120_000
      }));
      const live = workers.filter(entry => !entry.stale && entry.state !== "stopped");
      // Queue health is additive: if this read fails, the heartbeat answer is still useful and the
      // queue is reported as unavailable rather than being guessed at.
      let queue = { ok: false, error: "unavailable" };
      try {
        queue = { ok: true, ...(await readQueueHealth(d1Query, { staleAfterMs: config.staleQueueMs })) };
      } catch (error) {
        console.error("NEXUS_QUEUE_READ_FAILED", String(error?.message || error));
      }
      const state = !runtime
        ? "not_mounted"
        : !started
          ? "mounted_not_started"
          : live.length
            ? "running"
            : "started_no_live_heartbeat";
      return {
        ok: true,
        runtime: {
          workerConfigured: Boolean(runtime),
          workerStarted: started,
          // Compare this with the same fingerprint of the nonproduction database id to prove the
          // two services are not sharing storage. It is a truncated hash, never the id itself.
          databaseFingerprint,
          liveWorkers: live.length,
          heartbeatVerified: live.length > 0,
          // `asleep` is the honest reading of no live heartbeat: nothing is executing, which is not
          // the same as nothing failed and not the same as everything succeeded.
          asleep: live.length === 0,
          state,
          lastHeartbeatAgeSeconds: workers[0]?.ageSeconds ?? null,
          stoppedWorkers: workers.filter(entry => entry.state === "stopped").length,
          queue,
          staleQueue: queue.ok === true && queue.stale === true,
          heartbeatSeconds: config.heartbeatMs / 1000,
          sleepingNote: "No live heartbeat means nothing is executing. On a service that sleeps, that is a pause, not evidence that work succeeded.",
          workers
        }
      };
    }
  }

  app.get("/nexus/runtime", async (req, res) => {
    const axToken = String(env.HABITAT_AX_BRIDGE_TOKEN || "");
    if (!axToken || !same(bearer(req), axToken)) {
      return res.status(401).json({ ok: false, error: "Ax bridge authentication required." });
    }
    try {
      const described = await describeRuntime();
      if (!described.ok) return unavailable(res);
      return res.json({ ok: true, runtime: described.runtime });
    } catch (error) {
      console.error("NEXUS_RUNTIME_READ_FAILED", String(error?.message || error));
      return res.status(502).json({ ok: false, error: "Could not read runtime heartbeats." });
    }
  });

  function attachShutdown() {
    if (signalsAttached) return;
    signalsAttached = true;
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.on(signal, () => {
        log.log?.("NEXUS_RUNTIME: received " + signal);
        // Idempotent: a repeated signal during the drain must not abort it. Keep the handler
        // attached so a second SIGTERM cannot fall through to Node's default terminate.
        if (shuttingDown) return;
        shuttingDown = true;
        // No other signal handler exists in Habitat, so this handler must finish the process
        // itself; otherwise the default terminate behaviour is suppressed and Render has to
        // SIGKILL us after the grace period. Exit either way, even if stopping throws.
        const finish = () => { if (exitOnSignal) { try { exit(0); } catch {} } };
        Promise.resolve(shutdown(signal)).then(finish, error => {
          log.error?.("NEXUS_WORKER_STOP_FAILED", String(error?.message || error));
          finish();
        });
      });
    }
  }

  async function shutdown(reason = "shutdown") {
    shuttingDown = true;
    try {
      await runtime?.stop(reason);
    } finally {
      started = false;
    }
  }

  async function startNexusWorker() {
    if (!runtime) return { ok: false, started: false, reason: "no_worker" };
    if (started) return { ok: true, started: true, alreadyRunning: true };
    if (!ready) return { ok: false, started: false, reason: "not_initialized" };
    const result = await runtime.start();
    started = runtime.isStarted ? runtime.isStarted() : true;
    return { ok: true, started, alreadyRunning: Boolean(result?.alreadyRunning) };
  }

  return Object.freeze({
    worker: runtime,
    states: TASK_STATES,
    /**
     * Creates the heartbeat table, marks ready, and starts the worker. Starting is the point:
     * a runtime that is "ready" but not polling is exactly the dead-end this fixes.
     */
    async initialize({ startWorker = true } = {}) {
      if (!store) {
        log.warn?.("NEXUS_RUNTIME: disabled — D1 credentials are not configured");
        return { ok: false, durable: false, started: false };
      }
      if (!d1Query) return { ok: false, durable: false, started: false, reason: "no_query" };
      // Attach before any await: a signal during store setup or the first tick must be handled.
      if (handleSignals) attachShutdown();
      if (shuttingDown) return { ok: false, durable: false, started: false, reason: "shutting_down" };
      await store.initialize();
      if (shuttingDown) {
        // Partially initialized: no timer, no heartbeat loop, nothing to drain.
        return { ok: false, durable: false, started: false, reason: "shutting_down" };
      }
      await d1Query(HEARTBEAT_TABLE);
      if (shuttingDown) return { ok: false, durable: false, started: false, reason: "shutting_down" };
      ready = true;
      if (runtime && startWorker) {
        if (shuttingDown) return { ok: true, durable: Boolean(store.durable), worker: Boolean(runtime), started: false, reason: "shutting_down" };
        const startResult = await startNexusWorker();
        return { ok: true, durable: Boolean(store.durable), worker: Boolean(runtime), started: startResult.started, alreadyRunning: Boolean(startResult.alreadyRunning) };
      }
      return { ok: true, durable: Boolean(store.durable), worker: Boolean(runtime), started };
    },
    startWorker: startNexusWorker,
    shutdown,
    status() {
      return {
        ready, started, worker: Boolean(runtime), approvalsEndpoint: true, runtimeEndpoint: true,
        deviceVerifier: typeof verify === "function",
        ownerAuthorization: owners.size > 0, ownerDevices: owners.size,
        state: !runtime
          ? "not_mounted"
          : !ready
            ? "mounted_not_ready"
            : started
              ? "running"
              : "mounted_not_started",
        heartbeatSeconds: config.heartbeatMs / 1000,
        retentionDays: config.retentionDays,
        lastTick: runtime?.lastTick?.() || null
      };
    },
    /**
     * Ax's availability view. `canExecute` is true only when a heartbeat is fresh: a mounted but
     * unstarted worker, a sleeping service and a cron job that has not run are all reported as
     * unable to execute, never as success.
     */
    async presence() {
      let described;
      try {
        described = await describeRuntime();
      } catch (error) {
        console.error("NEXUS_PRESENCE_FAILED", String(error?.message || error));
        described = { ok: false, reason: "read_failed" };
      }
      if (!described.ok) {
        return {
          executor: { configured: Boolean(runtime), started, state: "unavailable", reason: described.reason },
          heartbeat: { verified: false, liveWorkers: 0, asleep: true, lastHeartbeatAgeSeconds: null },
          queue: { ok: false, error: "unavailable" },
          canExecute: false
        };
      }
      const runtimeView = described.runtime;
      return {
        executor: { configured: runtimeView.workerConfigured, started: runtimeView.workerStarted, state: runtimeView.state },
        heartbeat: {
          verified: runtimeView.heartbeatVerified,
          liveWorkers: runtimeView.liveWorkers,
          asleep: runtimeView.asleep,
          lastHeartbeatAgeSeconds: runtimeView.lastHeartbeatAgeSeconds
        },
        queue: runtimeView.queue,
        staleQueue: runtimeView.staleQueue,
        canExecute: runtimeView.heartbeatVerified,
        // True only for the in-process timer. A cron executor can be healthy with this false.
        willExecuteWithoutScheduler: runtimeView.workerStarted,
        heartbeatSeconds: runtimeView.heartbeatSeconds,
        lastTick: runtime?.lastTick?.() || null,
        observedAt: new Date().toISOString()
      };
    }
  });
}
