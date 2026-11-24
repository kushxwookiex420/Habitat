# Staging readiness — durable workforce, attached and disabled

Date: 2026-11-24. Branch `staging/integration`. This report covers the workforce runtime attachment
only; it makes no claim about a deployed staging service, because none has been activated.

## Status in one line

The workforce is **configured-capable, attached, and disabled**: `server.mjs` builds it from the same
D1 binding as every other store, the scheduler can delegate to it inside the existing tick, and with
`HABITAT_WORKFORCE_ENABLED` unset it does nothing at all — not one query.

## State words

| Word | Where it comes from | Current value on this branch |
| --- | --- | --- |
| configured | account id + database id + token present | no (no deployment) |
| initialized | agents and in-flight assignments hydrated from the store | no |
| enabled | `HABITAT_WORKFORCE_ENABLED=true` | no |
| running | a scheduler step used intake or the runner since boot | no |
| verified | an independent verifier produced a stored `verified` result | no |

These are reported separately at `components.workforce` in `/system/status`, and as a single line in the
phone-readable report: `Workforce: DISABLED — configured=no, initialized=no, enabled=no, running=no,
verified=no`. A snapshot is in `docs/MISSION_LEDGER.md`.

## What was attached

- `server.mjs` creates `createWorkforceRuntime({ env: process.env })` before the Bridge and passes
  `workforceIntake` / `workforceRunner` into `registerDeviceCommandBridge`, which passes them to the one
  existing scheduler. There is no second scheduler and no new route.
- `ax-workforce-runtime.mjs` decides whether anything happens. Its flag is `HABITAT_WORKFORCE_ENABLED`,
  deliberately independent of `NEXUS_RUNTIME_ENABLED`; two separate authorizations are required to have
  an executor and coordinated improvement running.
- Startup order matters and is tested: hydrate first, then register default agents only if absent. A
  worker persisted as `unavailable` stays unavailable across a restart instead of being reset to
  `unknown` and retried against a provider already known to be down.

## Fail-safe matrix

| Condition | Observed behavior | Evidence |
| --- | --- | --- |
| flag off (default) | state `disabled`; zero queries; no store created; intake/run refuse `workforce_disabled` | runtime test; live server test |
| flag on, binding incomplete | state `unconfigured`; refuses `workforce_unconfigured`; no memory fallback | runtime test |
| migration 0010 absent | state `schema_missing`; runtime creates no tables; intake refuses `workforce_schema_missing` | runtime test asserts the database still has 0 tables |
| hydration throws (D1 timeout) | state `initialization_failed`; intake refuses `workforce_not_initialized`; counts 0 | runtime test with an injected read failure |
| executor/provider throws | retried (bounded, default 2), then `exhausted`; no result is recorded | runtime test: 1 retry, 0 results, 0 active |
| worker removed or unavailable | released as `orphaned` or skipped `agent_unavailable`; never executed | runner tests |
| no independent verifier | nothing is marked `verified`; the result is recorded unverified or skipped | runner tests |
| default adapters (no code executor) | implementer returns `partial` with a plan as evidence; verification cannot exist, so never `verified` | runtime test |

## Checks run on this branch

- `npm test`: **1089 pass, 0 fail** (includes 12 runtime tests, 1 real-server startup test, and the
  existing suite unchanged).
- `npm run check`: exit 0.
- `npm run migrations:check`: exit 0 (0001…0010 applied twice to in-memory SQLite).
- `npm run migrations:rollback`: 14/14, including 0010's tables and indexes dropped and recreated.
- `npm run workforce:demo`: restart between assignment and completion, 20/20 real tests, approval pending.
- Live disabled-mode start: `/health`, `/system/status`, `/workers`, `/capabilities`,
  `/continuity/status` all 200; `TASK_STORAGE: memory-only`; no `WORKFORCE_STATUS` line.

## Not done, and why

1. **0010 is not applied to staging.** The CI D1 verify workflow is preflight-only (`applied: []`), and
   applying is an owner-authorized write. Procedure: `docs/WORKFORCE_D1_STAGING_MIGRATION.md`.
2. **No staging service exists.** Render access and the paid plan are still unapproved blockers; until
   then "initialized from D1 in a deployment" is proven by tests, not by an environment.
3. **No activation anywhere.** `HABITAT_WORKFORCE_ENABLED` is unset everywhere and
   `NEXUS_RUNTIME_ENABLED=false`; no production migration, deploy, spend or publish happened.
4. **The default execution adapter is plan-only.** No code executor is attached to a deployment, so a
   real deployment can create and assign tasks, but its implementer can only propose a plan. Turning
   proposals into verified code changes needs a real executor, which is a separate, auditable decision.

## Acceptance path for the next test

1. Owner approves applying 0010 to staging; run the preflight, record a backup, apply, re-run preflight.
2. Restart staging with the flag still unset; confirm `/system/status` is identical except the new
   `workforce` section reporting `disabled`.
3. Owner approves activation in staging only; set `HABITAT_WORKFORCE_ENABLED=true`; confirm
   `initialized: true` and `counts.agents: 2`.
4. Trigger one scheduler tick; confirm `running: true`, `counts.approvalRequired >= 1`, and that the
   result is `verified` only if an independent verifier actually ran.
5. Restart; confirm `recoveredAssignments >= 1` and no duplicate active assignment for the same task.
6. Switch the flag off again; confirm intake and runner refuse and no further tasks appear.

Each step is reversible by unsetting the flag, and none of them requires merging to `main`.
