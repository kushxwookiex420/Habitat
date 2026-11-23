# NEXUS autonomous completion — Mission 01

Date: 2026-11-21. Branch reviewed: `ax-nexus/revision-4.6-nexus-mainline-integration` @ `448168b`
(PR #93, draft, base `main` @ `261eaf7`).

This document is a review and a plan. It is **not** evidence that Habitat runs autonomously. Nothing
was deployed, merged, purchased or enabled. Every claim below says which command, test or HTTP probe
produced it.

---

## 0. Evidence ledger

| Claim | Evidence |
| --- | --- |
| `main` is live at `261eaf7` with the `/ax/command` routes mounted | `GET /health` → 200; `GET /ax/command/tasks` → 401; `GET /diagnostics` → 404 (4.5-only route) |
| The full branch suite passes | `npm test` → 401/401, exit 0 (before this mission's fix); `npm run check` exit 0 |
| Owner actions fail closed without an owner device | reproduced, then fixed; regression test now passes (34/34 across three files) |
| The worker can execute a real task end to end | `tests/nexus-habitat-integration.test.mjs` 10/10 over SQLite behind the D1 HTTP shape |
| The live database was not touched | no D1/Cloudflare credential exists in this environment; no SQL was issued |
| 24/7 execution exists | **It does not.** No tick entrypoint, no scheduler, and the in-process timer dies with the process |

---

## 1. PR #93 review

### 1.1 Verified good (each item names the proof)

| Review item | Finding | Proof |
| --- | --- | --- |
| Owner-device authentication | Every owner action requires `x-owner-device-id` **and** `x-owner-device-token`, verified against the device repository (never the task repository). The actor recorded is `owner:<verified id>`, never the body. Missing verifier → 503 | `tests/command-routes.test.mjs` (owner_required 401, owner_invalid 401, not_owner 403) |
| Approval protection | `approve`/`deny` require the same proof; a request-body `by` is ignored; a paired non-owner gets 403 and nothing is written | same suite, "manual close-out without a valid owner device is rejected" |
| Task leases | Claim sets `claimedBy`, `leaseUntil`, `fence` in one conditional `UPDATE … RETURNING`; lease renewal is fenced | `tests/nexus-runtime.test.mjs`, `nexus-runtime-sqlite.test.mjs` |
| Fencing | Completion and failure are `UPDATE … WHERE status='working' AND json_extract(fence) IS ? AND json_extract(claimedBy) IS ? RETURNING`. A stale worker writes nothing and reports `stale_claim` | `tests/nexus-fencing-guards.test.mjs`, `nexus-repository-sql-sqlite.test.mjs` |
| Recovery | Expired lease → requeue with `attempts+1`; takeover before failing exhausted work is atomic; two recoverers cannot both act | `tests/nexus-runtime.test.mjs` |
| Retry limits | Attempt ceiling 3; only expiry retries; an adapter failure is terminal; `engine.retry` refuses past the ceiling | engine tests |
| Honest execution | Completion requires non-empty evidence and a summary; unknown adapter → `No adapter registered for "<name>"` and `failed`; no built-in echo adapters | `tests/nexus-mainline-integration.test.mjs` test 6 |
| Single D1 identity | One `d1DatabaseEndpoint()` shared by API and worker; a second database id in the env is never contacted; no token in any URL | `tests/nexus-mainline-integration.test.mjs` tests 1–4 |
| `habitat_tasks` untouched | The only occurrence of `habitat_tasks` in the command path is a comment. No SQL statement references it | `grep -n habitat_tasks nexus-*.mjs command-routes.mjs d1-command-task-repository.mjs` → one comment |
| Existing device routes still work | The ported integration test pairs a device and posts a heartbeat through the real bridge | `tests/nexus-habitat-integration.test.mjs` test 12 |

### 1.2 Defects found

**D-1 — Medium — FIXED in this branch (commit `fix(commands)`).**
With a **valid** device token but no `HABITAT_OWNER_DEVICE_ID` / `_IDS` configured,
`authorizeOwnerAction` answered `403 not_owner` ("this device is not the configured owner") instead of
`503 owner_unconfigured`. It failed closed — nothing was written — but it reports a configuration
error as an authorization decision, so an operator chasing the 403 would never find the missing
variable. Reproduced against the real module before the fix:

```
status: 403 body: {"ok":false,"code":"not_owner","error":"This device is not the configured owner…"}
task status after: working
```

`nexus-runtime.mjs` already behaved correctly (`503 owner_unconfigured`), so the two owner paths
disagreed. Fixed in `command-routes.mjs` and pinned by
`tests/command-routes.test.mjs` → "a verified device with no configured owner is a 503
misconfiguration, not a 403 decision".

**D-2 — Low/Medium — FIXED (documentation).**
`docs/NEXUS_MAINLINE_INTEGRATION.md` understated D1 write cost: `tick()` writes **two** heartbeat
rows when idle and **three** when executing, so at `pollMs=5000` an idle worker writes ≈34,600
rows/day — roughly a third of D1 Free's 100,000 rows-written/day before doing any work. Corrected in
the doc; throttling is roadmap R-2.

**D-3 — Medium — OPEN. At-least-once execution.**
If the process dies *after* an adapter performs a side effect but *before* the fenced completion
commits, the lease expires and the task is retried. For today's read-only adapters that is harmless.
The moment an adapter enqueues a real device action or publishes something, a retry is a duplicate
action. Required before any side-effecting adapter: per-task idempotency keys handed to the adapter,
or an `atMostOnce` adapter class that fails closed instead of retrying.

**D-4 — Low — OPEN. Unbounded heartbeat rows.**
`workerId` is `nexus-<8 hex>` per construction, and the heartbeat statement is an upsert keyed by
`worker_id`. Every boot inserts a new row and nothing ever deletes one. On a service that restarts
often this grows forever. Needs retention (`DELETE FROM habitat_nexus_workers WHERE heartbeat_at < ?`)
housekeeping (R-2).

**D-5 — Low — OPEN. Worker knobs are not configurable.**
`pollMs` (5 s), `leaseMs` (5 min), `adapterTimeoutMs` (2 min), `maxAttempts` (3) are constructor
defaults with no env binding. A 24/7 deployment needs at least `pollMs` and `maxAttempts` tunable
without a code change.

**D-6 — Low — OPEN. No durable audit trail on `main`.**
The `audit` hook exists but `main`'s device store has no `audit()` method, so PR #93 passes none.
Approvals are recorded inside each task's `history`, which is adequate for the task and inadequate
for a security log.

**D-7 — Info — no change needed.** `/device/command/*` uses the same device-auth convention as the
rest of the bridge (`?deviceId=` or body `deviceId` + `Authorization: Bearer <device token>`,
compared against `verifyDeviceToken`). Confirmed by reading `requireDevice` in
`device-command-bridge.mjs`; no second auth scheme was introduced.

**D-8 — Low — OPEN. No change feed for Ax.**
`GET /ax/command/tasks?status=&limit=` returns up to 200 rows sorted by `updated_at DESC`. There is
no cursor/`since` filter and no event log, so Ax cannot reliably "give me everything that changed
since I last looked" without re-reading and diffing.

**D-9 — Info — accepted surface.** When the worker mounts, `/nexus/runtime` and
`/device/command/*` become reachable on the public service. They are token-gated and there is no
rate limiting; a decision to add one is tracked at R-5.

### 1.3 Compatibility with the existing task system

- `habitat_tasks`, `/tasks`, `/tasks/:id/delegate`, dispatch leases and recovery are not imported or
  called by any command/NEXUS module.
- New tables created by this branch: `habitat_command_tasks` (already `main`'s, `IF NOT EXISTS`) and
  `habitat_nexus_workers` (`IF NOT EXISTS`). No `ALTER`, no `DROP`, no rename, no merge.
- `tests/device-command-bridge.test.mjs` and the rest of `main`'s suite pass unchanged on this
  branch (401/401).

### 1.4 Missing production requirements

1. A **one-shot tick entrypoint** so execution can be driven by a scheduler instead of a timer
   (R-1). Without it, "24/7" is impossible on any host that sleeps.
2. **Heartbeat throttling + worker retention** (R-2).
3. **Worker configuration from env** (R-3).
4. **Idempotent or at-most-once adapters** before any side-effecting adapter ships (R-4).
5. A **change feed** for Ax (R-6).
6. **Durable audit** (R-7).
7. **An adapter that performs real work** — the current set is inspection only.

---

## 2. Security risks and required fixes

| # | Risk | Severity | Required fix | Status |
| --- | --- | --- | --- | --- |
| S-1 | Ax token could self-approve / self-complete | High | Owner device proof on every owner action | Done (PR #93) |
| S-2 | Duplicate execution of a side effect after a crash | High (future adapters) | Idempotency key per task passed to the adapter; `atMostOnce` class | Open — R-4, blocks phone-control adapters |
| S-3 | Missing owner config reported as 403 | Medium | 503 `owner_unconfigured` | Done (this branch) |
| S-4 | Unbounded heartbeat table growth | Low | Retention job | Open — R-2 |
| S-5 | No durable audit of approvals/denials | Medium | `habitat_nexus_audit` table + write on decision | Open — R-7 |
| S-6 | Public `/nexus/*`, `/device/command/*` without rate limiting | Low | Per-token rate limit / WAF rule | Open — R-5 |
| S-7 | Worker can be silently off while tasks queue | Medium | `/health` + `/nexus/runtime` + a stale-queue alarm | Partial (reporting exists; no alarm) — R-8 |
| S-8 | D1 credential has full database scope | Medium | Accept for now; a scoped D1 token per service is not offered by Cloudflare today — keep the token out of the repo and rotate on suspected exposure | Accepted |
| S-9 | Secrets in logs | Low | No code path echoes a token; `/diagnostics` is 4.5-only and absent here | Verified by grep for token variables in log/JSON calls |

---

## 3. 24/7 execution architecture and real costs

### 3.1 Why the current design cannot satisfy the requirement

The worker is `setInterval` inside the web process. On Render Free the process is stopped after 15
minutes without **inbound** traffic; a stopped process runs no timers. A queued task therefore waits
indefinitely, and "NEXUS operates independently of the phone" is false the moment the phone stops
polling. Durability is already correct (D1 rows, leases, bounded retries) — what is missing is an
**external trigger**.

### 3.2 Requirement → mechanism

| Requirement | Mechanism |
| --- | --- |
| Independent of the phone | scheduler-owned trigger (cron), not phone traffic |
| Survives restarts | D1 is the queue; nothing lives in memory |
| Resumes after a crash | existing lease expiry + bounded retry (already implemented) |
| Persistent queue + history | `habitat_command_tasks` rows + `history`/`attemptHistory` |
| Heartbeats + health | `habitat_nexus_workers` + `/nexus/runtime` (throttle first, R-2) |
| Automatic recovery | `recoverExpired()` each tick (already implemented) |
| No dependence on Free staying awake | external cron or a paid always-on process |

### 3.3 Options, with real prices and limits (checked 2026-11-21)

| # | Architecture | Monthly cost | Limits that matter | Fits filesystem adapters? |
| --- | --- | --- | --- | --- |
| 0 | Status quo: Free web service + in-process timer | $0 | spins down after 15 min idle, ~1 min wake, 750 instance-hours/workspace/month | yes | **fails requirement** |
| 1 | Free web service + external scheduler calling an authenticated tick endpoint | $0 (+ scheduler) | same 750 h cap; every ping is inbound traffic, so a ≤15-min interval keeps it awake and spends the whole cap; ~1 min cold start per wake | yes |
| 2 | **Render Cron Job** running `node scripts/nexus-tick.mjs` | **$1/mo minimum** per cron service; otherwise prorated by the second at ~$0.00016/min on 512 MB | no free instances for cron; a run is stopped after 12 h; each run is a fresh process | yes — the repo is checked out for the run |
| 3 | Render Background Worker (`node scripts/nexus-worker.mjs`) | **$7/mo** (0.5 CPU / 512 MB); paid instances run continuously | no free tier for background workers; no HTTP port | yes |
| 4 | Fly.io machine `shared-cpu-1x` 256 MB | **$2.19/mo** + volume $0.15/GB/mo; stopped machine $0.15/GB/mo rootfs | you own the deploy and the supervisor | yes, with a volume for the checkout |
| 5 | Cloudflare Worker + Cron Trigger + D1 binding | **$0** on Workers Free / **$5/mo** Workers Paid | Free: 100k requests/day, **10 ms CPU per invocation** (HTTP and cron); D1 Free: 5M rows read/day, 100k rows written/day, 500 MB per database. Paid: 30 s default CPU, 15 min CPU for ≥1 h cron intervals; D1 Paid 50M writes/month | **no** — no filesystem; adapters would need R2/GitHub API |
| 6 | GitHub Actions scheduled workflow as the executor | $0 for standard runners in a public repo | shortest interval 5 min; documented delays and dropped runs under load; schedules in public repos are disabled after 60 days without repo activity | yes (it checks out the repo) |
| 7 | Railway Free / Hobby | $0 with $1 monthly usage credits, services wake on request; Hobby $5 minimum | same wake-on-request model as Render Free | yes |

Sources: `render.com/pricing`, `render.com/docs/cronjobs` ($1/mo minimum, 12 h cap),
`render.com/docs/background-workers`, `developers.cloudflare.com/workers/platform/pricing` and
`.../limits`, `developers.cloudflare.com/workers/configuration/cron-triggers`,
`fly.io/pricing` (`shared-cpu-1x` 256 MB $2.19), `docs.github.com` workflow syntax +
`events-that-trigger-workflows` (5-minute floor, 60-day disable), `railway.com/pricing`.

### 3.4 Recommendation

**Primary: Render Cron Job (#2), $1/month.** It is the cheapest option that removes the sleep
dependency entirely, keeps the existing Node + filesystem adapters, needs no new provider account,
and uses D1 as the only state. A 5-minute schedule with a 20-second tick costs far less than the $1
floor. This is the smallest reliable step from today's state.

**If sub-minute latency or a continuously warm worker is required: Render Background Worker (#3),
$7/month**, running the same modules in a loop with no HTTP surface.

**$0 interim: (#1) with a 10-minute external ping** to an authenticated `POST /nexus/tick`. Accept
two explicit failure modes: the 750-hour cap is consumed almost entirely, and the service can be
restarted or suspended at any time. Do not call it production.

**Not recommended now: (#5) Cloudflare Workers.** It is the best long-term serverless shape (native
D1, free cron), but the free plan's 10 ms CPU per invocation and the loss of filesystem access would
force a rewrite of every adapter. Revisit after the adapter layer is abstracted (P3).

**Free fallback only: (#6) GitHub Actions.** The 5-minute floor, documented dropped runs and the
60-day inactivity disable make it a monitor of last resort, not the scheduler of record.

### 3.5 Code required before any of this runs (not done in this mission)

1. `scripts/nexus-tick.mjs` — one-shot: build repository + query + engine + adapters from env, run
   **one** `worker.tick()`, print a JSON summary, exit non-zero if the tick threw.
2. `POST /nexus/tick` on the web service for option #1 — Ax-token or a separate trigger token,
   single-flight in the process, refuses if a tick is already running.
3. Heartbeat throttle + `habitat_nexus_workers` retention (R-2).
4. Env binding for `NEXUS_POLL_MS`, `NEXUS_LEASE_MS`, `NEXUS_MAX_ATTEMPTS` (R-3).

---

## 4. AX ↔ NEXUS communication

### 4.1 What already exists (PR #93)

| Direction | Endpoint | Auth | State |
| --- | --- | --- | --- |
| Ax → NEXUS submit | `POST /ax/command/tasks` (`objective`, `role`, `adapter`, `idempotencyKey`) | Ax bridge token | exists |
| NEXUS → Ax acknowledgement + id | response `201 { ok, task: { id, status } }`; `replayed: true` on a duplicate idempotency key | — | exists |
| Ax → NEXUS progress/results | `GET /ax/command/tasks/:id` and `GET /ax/command/tasks?status=` | Ax bridge token | exists (no cursor) |
| NEXUS → Ax failures | task `status: "failed"`, `error`, `attemptHistory` | — | exists |
| NEXUS → Ax approval request | `POST …/approval` (Ax) then `GET /device/command/approvals` (owner phone) | device proof | exists |
| Shared state + evidence | one `habitat_command_tasks` row; `result.summary`, `result.evidence[]`, `history` | — | exists |
| Execution heartbeat | `GET /nexus/runtime` | Ax bridge token | exists (4.6) |

### 4.2 Gaps to close before "Ax is connected"

1. **No round-trip has ever been performed.** There is no authenticated call from any Ax surface to
   the live service. Until the sequence in §4.4 succeeds against the deployed service, the correct
   statement is: *not connected*.
2. Ax and NEXUS share one long-lived `HABITAT_AX_BRIDGE_TOKEN`. A separate **command-scoped token**
   (`HABITAT_AX_COMMAND_TOKEN`) so a leaked chat credential cannot revoke devices or read
   diagnostics.
3. **No change feed.** `GET /ax/command/events?since=<iso>&cursor=` over a single append-only event
   stream (`task.created`, `task.claimed`, `task.progress`, `task.approval_requested`,
   `task.completed`, `task.failed`, `task.cancelled`) so Ax can report progress without polling
   every row.
4. **No Ax presence marker.** A `GET /ax/command/presence` that reports the most recent successful
   Ax call, so NEXUS can say "Ax last reached us at …" instead of assuming it is attached.
5. **No response envelope version.** Add `schemaVersion: 1` to every `/ax/command` response so the
   two sides can evolve without guessing.

### 4.3 Message contract (proposed, additive)

```
POST /ax/command/tasks
  { objective, role?, adapter?, idempotencyKey }
  → 201 { schemaVersion: 1, ok: true, replayed: false,
          task: { id, status: "queued", adapter, createdAt } }

GET  /ax/command/tasks/:id
  → 200 { schemaVersion: 1, ok: true, task: {
            id, status, attempts, objective,
            result: { summary, evidence[], decisions[] } | null,
            error: string | null, history[] } }

GET  /ax/command/events?since=2026-11-21T23:00:00Z
  → 200 { schemaVersion: 1, ok: true, events: [{ seq, at, taskId, type, status, detail }],
          nextCursor }

POST /ax/command/tasks/:id/approval    (Ax asks the owner)
POST /device/command/tasks/:id/approval (owner phone decides: { approved: boolean })
```

Rules: Ax never approves its own task; the owner device is the only approver; every failure carries a
machine-readable `code` (`adapter_not_allowed`, `claim_required`, `stale_claim`, `attempt_limit_reached`,
`owner_required`, `owner_unconfigured`, `not_owner`).

### 4.4 Round-trip acceptance test (NOT YET RUN — this is the definition of "connected")

```sh
BASE=https://habitat-1-szzd.onrender.com
AX="Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN"      # never echoed

curl -sS -X POST "$BASE/ax/command/tasks" -H "$AX" -H 'content-type: application/json' \
  -d '{"objective":"report runtime health","role":"ax","adapter":"runtime.health","idempotencyKey":"ax-rt-1"}'
# expect 201 + a task id

curl -sS "$BASE/ax/command/tasks/<id>" -H "$AX"
# expect status queued → (after a tick) done with result.evidence starting "runtime:"
```

Pass criteria: the id returns from submit, the same id is readable afterwards, the status transitions
without any phone involved, and `result.evidence` contains runtime-obtained text. Anything less is
"submitted, not executed".

---

## 5. Prioritized roadmap

Priorities: **P0** = required for any autonomous operation; **P1** = required for safe real work;
**P2** = operability; **P3** = capability. Every task is independently testable.

> Mission 02 update: R-1 (`scripts/nexus-tick.mjs`), R-2 (heartbeat throttle + retention) and the
> detection half of R-8 (queue health, stale alarm, honest states) are implemented and tested. See
> `docs/NEXUS_AUTONOMOUS_EXECUTION.md`. The cron service itself is still a specification
> (`docs/NEXUS_CRON_DEPLOYMENT.md`), so nothing runs on a schedule yet.

### P0 — make it run and stay running

| ID | Task | Test that proves it | Files |
| --- | --- | --- | --- |
| R-1 | One-shot tick entrypoint `nexus-tick.mjs` | run it twice against SQLite; second is a no-op; a claimed task reaches `done` | `scripts/nexus-tick.mjs`, `tests/nexus-tick.test.mjs` |
| R-2 | Heartbeat throttle (state change or ≥30 s) + worker-row retention | unit test: N ticks ⇒ bounded heartbeat writes; retention deletes old rows | `nexus-runtime.mjs`, tests |
| R-3 | Env-bound worker knobs (`NEXUS_POLL_MS`, `NEXUS_LEASE_MS`, `NEXUS_MAX_ATTEMPTS`) with validation | config test: bad values throw at boot | `nexus-runtime.mjs`, `device-command-bridge.mjs` |
| R-8 | Stale-queue alarm: `/health` reports `nexus.queue.oldestQueuedAgeSeconds`; a workflow alerts past a threshold | boot test reads the field | `server.mjs`, `.github/workflows/` |

### P1 — make execution safe

| ID | Task | Test |
| --- | --- | --- |
| R-4 | Idempotency for adapters: `task.idempotencyKey` passed to adapters; `atMostOnce` class that fails instead of retrying | fencing test with a simulated crash between side effect and completion |
| R-7 | Durable audit table `habitat_nexus_audit` written on every approval/denial/cancel | repository test |
| S-2 | Document and enforce that only read-only adapters may be registered until R-4 lands | registration test rejects a mutating adapter |

### P2 — operability and Ax integration

| ID | Task | Test |
| --- | --- | --- |
| R-6 | `GET /ax/command/events` change feed + `schemaVersion` on all `/ax/command` responses | route tests with cursor paging |
| R-9 | Command-scoped Ax token so chat credentials cannot touch devices | auth test: command token rejected on device routes |
| R-10 | `GET /ax/command/presence` (last successful Ax call) | route test |
| R-11 | Dashboard: a read-only `/nexus/status` page (queue depth, oldest queued, last worker heartbeat, recent failures) | render test with fixture rows |

### P3 — capability

| ID | Task |
| --- | --- |
| R-12 | `android.command` adapter: enqueue through the existing device command queue, poll the result, report the phone's own evidence (blocked by R-4) |
| R-13 | Research adapter (web search / fetch) with source URLs in evidence |
| R-14 | Repo change automation: GitHub branch + PR creation, never a push to `main` |
| R-15 | Backup/restore drill for D1 rows the system depends on |
| R-16 | Adapter abstraction so the engine can run on Cloudflare Workers (no filesystem) |

---

## 6. First safe implementation tasks

Ordered. Each one is small, testable, and reversible. None touches production data.

**Task 1 — `scripts/nexus-tick.mjs` (R-1).**
Why first: without it nothing can execute on a schedule.
Files: `scripts/nexus-tick.mjs` (new), `tests/nexus-tick.test.mjs` (new), `package.json` (check entry).
Behaviour: read `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN`,
`NEXUS_MAX_ATTEMPTS`; build `createD1CommandTaskRepository` + `createD1Query` + engine +
`buildReadOnlyNexusAdapters`; call `worker.tick()` exactly once; print
`{"claimed":n,"completed":n,"failed":n,"recovered":n}`; exit 1 on a thrown tick. No HTTP, no routes.
Verify: `node --test tests/nexus-tick.test.mjs && node --check scripts/nexus-tick.mjs`.

**Task 2 — heartbeat throttle + retention (R-2).**
Files: `nexus-runtime.mjs`, `tests/nexus-runtime.test.mjs`.
Behaviour: write `polling` only when `lastHeartbeat` is older than `heartbeatMs` (default 30 000) or
the state changed; add `pruneWorkers(olderThanDays = 7)` called once per tick (bounded `DELETE`).
Verify: a new test asserting ≤2 writes over 10 rapid ticks and that stale rows are removed.

**Task 3 — the scheduler (deployment, needs approval).**
Render Cron Job, command `node scripts/nexus-tick.mjs`, schedule `*/5 * * * *`, same env vars as the
web service plus `NEXUS_MAX_ATTEMPTS=3`. Requires the owner to create it in the dashboard; **$1/mo
minimum**. Do not create it automatically.

---

## 7. Exact approvals and commands for each remaining step

| Step | Command / action | Approval needed |
| --- | --- | --- |
| Land R-1 and R-2 | `git push origin ax-nexus/revision-4.6-nexus-mainline-integration`, review PR #93 | none (no deploy) |
| Merge PR #93 | merge button after review | **owner** — and only after the live checks in `docs/NEXUS_MAINLINE_INTEGRATION.md` |
| Create the table | one authenticated `GET /ax/command/tasks` with the Ax token, **or** run `migrations/0002_habitat_command_tasks.sql` once | **owner** |
| Set `HABITAT_OWNER_DEVICE_IDS` | Render dashboard → `Habitat-1` → Environment | **owner** |
| Enable the worker | set `NEXUS_RUNTIME_ENABLED=true`; then `curl -sS $BASE/health` and `curl -sS $BASE/nexus/runtime -H "$AX"` | **owner** |
| Create the Render Cron Job | dashboard → New → Cron Job → `node scripts/nexus-tick.mjs` → `*/5 * * * *`; **$1/mo** | **owner (spend)** |
| Run the Ax round-trip | the two curls in §4.4 | **owner** provides the token to the Ax surface; it is never pasted into this chat |
| Any side-effecting adapter | must wait for R-4 | **owner + design review** |

### Standing rules this mission respected

No production data was read or written; no secret was printed, echoed or committed; no database
operation was issued; no deployment, merge, purchase or external publish was performed; every change
runs against tests; and no task is described as complete on the strength of a plan.
