# NEXUS autonomous execution (Mission 14)

**Evidence level: locally implemented and locally tested.** The lifecycle below is exercised by
`tests/ax-nexus-e2e.test.mjs` through the real composition root: real HTTP routes, real command
engine, real NEXUS tick, real adapter, real evidence, real objective accounting, real scheduler
lease, real security log. The model transport is simulated; no OpenAI account, D1 or Render service
is involved.

---

## 1. The lifecycle, step by step

| # | Required behaviour | Where it happens | Proof |
| --- | --- | --- | --- |
| 1 | Receive an objective | `POST /ax/command/objectives`, `POST /ax/command/messages` | `ax-objectives.test.mjs`, `ax-message-channel.test.mjs` |
| 2 | Break it into bounded tasks | planner (`ax-providers` + `ax-orchestrator`), or the objective's own plan | `ax-native-orchestrator.test.mjs`, E2E |
| 3 | Select an authorised agent | `ax-agents.selectAgent` + objective plan step `agent` | `ax-agents.test.mjs` |
| 4 | Check capabilities and permissions | `autonomousPolicy`, agent manifests, adapter allowlist | E2E approval-gated test |
| 5 | Check the budget | `objectiveAccounting` before any paid call | `ax-accounting.test.mjs` |
| 6 | Obtain approval if required | objective `approval.required`; owner device only | E2E test 3 |
| 7 | Reserve budget before execution | `reserveExecution` with a deterministic execution id | E2E autonomy test |
| 8 | Dispatch the task | `dispatchObjective` → `orchestrator.runObjective` → engine | E2E autonomy test |
| 9 | Collect real execution evidence | read-only adapter output bound to the task attempt | `nexus-adapter-*` suites, E2E |
| 10 | Verify the result | eight-condition digest/claimant verification in the orchestrator | `ax-orchestrator-lifecycle.test.mjs` |
| 11 | Settle the budget | `settleExecution` replaces the reservation with actual cost | E2E autonomy test |
| 12 | Record the security event | hash-chained security log, awaited | E2E exchange test |
| 13 | Notify Ax | durable message completion + inbox notification | `ax-notifications.test.mjs`, E2E |
| 14 | Recover interrupted work | deterministic keys, adopt-or-submit, lease reclamation, reservation reconciliation | `ax-orchestrator-lifecycle`, `ax-scheduler-multiprocess` |

The new Mission 14 glue is small on purpose:

- `ax-objective-dispatch.mjs` — one implementation of dispatch (reserve → run → link → settle →
  attach tasks/evidence → checkpoint) plus `autonomousPolicy`.
- `ax-scheduler.mjs` — one optional `autonomy` callback per tick, run under the existing lease.
- `device-command-bridge.mjs` — the callback: drain the message channel, then advance eligible
  objectives.

## 2. The queue

| State | Meaning | Who moves it |
| --- | --- | --- |
| `queued` | persisted, not yet claimed | autonomy pass → `acknowledged` |
| `acknowledged` | receipt recorded | autonomy pass → submits to the engine → `working` |
| `working` | task id bound | autonomy pass reconciles from the task row |
| `completed` | terminal, evidence attached | NEXUS `complete` |
| `failed` | terminal, error attached | NEXUS `fail` (non-retryable) |
| `dead_letter` | attempt limit reached | NEXUS `fail` after `maxAttempts` |
| `blocked` | reserved for a channel-level block; no automatic path invents it | — |

- **Retry**: a retryable failure increments `attempts` and returns to `queued`. Default limit 3.
- **Dead-letter**: at the limit the message stops and a **high-severity finding** appears in the
  scheduler tick, so it cannot rot silently. Requeueing is an owner decision.
- **Duplicate execution protection**: the task is submitted with `idempotencyKey = "message:" + id`.
  A crash after the claim but before the binding re-submits the same key; the engine returns the
  original task. The E2E test asserts one message and one task after a restart.
- **Persistence**: `habitat_ax_messages` (migration 0006), compare-and-swap on every update.

## 3. What may run without an owner

`autonomousPolicy(objective)` allows a tick to start and dispatch only when **all** of these hold:

1. status is `planned` or `authorized`;
2. `approval.required` is false and no step declares `requiresApproval`;
3. plan risk is `low`;
4. no permission contains `production`, `deploy`, `publish`, `purchase`, `refund`,
   `external_message`, `credential`, `destructive`, `device_action` or `account`;
5. every named adapter exists in the read-only allowlist.

| Class | Examples | Behaviour |
| --- | --- | --- |
| Autonomous | read runtime health, inspect the repository, run a registered read-only check | starts, executes, settles, notifies |
| Approval required | production change, paid provider, publishing, external message, purchase/refund, permissions, consequential device action | parked in `awaiting_approval`/`planned`; autonomy skips it; only a paired owner device can authorize |
| Prohibited without separate authorization | credential disclosure, destructive data operations, unauthorised access | not represented by any adapter; the allowlist refuses it |

**A model cannot override this.** The policy reads the persisted plan and the adapter allowlist, not
the model's prose. A plan that asks for `production.deploy` is skipped even if `risk` claims `low`,
because the permission check runs independently of risk.

## 4. Budget

- A reservation is written **before** the run exists, keyed by `objective:<id>`, so a retry or two
  concurrent dispatches reserve once.
- The reservation is the smaller of the plan estimate and the remaining budget.
- Settlement replaces the reservation with the actual cost; budget exhaustion blocks the objective
  and records a `budget.exhausted` security event.
- Stale reservations are reconciled on the tick, and only freed when no live run exists.
- Known residual: a crash between a paid model response and its persistence can under-report one
  call; the true ceiling is `budget + one call`.

## 5. Recovery

| Crash point | What survives | What the next tick does |
| --- | --- | --- |
| after message persisted, before claim | message `queued` | claims it |
| after claim, before task id | message `acknowledged` | re-submits the same deterministic key |
| after task id, before execution | message `working` + task `queued` | NEXUS tick executes the task |
| after execution, before message completion | task `done` | completes the message from task evidence |
| after objective reservation, before run | reservation | links or releases it |
| while a worker holds a claim | fence + lease | lease expiry requeues; fenced writes refuse stale workers |
| two ticks at once | scheduler lease | the loser returns `tick_overlap` and changes nothing |

## 6. What is *not* autonomous

- Nothing approves itself. `POST …/authorize` requires a verified paired owner device; the Ax
  command token is refused before any device check (`403 command_token_cannot_approve`).
- Nothing completes an objective. Autonomy dispatches and records evidence; acceptance checks
  (`verify` → `complete`) remain explicit.
- No side-effecting adapter exists. `SIDE_EFFECTING_ADAPTERS_ENABLED` is false and the mount refuses
  a side-effecting adapter.
- No paid provider was called in this mission; the E2E planner is a fixture.
- A Render Free web service **sleeps**. Autonomy only happens when something triggers a tick: the
  cron executor, `NEXUS_RUNTIME_ENABLED=true` while awake, or an owner/scheduler call. See
  `docs/RENDER_MISSION_14_READINESS.md`.

## 7. Operating it

```sh
# One tick: recovery + message drain + eligible objectives, under the lease.
curl -sS -X POST "$BASE/ax/command/scheduler/tick" \
  -H "Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN" \
  -H 'content-type: application/json' -d '{"trigger":"manual"}'

# Channel state and backlog.
curl -sS "$BASE/ax/nexus/channel" -H "x-nexus-token: $AX_NEXUS_TOKEN"
curl -sS "$BASE/ax/nexus/inbox"  -H "x-nexus-token: $AX_NEXUS_TOKEN"
```

The tick report carries `autonomy.messages` (`submitted`, `completed`, `failed`, `deadLettered`,
`stillWorking`) and `autonomy.objectives.advanced[]`. A failed pass is reported as a finding; it is
never reported as success.
