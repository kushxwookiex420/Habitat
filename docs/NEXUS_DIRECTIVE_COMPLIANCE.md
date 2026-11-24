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

## Failure escalation (§5 report, §7 notify Ax) — implemented this cycle

A terminal failure used to be recorded on the task row and nothing else. Ax could find it only by
polling. `ax-failure-escalation.mjs` now turns each terminal failure into one durable message on Ax's
own channel (`GET /ax/command/messages`), carrying the task id, objective, reason, retry count and
timestamp.

- **Duplicate prevention** is the channel's own idempotency: the key is `nexus-failure:<taskId>:<attempts>`,
  so a replayed escalation, a restarted process or a double call collapses onto one message. A task the
  owner retries and that fails again is a *new* attempt and is correctly reported again.
- **Retries** are bounded and only for transient codes (`message_store_unavailable`, `message_conflict`,
  `rate_limited`, a throwing sink). A permanent refusal such as `invalid_kind` is not repeated.
- **Sink failure cannot change execution.** `failTask` records the failure first; escalation is wrapped so
  a throw is logged and the task outcome is untouched. Tests cover a refusing sink, a throwing sink and a
  dead sink.
- **Wiring**: `registerNexusRuntime` accepts `escalate` and hands it to the worker; the device bridge
  passes an escalator bound to the process's single message channel.

Evidence: `tests/ax-failure-escalation.test.mjs` (10 cases) and `tests/nexus-failure-escalation.test.mjs`
(6 worker-level cases, including "no escalation when the failure transition was refused").

## Derived priority (§7 prioritized queue) — implemented this cycle

`ax-priority-policy.mjs` derives a suggested 0–100 priority from urgency, deadline, impact, dependent
work and blocked work. Weights: urgency 40, deadline 30, impact 20, fan-out 10, plus up to 15 for work
blocked behind the task, clamped to 100. An explicit owner priority always wins; the task records
`prioritySource` (`owner` | `derived`) and the reasons behind a derived value. A derived priority is a
hint only — it is tested not to change status or approvals.

**Wired to real plan data.** `signalsForPlanStep` maps what an Ax plan already carries onto policy
signals: `riskLevel` → urgency (same four levels, no second scale), `deadlineAt` → deadline pressure,
`valueCents` × `confidence` normalised against a $1,000 ceiling → impact, and plan position → dependents
(every later step depends on this one, so step 1 of 5 outranks step 5 of 5). The orchestrator schema now
accepts `priority`, `riskLevel`, `deadlineAt`, `valueCents`, `confidence` and `blockedCount` per step and
passes the derived signals to the engine, recording them on the step.

Evidence: `tests/ax-priority-policy.test.mjs` (10 cases incl. hostile signals and a representative-task
demo that runs the derived priorities through the real claim SQL and asserts the claimed order), engine
and route cases in `tests/universal-command-engine.test.mjs` and `tests/command-routes.test.mjs`.

## Gaps (honest list)

1. **Escalation is tested, not live.** The hook is wired and covered by tests, but staging runs
   `efcf65c`, which predates it. It becomes observable only after the next deployment and a real failure.
2. **Nothing is executing.** Staging runs with `NEXUS_RUNTIME_ENABLED`, `HABITAT_MISSIONS_ENABLED` and
   `HABITAT_WORKFORCE_ENABLED` all off, and no model provider is configured, so every model-backed worker
   reports `unavailable`. The engine is proven, not running.
3. **Command round trip unverified.** No device command has been queued on staging; the Ax bridge token
   is not available in this workspace (see `docs/STAGING_AUDIT_2026-11-24.md` §7).
4. **Live-D1 CI credential rejected.** The repository secret now fails with Cloudflare
   `10000:Authentication error`, so database-backed acceptance cannot be re-run until it is rotated.
5. **No revenue, business or worker-discovery operation has ever run.** Nothing in this document claims
   otherwise; the directive's business clauses are unimplemented capability, not completed work.
6. **Model planners do not fill the new plan fields yet.** The orchestrator accepts and forwards them,
   but the model prompt is not yet instructed to emit `riskLevel`/`deadlineAt`/`valueCents`, so a plan
   from the model still derives priority 0 until the prompt or the calling surface supplies them.
