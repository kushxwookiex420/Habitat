# Ax execution lifecycle, recovery and readiness

Adversarial review of the Mission 04 orchestrator. Everything below is a defect found in the code as
it stood at `ad3bea9`, what it would have done in production, and what was changed. Tests:
`tests/ax-orchestrator-lifecycle.test.mjs` (19), plus the Mission 04 suite.

**Nothing here is live.** No OpenAI call, no deployment, no production D1.

---

## 1. Defect register

| # | Severity | Defect | Consequence | Fix |
| --- | --- | --- | --- | --- |
| D-1 | **High** | The deadline was written as a final status (`deadline_exceeded`) with no later reconciliation | Work finishing after the deadline was never reflected; the run looked cancelled while its task kept running | `settled: false`, an explicit "NOT cancelled" note, and reconciliation from task rows on read (`recoveries`, `recoveredNote`) |
| D-2 | **High** | A run whose driver crashed stayed `running` forever | An operator could never tell a live run from a dead one | `GET /runs/:id` reconciles any unsettled run from its tasks and persists the derived status |
| D-3 | **High** | Run ids were random, so retrying the same objective produced new idempotency keys | **Duplicate tasks** on every retry or crash-then-retry | Deterministic run id from an optional `runKey`; reusing a key resumes; a different objective on the same key is `400 run_key_reused` |
| D-4 | **High** | A task id could exist with no step record (crash between submit and save) | Recovery could not find the task, and a retry could create a second one | The step is persisted **before** submission with `taskIdForKey(key)`; recovery adopts the existing task (`adopted: true`) |
| D-5 | **High** | `verifyResult` accepted any evidence whose `verifiedBy` started with `nexus-` | A forged record in the task table would verify | Evidence digest bound to task id + attempt (written by the engine), worker identity = the claimant, completion transition attributed to that identity, attempt freshness, id match |
| D-6 | **Medium** | Budget was checked only after a model call; failed calls and responses without usage cost 0 | Repeated failures were free and could bypass the budget | Pre-call check, `AX_FAILED_CALL_COST_USD` charged on failure/timeout/missing usage, budget judged **before** the outcome |
| D-7 | **Medium** | Run writes were last-write-wins | A late reconciler could overwrite a newer run state | Compare-and-swap on the exact stored bytes; the loser gets `run_conflict` and adopts the winner |
| D-8 | **Medium** | A D1 write failure was swallowed as `storeError` and the run returned as if durable | An operator would see a run that did not exist in storage | Initial and subsequent write failures return `503 store_unavailable`; nothing is submitted without a durable record |
| D-9 | **Medium** | Every request re-ran the DDL; concurrent initializers duplicated it | Wasted D1 statements and a race on first use | One memoized initializer per repository, retried after a failure |
| D-10 | **Low** | `engine.get` returning `not_found` was treated as "task unreadable" | First submission after a restart was skipped entirely (found by the new suite) | `not_found` is the normal pre-submission state; only real read failures block |
| D-11 | **Medium** | Prices defaulted to $2.00/$10.00 per 1M and the model id was unverified | Cost reporting overstated by 20×; an invalid model id would fail every run | `gpt-6-luna` confirmed on OpenAI's model page (Chat Completions supported); defaults corrected to **$0.10 / $0.50** |
| D-12 | **Doc** | "Data stays in D1" | False: objectives and failures are sent to OpenAI | Privacy section rewritten in `docs/AX_NATIVE_ORCHESTRATOR.md`; see §5 below |
| D-13 | **High** | `submitPhase` skipped any step that already had a task id — and `ensureStep` persists that id *before* submitting | A process dying between `persist` and `engine.submit` left a step with an id and no task. Every resume skipped it, so the run never submitted the work: it polled to the deadline and reported `deadline_exceeded` forever | `submitPhase` always delegates to adopt-or-submit; an existing step with no task is submitted under its **original** key. See §7 |

## 2. Recovery semantics (what a crash now does)

| Crash point | What survives | What recovery does |
| --- | --- | --- |
| 1. After creating the run | run record | resumes; plans once |
| 2. After the plan is saved | plan + charge | submits the missing steps only |
| 3. After saving the step, before submitting its task | step with its deterministic id | submits the missing task under that same key (D-13) |
| 3b. After submitting a task, before saving the step | task (deterministic id) | adopts it, does not resubmit |
| 4. After claiming a task | claim + fence + lease | the worker either finishes (fenced) or the lease expires and a later tick requeues it |
| 5. After the adapter ran, before the result is saved | claim only | same as 4: the task is requeued and the adapter runs again — **at-least-once**, which is why only read-only adapters may be registered |
| 6. After evidence is saved, before the run is updated | done task with evidence + digest | reconciliation marks the step verified; no second execution |
| 7. During corrective submission | correction counter, plan, charge | adopts the corrective task by its deterministic id, or reports `failed` if the repair never reached the model |

Exactly-once side effects are **not** claimed. The read-only adapter restriction is the guarantee that
at-least-once execution is harmless, and it stays in force
(`SIDE_EFFECTING_ADAPTERS_ENABLED` is false and `assertReadOnlyAdapters` refuses at mount).

## 3. Concurrency

- **Two drivers, one run**: task submission is idempotent per key; run writes are CAS. The loser stops
  and returns the winner's record.
- **Two cron executors**: the claim is one conditional `UPDATE … RETURNING` with a fence and a lease.
  A duplicate tick claims nothing. Proven by the duplicate-invocation test and the existing fencing
  suite.
- **Late worker result**: fenced transitions require the current fence; a completed task refuses
  further completion (`invalid_transition`).
- **Late reconciler**: CAS rejects the stale write.
- **Known residual**: two *simultaneous first-time* requests with the same `runKey` can both plan
  before one adopts the other's record. That costs one extra model call; it cannot duplicate a task.

## 4. Evidence binding

A completion now carries `attempt` and `evidenceDigest = sha256(taskId, attempt, evidence…)`, written
by the engine when it closes the task. Verification requires:

1. the task id matches the step;
2. status `done`;
3. non-empty evidence;
4. `verifiedBy` matches `^nexus-[A-Za-z0-9-]+$`;
5. `verifiedBy` equals `claimedBy` when the task still records a claimant;
6. the last `done` transition in `statusHistory` is attributed to that identity;
7. `result.attempt` equals the task's current attempt count;
8. the recomputed digest matches.

Each of the eight has a negative test. Editing evidence, copying it from another task, replaying an
older attempt, or claiming a worker identity without having closed the task all fail.

## 5. What is sent to OpenAI

| Sent | Not sent |
| --- | --- |
| the objective text (≤ 2000 chars) | repository contents, file contents |
| the names of the three read-only adapters | task results or evidence |
| the failed step's objective and its error text on a repair call | device ids, owner ids, bridge or command tokens, D1 credentials |

Stored in D1: the run record (objective, plan, task ids, evidence, token usage, cost) in
`habitat_ax_runs`, and ordinary task rows in `habitat_command_tasks`. Neither table expires
automatically; retention is an owner decision. Errors are redacted (`sk-…`, `Bearer …`) before they
are persisted or returned.

## 6. Residual risks that cannot be eliminated

1. **At-least-once adapter execution** — a crash after a side effect repeats it. Read-only adapters
   only; reopening this requires idempotent adapters and a new approval.
2. **Paid but unrecorded model calls** — a crash between a model response and `persist` under-reports
   cost by one call. The budget is enforced on recorded spend, so the true ceiling is
   `budget + one call`.
3. **Plan loss** — a crash before the plan is saved means the next attempt re-plans and pays again.
   No task exists at that point, so nothing is duplicated.
4. **Externally deleted tasks** — a step whose task vanishes stays open with `readError:
   "task_missing"` until the deadline, then reports `deadline_exceeded`. It never reports success.
5. **Reconciliation writes on read** — throttled by `AX_RECONCILE_AFTER_MS` (default 2 s); a very
   aggressive poller still causes writes, bounded by the CAS.
6. **Model plan quality** — the adapter allowlist and evidence check bound the damage, not the
   reasoning.
7. **Single account, single workspace** — nobody has run this against a live model or Render.

## 7. The missing-submission defect (Mission 06)

**What happened.** `ensureStep` writes the step — including its deterministic task id — and *then*
submits. `submitPhase` then skipped any step that already had a task id:

```js
if (existing && (existing.taskId || existing.status === "needs_approval")) continue;
```

That test cannot tell "persisted before submission" from "already submitted", so a crash between the
two left a step that every subsequent attempt skipped. No task was ever created; `refreshStep`
reported `task_missing`; the driver polled until the deadline and the run reported
`deadline_exceeded` with `settled: false` — for good, because the task would never appear. The work
was lost and the run could not recover.

**Why it happened.** The skip was written as an optimisation for "this step is already handled"
using a field that is written *before* the very action it was meant to detect. The persisted id was
treated as evidence of submission; it is only evidence of intent.

**Corrected sequence.** `submitPhase` no longer decides anything. It calls `ensureStep`, which now:

1. keeps the persisted `key` and `taskId`, generating one only when the step is new;
2. refuses a step whose `taskId` disagrees with `taskIdForKey(key)` (`task_id_mismatch`, no task
   created) rather than submitting under a second id;
3. reads the task: read failure → leave the step open with `readError`, submit nothing;
   task present → adopt, refresh and verify; task absent → submit under the **original** key and bind
   the returned id.

A corrective step persisted before its task was submitted is the same state; `recoverCorrective`
restores it by its own key and relinks it to the failed step it repairs, instead of spending a new
correction.

**Crash boundaries now covered by tests**: step persisted / task missing; task submitted / run not
updated; two drivers recovering at once; unreadable lookup; completed task; running task; approval
step; terminal failure; repeated retries; failed run write; orphaned corrective step; mismatched id.

**Limitation.** Recovery happens when the run is driven again (a `POST /runs` with the same
`runKey`). A `GET` reconciles states but never submits work, by design: reads must not create tasks.
A run whose stored task vanished externally therefore stays visibly unsettled rather than silently
recreating it.

## 8. Verdict

| Question | Answer |
| --- | --- |
| Can Ax recover after a crash? | **Yes**, for every boundary where something was persisted: it submits a task that was never created, adopts one that was, and converges from task rows. The only loss is one unrecorded model charge. |
| Can multiple cron executors duplicate execution? | **No.** The claim is atomic and fenced; a losing tick claims nothing. |
| Can a run claim completion without genuine evidence? | **No.** Eight conditions, each with a negative test, including a digest bound to the task and attempt. |
| Can it exceed its model budget? | **No material overspend.** It can exceed by at most one in-flight call; every extra call is preceded by a budget check. |
| Can it bypass owner approval? | **No.** A step marked `needsApproval` is never submitted; approvals still require the owner device. |
| Ready for a controlled production deployment? | **Conditionally.** Code paths are hardened and covered, but no live model call, live D1 or Render run has happened. Deploy behind `AX_ORCHESTRATOR_ENABLED` on one service, with a small `AX_RUN_BUDGET_USD`, and run the acceptance objective in §7 of `docs/AX_NATIVE_ORCHESTRATOR.md` before letting a cron start runs unattended. |
