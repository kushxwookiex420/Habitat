# Autonomous workforce v1

A resilient, self-monitoring workforce built **on** the existing mission engine. The mission engine still
plans, gates approvals, delegates through the workforce registry and requires independent verification;
this layer adds durable ownership of execution, failure detection and an at-most-once ledger for external
operations. There is no second planner, no second scheduler and no second mission store.

Migration: `0018_ax_workforce_v1` (prepared, **not applied** to any live database).
Runtime: `ax-workforce-v1.mjs`, store in `d1-workforce-v1-repository.mjs`.
Flag: `HABITAT_WORKFORCE_ENABLED` (the existing workforce flag; leases attach only when 0018 exists).

## 1. What is durable, and what is not

| Layer | Table (0010) | Table (0018) |
| --- | --- | --- |
| who the worker is | `habitat_ax_workers` — specialty, adapter, capabilities, permissions | — |
| registration and liveness | — | `habitat_ax_workforce_workers` — state, accepting, heartbeat, revision |
| right to execute one task | — | `habitat_ax_workforce_leases` — owner, expiry, attempt, one `active` row per task |
| did the external call happen | `habitat_ax_worker_results` (verification) | `habitat_ax_workforce_executions` — at-most-once per attempt |
| what went wrong and when | `habitat_ax_worker_audit` | `habitat_ax_workforce_recovery` — expiries, stalls, resumes, uncertainty |

The agent record stays the identity the mission engine assigns to. The worker row is its execution
identity: a worker is who holds leases, sends heartbeats and can be deregistered.

## 2. Worker identity and capabilities

`registerWorker({ id, label, specialty, adapterId, capabilities, maxConcurrent, accepting, metadata })`

- `id` matches `^[a-z0-9][a-z0-9._-]{1,119}$`.
- `capabilities` is non-empty and each token matches `^[a-z0-9][a-z0-9._-]{0,60}$`. No free text.
- `maxConcurrent` is an integer 1–32; a worker at capacity refuses rather than queueing in memory.
- Registration is idempotent per id and bumps `revision`; the first `registeredAt` is preserved.
- `heartbeat({ id, state })` refreshes liveness; a deregistered worker is refused.
- `deregisterWorker({ id, force })` refuses while live leases exist (`worker_has_active_leases`) unless
  `force` is set, which marks those leases `abandoned` so the tasks become claimable immediately.

Derived health (never stored as a second truth):

| Status | Meaning |
| --- | --- |
| `healthy` | heartbeat within 2× the heartbeat interval |
| `degraded` | heartbeat is later than expected but not stale |
| `stalled` | no heartbeat for `stalledAfterMs` (default 120 s); **new work is refused** |
| `never_heartbeat` | registered but never beat; treated as stalled |
| `unavailable` / `draining` | declared by the worker; refused |
| `deregistered` | explicit retirement; refused, history retained |

## 3. Durable leases

`acquire({ taskId, missionId, workerId, requires, ttlMs, attempt })`

Order of checks, each a refusal rather than a warning:

1. worker exists, is not deregistered, is accepting, and its heartbeat is fresh;
2. every `requires` capability is declared by the worker;
3. the worker holds fewer leases than `maxConcurrent`;
4. an existing `active` lease for the task is expired first if its `expires_at` has passed;
5. otherwise the lease is inserted.

Step 5 is a single `INSERT` guarded by a partial unique index (`task_id WHERE state = 'active'`). Two
replicas racing the same task both reach the index and exactly one wins; the loser receives `lease_held`
with the current holder. Re-acquisition by the *same* worker renews the lease instead of creating a
second one, which is what makes a restarted worker able to continue its own task.

`renew({ leaseId, workerId, ttlMs })` is a conditional `UPDATE ... WHERE state = 'active' AND
expires_at > now`. A partitioned worker that wakes after expiry gets `lease_expired` — not an extension.
`release({ leaseId, workerId, state })` accepts `released`, `completed`, `abandoned` or `uncertain` and is
owner-only.

Lease TTL default: 60 s. Workers renew inside the TTL; the mission engine takes a lease per task attempt.

## 4. Failure detection and recovery

- **Missed heartbeats** — `detectStalledWorkers()` compares heartbeat age, writes a `worker.stalled`
  event on the transition only, and refuses new work from that worker. Recovery emits `worker.recovered`.
- **Stalled workers** are reported, never silently replaced or credited with work.
- **Expired leases** — `expireAbandonedLeases()` is one sweeping `UPDATE ... RETURNING`, so two sweeps
  cannot both claim the same lease. Each expiry is journaled with mission, task and worker.
- **Abandoned leases** come from a forced deregistration.
- **Reassignment** — the lease layer frees the task; the mission engine's `reconcile()` decides whether
  the task may run again (see §5). It requeues only when no attempt started.
- **Process restarts** — missions are resumed by `recover()`, which first sweeps leases, marks orphaned
  attempts uncertain, then re-runs every mission that was mid-flight through the same approval gate.
  Each resume emits `mission.resumed` with the number of tasks that were in flight.

## 5. Execution safety

The existing gate is unchanged and runs **before** any lease exists:

1. `executionGate({ mission, task })` re-validates the persisted authorization on every run
   (`approval_missing`, `approval_pending`, `approval_expired`, `approval_revoked`, parameter/target
   mismatch, and so on);
2. the stored owner signature is re-verified against the record as it is now (`consumeReplay: false`);
3. only then is a lease acquired and an execution attempt claimed.

At-most-once ledger:

- key: `missionId|taskId|a<attempt>`;
- `executionBegin` refuses when any attempt for the task already `succeeded` (`execution_already_succeeded`),
  is still `inflight` under a live lease (`execution_in_flight`), or ended `uncertain` (`outcome_uncertain`);
- an `inflight` row whose lease died is converted to `uncertain` and returned as a refusal — a crash
  between "we called the outside world" and "we recorded the answer" is never retried automatically;
- `executionComplete` settles an `inflight` row once. `uncertain` is terminal: it cannot be rewritten as
  `failed` (`execution_outcome_uncertain`), because a failure would invite the retry uncertainty forbids;
- a normal executor throw (before any external effect) settles the attempt `failed` and the existing
  bounded retry path may take a new attempt;
- an executor throw marked `{ uncertain: true }` (or `code: "outcome_uncertain"`) fails the task with
  `outcome_uncertain`, releases the lease as `uncertain` and never retries;
- the executor receives `task.executionKey` — the same `mission|mission.task|attempt` key the ledger uses —
  so it can forward an `Idempotency-Key` to any provider that supports one.

Verification is unchanged: `workforce.finalize` refuses self-verification, evidence-free results and
test-free verifications. The external operation is recorded `succeeded` *before* verification, so a
verification failure cannot cause the operation to be repeated (the ledger refuses, and `reconcile()`
fails the task as `outcome_uncertain`).

## 6. Self-monitoring

`status({ missions })` returns:

| Field | Meaning |
| --- | --- |
| `workers.total`, `byState`, `byHealth` | registered workers by declared state and derived health |
| `workers.accepting` | workers that would currently accept a lease |
| `workers.stalled` | ids with `stalled` / `never_heartbeat` |
| `activeAssignments.count/items` | live leases: mission, task, worker, attempt, expiry |
| `leases.active/expired/byState/total` | lease population |
| `leases.retries` | `SUM(attempt - 1)` — retried attempts, not retried tasks |
| `leases.expiringSoon` | leases expiring within 60 s |
| `executions.inFlight/succeeded/failed/uncertain` | attempt ledger |
| `executions.failedTasks` | distinct tasks with a failed or uncertain attempt |
| `recovery.total/byKind` | recovery journal by kind (`lease.expired`, `worker.stalled`, `outcome.uncertain`, …) |
| `missions.stalled/items` | tracked missions idle past `missionStallAfterMs` (15 min) |
| `missions.durations` | per mission: first acquisition → last release; `final: true` only when completed |
| `health.ok` | true only when no worker is unresponsive and no mission is stalled |

Metrics are computed from the store on each call. There is no cached counter that can drift.

## 7. Habitat API (dashboard contract)

All routes are read-only unless marked. Reads need `workforce:read`; mutations need `workforce:write`
(POST also needs `x-ax-timestamp` and `x-ax-nonce`).

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/ax/v1/workforce` | `{ workforce: status }` — the object in §6 |
| GET | `/ax/v1/workforce/workers` | `{ workers, count }` — filters `capability`, `state`, `healthy=true` |
| GET | `/ax/v1/workforce/workers/:id` | `{ worker, assignments, leases, executions }`; 404 `worker_unknown` |
| GET | `/ax/v1/workforce/assignments` | `{ assignments, count }` — active leases |
| GET | `/ax/v1/workforce/health` | `{ health, workers, heartbeat[] }` — heartbeat age in ms and ISO |
| GET | `/ax/v1/workforce/recovery` | `{ events, count }` — filters `missionId`, `kind`, `limit` |
| GET | `/ax/v1/workforce/missions/:id` | `{ missionId, workers, tasks[], active, history[] }` |
| POST | `/ax/v1/workforce/workers` | register/update a worker identity |
| POST | `/ax/v1/workforce/workers/:id/heartbeat` | record a heartbeat, return derived health |
| POST | `/ax/v1/workforce/workers/:id/deregister` | `{ force }`; 409 while leases are live |

When 0018 is absent, or the runtime has not attached the lease layer, every route answers
`503 workforce_leases_not_attached`. It never fabricates an empty but healthy workforce.

`/system/status` gains `workforceV1: { attached, ready, enforced, migration, missing, error }`, so
"migration 0018 is prepared but not applied" is visible without guessing.

### Dashboard mapping

| Panel | Source |
| --- | --- |
| Worker list and health dots | `GET /workforce/workers` (`health.status`, `heartbeatAgeMs`) |
| Live assignments board | `GET /workforce/assignments` |
| Lease countdown | `expiresAt` from assignments, refreshed on the server clock |
| Recovery feed | `GET /workforce/recovery?limit=50` |
| Mission drill-down | `GET /workforce/missions/:id` |
| Reliability header | `GET /workforce` → `health`, `leases.retries`, `executions.uncertain`, `missions.stalled` |

A dashboard must render `uncertain` and `stalled` as **attention states**, not as retryable failures: the
correct operator action is to inspect the provider, not to press run again.

## 8. Tests

`tests/workforce-v1-leases.test.mjs` (14) and `tests/workforce-v1-routes.test.mjs` (3) cover:

worker crash and lease expiry with reassignment; 20 simultaneous claims across two instances producing
exactly one owner; stale renewal refused; wrong-owner release refused; missed heartbeat refusing work and
restoring it after a heartbeat; deregistration guarded while leases are live and forced abandonment;
capability mismatch and capacity; in-flight duplicate refused; succeeded attempt refused for a later
attempt; uncertain outcome terminal; dead-owner attempt converted to uncertain and never retried; state
surviving a restart (lease, ledger, worker); monitoring totals; verification failure not repeating the
external call; uncertain executor outcome not retried; mission resumed after a lost lease with no repeat
execution; HTTP auth, scope enforcement, 503 without the layer, and every dashboard read shape.

Executor spies count releases, so "the task failed" and "the operation ran twice" are separate assertions.

## 9. Unresolved reliability risks

1. **No multi-statement transaction in the D1 HTTP wrapper.** Lease insert, execution claim and mission
   record write are separate statements. Compensation is explicit (release the lease, settle the attempt)
   and failures fail closed, but a process dying between two of them leaves an `inflight` attempt that is
   later marked `uncertain` — safe, but it needs an operator to resolve the task.
2. **Heartbeat is process-driven.** A worker that is alive but wedged (event loop blocked) stops
   heartbeating and will be treated as stalled. TTLs must be longer than the longest single executor call
   or a healthy long task will look abandoned. The default 60 s TTL assumes a renewal loop.
3. **Expiry is a sweep, not a timer.** A task blocked by a dead owner waits for the next tick (mission
   tick / `recover()`), bounded by the tick interval, not by the TTL alone.
4. **Reassignment re-runs work that never started.** A lease that expired before `executionBegin` is
   requeued; a lease lost mid-attempt is not. The distinction depends on the executor calling
   `executionBegin` before its first external effect — an executor that does its work before claiming the
   attempt would lose that protection.
5. **Uncertainty is terminal by design.** There is no automatic reconciliation with the provider and no
   "retry after checking" flow yet: an uncertain task needs a human or a new mission.
6. **Ledger retention is unbounded.** Executions, leases and recovery rows are never deleted. A long-lived
   deployment will need an archival policy that keeps at least every `succeeded`/`uncertain` key.
7. **Worker identity is not authenticated at the transport.** The engine trusts the caller that presents a
   worker id; route-level enforcement relies on the gateway client scope. A worker-facing credential per
   identity is not implemented.
8. **The mission engine and the lease layer are not a distributed transaction either.** A lease can be
   acquired for a task whose mission record then fails to persist; the lease is released by the next
   reconcile, and the task is requeued only if no attempt started.
9. **D1 behaviour is verified on SQLite only.** `migrations:check`, the repository and the tests use
   `node:sqlite`. The partial unique index and `UPDATE ... RETURNING` are SQLite semantics that D1 shares,
   but no D1 instance has executed this migration.
10. **Load.** Capacity, lease and execution checks are separate reads; under heavy concurrency the
    database, not the process, is the bottleneck. No rate limit is applied to lease acquisition.
