# NEXUS Mission 17 — a functional, evidence-driven work cycle

Branch: `ax-nexus/revision-4.6-nexus-mainline-integration` (PR #93, draft).
Status: **implemented and locally acceptance-tested. Not deployed. Not enabled.**
No model was called, no D1 database was touched, no Render service was changed and no Android
device was involved. Evidence: `release/mission-17-nexus-acceptance.json`; tests:
`tests/ax-work-cycle.test.mjs` (9) and the new autonomous bridge test in `tests/ax-nexus-e2e.test.mjs`.

---

## 1. What was inspected

| Component | File | State found |
| --- | --- | --- |
| Durable objective lifecycle | `ax-objectives.mjs` | complete: CAS persistence, transition table, approval, budget reservations, evidence checks |
| Adapter orchestrator | `ax-orchestrator.mjs` | complete for one kind of work: model plan -> read-only adapter tasks |
| Objective dispatch | `ax-objective-dispatch.mjs` | wires an objective to one Ax run; never completes the objective |
| Scheduler + autonomy | `ax-scheduler.mjs`, `device-command-bridge.mjs` | durable tick lease, recovery, message drain, adapter-plan dispatch |
| Specialist agents | `ax-agents.mjs` | seven roles with real handlers (research, engineering, security, operations, memory, content, device) |
| Real transports | `ax-agent-transports.mjs` | repository research with citations; allowlisted `node --check`/test commands; read-only |
| Memory | `ax-memory-context.mjs` | recall + verified-run write-back |
| Ax <-> NEXUS channel | `ax-message-channel.mjs`, `command-routes.mjs` | durable state machine, correlation ids, both credentials |
| Audit / recovery | `ax-security-events.mjs`, `ax-recovery.mjs` | append-only audit; allowlisted repairs |
| Agent HTTP surface | `command-routes.mjs` | `/ax/command/agents` exposed delegation as a manual call only |

Deployed runtime probe (read-only, no credential, 2026-11-22): the live origin
`https://habitat-1-szzd.onrender.com` now answers `/health` with `version: 0.5.0` and
`nexus: { configured: false, reason: "disabled_by_config" }`, and `/ax/command/openapi.json` returns
200. The Mission 14–16 code is therefore deployed, but the NEXUS executor is switched off, so **no
mission can run on the live service and nothing in this mission exists there yet**.

## 2. The single most important blocker

The objective lifecycle could not execute specialist work. It could only dispatch *adapter tasks*
through the Ax run store, while the seven agents were reachable **only** through a manual
`POST /ax/command/agents/delegate` call. There was:

- no Director role and no Verification role;
- no code path from an objective to an agent, and no code path from an agent back into the
  objective's evidence store;
- no durable multi-step record, so no resume after a crash, no duplicate prevention and no
  per-mission audit;
- no completion rule beyond "a human assembled the pieces".

In other words, NEXUS could describe a multi-agent mission but could not complete one. Everything
below addresses that gap.

## 3. Phase 2 — the agent team

`AGENT_IDS` now has nine roles. Two are new and perform real work:

| Role | Real work | Dependency | Cannot |
| --- | --- | --- | --- |
| **Director** (new) | deterministic decomposition from objective text, criteria and mounted capabilities; returns an ordered plan | none | approve, publish, deploy, spend |
| **Verification** (new) | independently re-reads stored evidence against every acceptance criterion and returns checks | none | override, approve, complete an objective by itself |
| Research | repository transport: file, line, excerpt and sha256 digest per source | `AX_AGENT_LOCAL_ROOT` | web access, write |
| Engineering | inspect allowlisted files, run `node --check` / configured tests, report failing checks and a correction proposal | `AX_AGENT_LOCAL_ROOT` | write, deploy, shell |
| Security | audit registered adapters against the allowlist | none | read credentials, weaken policy |
| Operations | probe database, memory, providers, scheduler, sandbox, notifications, device bridge | diagnostics | deploy, database write |
| Memory | recall approved memory with citations; write back only a verified run | memory repository | promote unverified knowledge |
| Content / Device | draft only / device state only | — | publish, purchase, device shell |

`director` and `verification` are **never auto-routed** by keywords. A verification request must not
land on the agent that produced the work; the work cycle assigns both by role explicitly.

## 4. Phase 3 — the work cycle

`ax-work-cycle.mjs` implements the requested cycle against the existing services:

1. receive (or resume) a durable objective;
2. Director decomposes it into ordered steps, each naming one specialist;
3. the plan is persisted through `objectives.plan()` and every step keeps its own evidence id;
4. memory context is recalled before the first step;
5. each step runs through `agents.delegateAndReview()` — an agent result is only an input, and Ax's
   review can reject it;
6. step evidence is written **before** the next step starts; an operator stop or a wall-clock/deadline
   bound is checked between steps;
7. the objective moves `executing -> verifying`, and only the Verification agent's checks are fed to
   `objectives.verify()`;
8. `objectives.complete()` is called **only** when verification says every required criterion is met;
9. the verified result is written to memory and sent to Ax as a `result` message;
10. every outcome is reported as completed, interrupted, blocked or failed — never "probably done".

Safety properties enforced in code, not prompts:

- **Resume**: a step's evidence id is deterministic, so a restarted cycle reuses finished work.
- **Retries**: two attempts for `agent_timeout` / `agent_failed`, then the objective is interrupted
  (recoverable), not failed.
- **Duplicate prevention**: a durable lease is stored in the objective's checkpoint history and
  written with the same compare-and-swap as every other objective update; a concurrent cycle gets
  `work_cycle_busy`.
- **Capability honesty**: a missing research/engineering/operations capability blocks the objective
  with the missing name. Nothing is simulated.
- **Approval**: a plan that declares an approval step, or asks for a write/publish/deploy/purchase/
  credential/device permission, is refused before any agent runs and moved to `awaiting_approval`.
- **Budget**: the cycle makes no paid call. The existing per-objective reservation still governs the
  adapter path.
- **Audit**: the objective's own transition log records every edge; rejected agent results, stops
  and revocations also write security events when that service is mounted.

## 5. Phase 4 — connecting Ax, Habitat and NEXUS

- `POST /ax/command/objectives/:id/work` drives an objective through the cycle (Ax credential).
- `POST /ax/command/objectives/:id/work/stop` records a durable stop request.
- `POST /ax/command/agents/revoke` revokes agent execution for the process and audits it.
- The scheduler's autonomy pass now chooses the work cycle for an **agent-oriented plan** (every step
  has an `agent` and no `adapter`) and the existing dispatcher for adapter plans. The two never share
  a run, so a mission cannot be executed twice by two mechanisms.
- Progress, errors and the final result are delivered as messages on the durable channel with a
  stable correlation id (`cor_mission_<digest>`). Ax reads them with the existing thread route; the
  user does not copy anything between systems.
- No token is logged, stored in the objective, or returned. The message channel redacts
  credential-shaped text before persisting it.

## 6. Phase 5 — research and engineering reality

**Research** reads a bounded local repository snapshot (text files only, skipped build/vendor
directories), scores matches, and returns up to five sources as `path#Lline`, a five-line excerpt and
a sha256 digest with a retrieval timestamp. It reports low confidence and its limitations when it
finds nothing. It has **no web access**; a web transport remains an owner decision (credential and
provider).

**Engineering** reads only allowlisted paths (no symlinks, no hidden paths, no traversal), and runs
only the fixed commands configured at mount (`node --check` and named test files). It reports every
command's exit code, stdout/stderr tail and duration. A failing check produces a
`proposedCorrection` with `applied: false` and `requiresApproval: true`; the transport is read-only,
so **it cannot implement the fix**. A mission that hits a failing check fails with
`engineering_check_failed` and keeps the diagnosis. Writing code requires a separate, approval-gated
sandbox and is not claimed here.

## 7. Phase 6 — security and human control

| Control | Behaviour |
| --- | --- |
| Autonomous scope | read-only research, inspection, audit, probing; no deploy, publish, purchase, credential, destructive, account or device action |
| Approval gate | plan permissions and `requiresApproval` steps are checked before execution |
| Stop | `work/stop` or `cycle.stop()` prevents the next step; an in-flight agent finishes within its own timeout |
| Revoke | `agents/revoke` refuses new steps for the process and raises an audit event |
| Terminal action | the owner's existing `cancel` route remains the only way to close work permanently |
| Audit | objective transitions, checkpoints, security events, message timeline |

Residual limits, stated plainly: revocation is process-local (there is no durable agent-permission
store); a stop cannot abort a call already in flight; the objective record itself is not encrypted.

## 8. Phase 7 — acceptance evidence

`npm run readiness:nexus` runs both suites with the TAP reporter and writes
`release/mission-17-nexus-acceptance.json`. Local result: **all checks pass**.

| Proof | Test |
| --- | --- |
| receive and persist an objective | 1-2-3: objective persisted before work, Director plan |
| assign work to the correct agent | same test: `memory -> research -> engineering -> security -> verification` |
| research a real question with sources | same test: `README.md#Lline`, digest per item |
| identify a real code issue and propose a tested correction | 4: `node --check` fails on a real syntax error; proposal is not applied |
| resume an interrupted task | 5: engineering crashes, mission interrupts, resume reuses research evidence |
| reject unauthorized actions | 6: `publish.external` plan refused with zero delegations; approval step waits |
| preserve results across restarts | 7: new service and cycle over the same repository see the verified result |
| send a message through the authenticated bridge | 8: result thread persisted; `/ax/nexus/messages/notify` 401 without token; work route 401 |
| report failure honestly | 9: missing capability blocks with zero evidence; unmet criteria fail, never complete |
| complete a multi-agent objective end to end | 10 and the new bridge test: scheduler autonomy completes and verifies a mission |

Bridge-level proof (`tests/ax-nexus-e2e.test.mjs`): the real composition root, both credentials, the
D1-shaped store, the scheduler lease and the autonomy pass complete an agent-oriented objective with
no manual dispatch, and a later tick does not run it again.

## 9. Files changed

| File | Change |
| --- | --- |
| `ax-mission-plan.mjs` | new: deterministic capability-aware mission plan |
| `ax-work-cycle.mjs` | new: durable, leased, resumable agent work cycle |
| `ax-agents.mjs` | Director + Verification roles; context passing; scoped delegation budgets; empty-memory observation; engineering correction proposal |
| `command-routes.mjs` | `work`, `work/stop` and `agents/revoke` routes |
| `device-command-bridge.mjs` | mounts the work cycle; autonomy selects it for agent plans |
| `tests/ax-work-cycle.test.mjs` | new acceptance suite (9 tests) |
| `tests/ax-nexus-e2e.test.mjs` | new autonomous mission through the real bridge |
| `tests/ax-mission-10.test.mjs`, `tests/ax-openapi-contract.test.mjs`, `tests/command-routes.test.mjs` | deliberate contract counts (9 agents, 87 routes) |
| `scripts/nexus-readiness.mjs`, `package.json` | acceptance runner and scripts |
| `release/mission-17-nexus-acceptance.json` | generated evidence |

## 10. What is operational, disabled or blocked

**Operational in the repository (tested locally):** the work cycle, both new agents, all seven
existing agents, the scheduler branch, the three routes, the stop/revoke controls and the acceptance
runner.

**Deployment state:** the live service runs the Mission 14–16 surface with `NEXUS_RUNTIME_ENABLED`
off. Turning it on is an owner configuration change; this mission did not change it.

**Disabled by configuration:** research and engineering remain unavailable unless
`AX_AGENT_LOCAL_ROOT` names a bounded local checkout. In the deployed container that path must exist;
otherwise a mission that needs them blocks honestly.

**Blocked or not verified:** no web research provider; no code-writing agent; no model-backed
Director (quality of model planning is untested); no D1 acceptance run; no Render deployment; no
Android device; the full release gate (which needs the Android build) was not run. The live service
reports the NEXUS executor as `disabled_by_config`, so even the deployed Mission 16 surface cannot
execute work today.

## 11. Next concrete engineering task

Run the acceptance suite against **real D1** with `NEXUS_RUNTIME_ENABLED=true` and
`AX_AGENT_LOCAL_ROOT` pointing at the deployed checkout, then deploy commit
`release/mission-17-nexus-acceptance.json.commit` to Render and confirm that a scheduler tick
completes one mission against the live origin. After that: add an approval-gated write sandbox so the
Engineering agent can implement the correction it currently only proposes.

## 12. Owner actions (separate from the work above)

1. Deploy the mission commit to the Render service (no deploy has been performed here).
2. Set `AX_AGENT_LOCAL_ROOT` to the service's checkout path, and keep `NEXUS_RUNTIME_ENABLED=true`.
3. Trigger one scheduler tick and read `GET /ax/command/objectives?status=completed`.
4. Decide whether to fund a web-search provider for the Research agent.
5. Decide whether to approve a write-capable engineering sandbox; it is not enabled.
