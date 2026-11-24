# Nexus directive compliance — 2026-11-24

This maps the Owner's autonomous-execution directive to what the code actually does, with the evidence
that exists today and the gaps that remain. A clause is marked **implemented** only where a test or a
live response proves the behaviour; otherwise it is **partial** or **absent**.

## Lifecycle (§5 — receive, understand, plan, permissions, execute, test, verify, record, report)

| Step | Implementation | Evidence |
| --- | --- | --- |
| Receive | `POST /ax/command/tasks` (authenticated by the Ax bridge token) → `engine.submit` | `tests/command-routes.test.mjs` |
| Understand | objective validation (3–2000 chars), role resolution from `agent-roles.mjs` | `tests/universal-command-engine.test.mjs` |
| Plan | `POST /ax/command/tasks/:id/plan`, max 20 steps, per-step role and tool resolution | same suite |
| Permissions | `ax-approval-gate.mjs`; sensitive device commands require `approved: true` per command | `tests/ax-approval-gate.test.mjs`, `tests/ax-adversarial-auth.test.mjs` |
| Execute | `createNexusWorker` claims with an atomic fenced `UPDATE … RETURNING`, renews its lease, enforces an adapter timeout | `tests/nexus-runtime-sqlite.test.mjs`, `tests/nexus-fencing-guards.test.mjs` |
| Test / verify | a step result without `evidence` fails the task; `ax-work-cycle.mjs` never reports a mission completed unless `objectives.verify()` returns verified | `tests/ax-work-cycle.test.mjs` |
| Record | every step writes a deterministic evidence id before the next step starts; worker heartbeats, task records and status history persist in D1 | `tests/nexus-repository-sql-sqlite.test.mjs` |
| Report | `/system/status` (facts), `/ax/command/events` (cursor), message channel with `blocked` state | `tests/ax-diagnostics.test.mjs` |

"Never report success without evidence" is enforced in the executor, not just in prose:
`nexus-runtime.mjs` fails a task whose adapter result carries no evidence, and the work cycle refuses to
complete a mission whose verification does not pass.

## Autonomous operation (§3, §7)

**Prioritized queue — implemented in this change.** The queue had no priority at all: the claim
statement ordered by `updated_at` only, so an urgent repair waited behind every earlier task. Tasks now
carry a bounded `priority` (0–100, default 0) that is validated at submission, persisted in the record,
and honoured by the claim statement:

```sql
ORDER BY COALESCE(json_extract(record_json, '$.priority'), 0) DESC, updated_at ASC
```

Rows written before this change have no field and sort as 0, so nothing is stranded. Priority is an
ordering hint, not an authorization: the tests assert a priority-100 task still lands in `queued` with no
approvals and cannot skip a gate. Evidence: `tests/nexus-runtime-sqlite.test.mjs` (claim order across
five tasks, including a legacy row), `tests/universal-command-engine.test.mjs` (bounds and defaults),
`tests/command-routes.test.mjs` (the route carries the value and refuses 500).

**Blocked work does not stall the loop.** A failed task is failed and the worker continues polling; lease
expiry requeues up to `maxAttempts` and then marks the task exhausted with an explicit error
(`NEXUS_REQUEUE_SQL`, `NEXUS_SEIZE_SQL`, `tests/nexus-lifecycle.test.mjs`).

**Continuous monitoring.** `habitat-health-watch.yml`, `ax-improvement.mjs` and the capability registry
cover infrastructure and capability drift; `ax-scheduler.mjs` raises owner notifications for approvals and
high-priority items.

## Security and authorization (§6)

- Least privilege: the Nexus executor refuses anything but allowlisted read-only adapters
  (`assertReadOnlyAdapters`), and the D1 token is a scoped credential supplied by the environment.
- Secrets never appear in status: `/system/status` reports booleans only, and `secretsExposed: false` was
  observed live on staging. The new device audit selects named columns so a token hash cannot be printed.
- Production data is refused when a process is marked staging (`staging-guard.mjs`), and `/system/status`
  now states whether that guard was actually in force.
- Financial, publishing and destructive operations sit behind the approval gate; nothing in this change
  weakens it.

## Gaps (honest list)

1. **No push on execution failure.** `nexus-runtime.mjs` records the error on the task and increments its
   failure counter, but it does not emit a notification. Ax can discover a failure by reading
   `/ax/command/events` or `/system/status`; it is not told. Closing this needs a notification sink wired
   into `registerNexusRuntime` (a `notifyTerminalFailure` hook), which changes server wiring and should
   not be added untested.
2. **Nothing is executing.** Staging runs with `NEXUS_RUNTIME_ENABLED`, `HABITAT_MISSIONS_ENABLED` and
   `HABITAT_WORKFORCE_ENABLED` all off, and no model provider is configured, so every model-backed worker
   reports `unavailable`. The engine is proven, not running.
3. **Command round trip unverified.** No device command has been queued on staging; the Ax bridge token
   is not available in this workspace (see `docs/STAGING_AUDIT_2026-11-24.md` §7).
4. **Live-D1 CI credential rejected.** The repository secret now fails with Cloudflare
   `10000:Authentication error`, so database-backed acceptance cannot be re-run until it is rotated.
5. **No revenue, business or worker-discovery operation has ever run.** Nothing in this document claims
   otherwise; the directive's business clauses are unimplemented capability, not completed work.
6. **Priority is not yet set by any planner.** Ax can pass it; nothing derives it automatically from
   deadlines or impact. That is a policy decision, not a missing mechanism.
