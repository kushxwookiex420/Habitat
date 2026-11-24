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
   "retry after checking" flow yet: an uncertain task needs a human or a new mission. *(Superseded by §10:
   an owner-attested reconciliation path exists; the decision is still manual and never automatic.)*
6. **Ledger retention is unbounded.** Executions, leases and recovery rows are never deleted. A long-lived
   deployment will need an archival policy that keeps at least every `succeeded`/`uncertain` key.
7. **Worker identity is not authenticated at the transport.** The engine trusts the caller that presents a
   worker id; route-level enforcement relies on the gateway client scope. A worker-facing credential per
   identity is not implemented. *(Resolved for the HTTP boundary by §10; in-process callers are still
   trusted, which is the owner's own code.)*
8. **The mission engine and the lease layer are not a distributed transaction either.** A lease can be
   acquired for a task whose mission record then fails to persist; the lease is released by the next
   reconcile, and the task is requeued only if no attempt started.
9. **D1 behaviour is verified on SQLite only.** `migrations:check`, the repository and the tests use
   `node:sqlite`. The partial unique index and `UPDATE ... RETURNING` are SQLite semantics that D1 shares,
   but no D1 instance has executed this migration.
10. **Load.** Capacity, lease and execution checks are separate reads; under heavy concurrency the
    database, not the process, is the bottleneck. No rate limit is applied to lease acquisition.

## 10. Workforce security and recovery v2 (0019)

v1 trusted whoever presented a worker id, and an `uncertain` attempt had no way back. v2 fixes both without
changing the v1 lease or mission semantics.

### 10.1 Signed worker requests

A worker identity is durable; the right to act as it is a separate credential.

```
AX-WORKER-REQUEST-V1
<workerId>
<credentialId>
<heartbeat|lease.acquire|lease.renew|lease.release>
<nonce>
<timestamp>
<sha256 of canonical JSON body>
```

`x-ax-signature: v1,<base64url HMAC-SHA256>` with the credential secret. The server:

1. parses `axw_<credentialId>_<secret>` and loads the credential (**constant-time compare** of the MAC);
2. refuses `revoked` immediately, and `rotated` once `grace_until` has passed;
3. requires `|now − timestamp| ≤ 5 min` and a 16–128 char nonce, checked **after** the MAC so a forgery
   cannot burn a nonce;
4. records the nonce under the credential's primary key — a replay loses at the database, not in a race;
5. derives the worker id from the credential. The path id is compared to it for heartbeats
   (`403 worker_identity_mismatch`), and lease operations are ownership-checked by the engine
   (`403 lease_not_owned`).

Signing the body hash is what stops a valid signature from being re-aimed at a different body; signing the
operation is what stops a renewal signature from being replayed as a release.

### 10.2 Credentials and owner authority

| Operation | Route | Authority |
| --- | --- | --- |
| register | `POST /ax/v1/workforce/workers` | `workforce:admin` + owner attestation |
| deregister | `POST /ax/v1/workforce/workers/:id/deregister` | `workforce:admin` + owner attestation; revokes all keys |
| issue | `POST /ax/v1/workforce/credentials` | `workforce:admin` + owner attestation |
| rotate | `POST /ax/v1/workforce/credentials/:id/rotate` | `workforce:admin` + owner attestation |
| revoke | `POST /ax/v1/workforce/credentials/:id/revoke` | `workforce:admin` + owner attestation |

The attestation reuses `HABITAT_OWNER_ATTESTATION_KEY` (no second trust root). Its `statement` field carries
`workforce:<operation>:<workerId|credentialId>[:detail]`, where a registration's detail is
`sha256(capabilities) + ":" + maxConcurrent`. The gateway re-derives the statement from the body and the
engine compares it again, so a signature for one worker or capability set cannot be reused for another.

Rotation returns a new secret once, marks the old credential `rotated` with `rotated_to` and a grace window,
and leaves the worker id, leases and history untouched. Deregistration revokes every key the worker holds.

### 10.3 Provider references and reconciliation

Every attempt can record `provider` and `provider_reference`. The mission engine records them when the
executor returns or throws them, so an uncertain attempt is never anonymous.

`GET /ax/v1/workforce/uncertain[/:key]` is strictly read-only: it returns the execution, the lease, the
provider reference and whether a retry is permitted. It never calls a provider.

| verdict | execution | retry allowed | decision recorded |
| --- | --- | --- | --- |
| `unknown` | stays `uncertain` | no | `hold_uncertain` |
| `confirmed_success` | `uncertain → succeeded` | no (`execution_already_succeeded`) | `completed` |
| `confirmed_failure` | stays `uncertain` | no (`outcome_uncertain`) | `hold_uncertain` |
| `not_executed` **with proof** | `uncertain → failed` | yes, next attempt may begin | `requeue` |

Proof (`proof.evidence`, plus an optional provider reference) is mandatory for every verdict except
`unknown`; without it the route answers `422 reconciliation_proof_required` and nothing changes. A settled
verdict is never downgraded back to `unknown` by a later observation, though an owner may refine it with new
proof.

### 10.4 Recovery decisions

- an expiry that interrupts an `inflight` attempt marks it `uncertain` and records `hold_uncertain`;
- an expiry before any attempt records `requeue`;
- forced deregistration records `requeue` or `hold_uncertain` for each abandoned lease;
- every decision is appended to `habitat_ax_workforce_reassignments` (from/to worker, lease, reason,
decision, detail) and to the recovery journal as `recovery.decision`.

The sweep still uses one atomic `UPDATE`, so two concurrent `recover()` calls expire a lease exactly once
and write exactly one decision.

### 10.5 Health: slow versus dead

`active_execution` is new: the heartbeat is older than `stalledAfterMs`, but an active lease was renewed
inside `activeExecutionWindowMs`. It is reported with `stale: false`, excluded from `stalled`, and refused
new work with `409 worker_executing`. A crashed process cannot renew, so it still becomes `stalled`. Set
`activeExecutionWindowMs` to at least twice the renewal interval.

### 10.6 Observability added

`GET /ax/v1/workforce` gains `identity {ready, missing, credentials, workersWithCredentials, unresolved}`,
`uncertainOperations {count, items, detail}`, `reassignments {recorded, decisions, recent}`,
`workers.executing[]`, `lastHeartbeatAt` / `lastLeaseActivityAt` per worker, and `identityMigration`.

Read routes: `/uncertain`, `/uncertain/:key`, `/recovery/queue`, `/reassignments`, `/missions` (failed and
stalled). Gateway audit entries for worker routes carry `workerId` and `credentialId`.

### 10.7 v2 residual risks

1. **Symmetric secrets at rest.** `secret_key` must be readable to verify an HMAC. Anyone with database read
   access can impersonate a worker. Rotate on suspicion; treat D1 access as identity access.
2. **Proof is operator-supplied.** The engine cannot verify a provider's evidence; it records it. A wrong
   `not_executed` verdict is a human error that the ledger cannot detect.
3. **No automatic provider polling.** Reconciling an uncertain attempt is a manual, owner-attested action.
4. **Nonce retention is unbounded.** Rows are single-use and expire by timestamp but nothing deletes them;
   add pruning before long-lived deployment.
5. **In-process trust.** `trusted: true` / `requireOwnerAuthorization: false` bypass owner attestation for
   callers inside the process (runtime bootstrap, tests). The HTTP boundary never uses them.
6. **Clock skew.** The 5-minute window tolerates skew but a badly skewed worker clock rejects every request;
   there is no per-worker offset negotiation.
7. **Single-instance rate limiting for workers is keyed by credential in memory** (the shared counter still
   keys by client id), so a multi-instance deployment can exceed the per-credential budget.
