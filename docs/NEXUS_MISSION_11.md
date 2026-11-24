# NEXUS Mission 11 — Operational breakthrough

Date: 2026-11-22
Branch: `ax-nexus/revision-4.6-nexus-mainline-integration`
PR: #93 (draft, not merged)
Starting commit: `deb4e7fcacab6bac9fd6c2813077ee412ed18435`

This document records what Mission 11 actually implemented, integrated, tested and did not test. It
does not turn a passing local check into a production claim.

## 1. Starting state and discrepancies found

The branch was at `deb4e7f` with a clean tracked tree. Migrations `0001`–`0004` were present; `0004`
had not been applied to any D1 database. Mission 10 artifacts existed and its suite passed, but the
following gaps were real:

| Mission 10 claim or assumption | Verified state at audit | Mission 11 effect |
| --- | --- | --- |
| Objectives coordinate work | Lifecycle existed, but no objective could spend against a limit | Accounting added to the objective record |
| Run dispatch is attributable | `newRun` had no immutable objective identity | `objectiveId` is now immutable; mismatches are refused |
| Recovery incidents are an audit trail | Incidents are operational, not security evidence | Separate append-only security log |
| Recovery can be triggered | Manual scan only | Durable scheduler with lease, heartbeats, missed-tick detection |
| Agents are distinct | Manifests existed; no real transports | Read-only repository research/engineering transports |
| Seven-tab control center | Ten tabs after Mission 10; no security or scheduler view | Eleven tabs, objective detail, scheduler card |
| Pairing fix is fixed | Compile-tested only | Debug APK validation package; physical validation still absent |
| Provider resilience | Policy existed; no per-objective enforcement | Reservation precedes dispatch; settlement is unique |

## 2. Architecture

- **Objective accounting** lives inside the objective record (`accounting.spentUsd`,
  `accounting.reservedUsd`, `accounting.executions[]`). Every execution has a deterministic id, a
  reservation, and at most one settlement. Writes use compare-and-swap with bounded retry.
- **Security events** are a separate append-only store. Each event is hash-chained with
  `sha256(prevHash + canonicalEvent)`. That makes edits detectable relative to an observed head; it
  is tamper-evident, **not tamper-proof**. No HTTP route writes, updates or deletes events.
- **Scheduler** is a single durable row guarded by a lease and a revision CAS. Overlap returns
  `tick_overlap`; a crashed tick is reclaimed only after lease expiry; scans are trigger-agnostic.
- **Agent transports** are local, read-only, and off unless `AX_AGENT_LOCAL_ROOT` is set. The
  engineering transport spawns allowlisted commands without a shell; it cannot deploy or mutate
  production.
- **Projects** are scoped by project id; an objective, approval or memory entry from one project
  cannot authorize work in another.

## 3. Files changed (Mission 11)

New: `ax-security-events.mjs`, `ax-security-event-repository.mjs`, `ax-scheduler.mjs`,
`ax-scheduler-repository.mjs`, `ax-agent-transports.mjs`, `ax-projects.mjs`,
`migrations/0005_ax_security_scheduler.sql`, `scripts/migration-check.mjs`,
`scripts/release-gate.mjs`, `scripts/ax-demo.mjs`, plus tests `ax-accounting`,
`ax-security-log`, `ax-scheduler`, `ax-agent-transports`, `ax-projects`, `ax-mission-11`,
`migrations`, this document and `ANDROID_DEVICE_VALIDATION.md`, `release/manifest.json`,
`release/demo-evidence.json`.

Changed: `ax-objectives.mjs`, `ax-orchestrator.mjs`, `command-routes.mjs`,
`device-command-bridge.mjs`, `ax-agents.mjs`, `control-center.mjs`,
`tests/control-center.test.mjs`, `package.json`.

## 4. Objective accounting — implemented, integrated, tested locally

- Budget limit on create; remaining budget reported.
- Reserve before dispatch; release when no run exists; settle exactly once; duplicate settlement is
  `execution_already_settled`.
- Failed accounting writes surface as errors and do not dispatch.
- Overspend is recorded truthfully and the objective is blocked.
- Control center shows limit, reserved, spent, remaining and each linked execution.
- Tests cover concurrent dispatch, repeated dispatch, release, settlement, overspend and recovery.

Not live: no production accounting data exists.

## 5. Security event log — implemented, integrated, tested locally

Events record category, severity, outcome, actor, device, objective/run/task, correlation id,
redacted evidence, sequence and hash. Sources include auth failures, owner authorization, pairing,
approval replay, forbidden agent actions, scheduler actions and provider budget exhaustion.

Integrity verification re-computes the chain and reports the first broken index. Retention is
bounded by the store policy; pagination is by sequence. Tests cover concurrent appends, replay of an
event id, tamper detection and proof that no update/delete method exists.

Not live: no D1 security events exist.

## 6. Scheduler and recovery — implemented, integrated, tested locally

Tick contract: acquire lease → heartbeat → scans (stuck objectives, expired approvals, expired
worker leases, incidents) → record result → release lease. Missed ticks are computed from the last
tick time and interval. Manual owner tick and external token tick use the same path. A crash leaves
an expiring lease, not a permanent lock.

Not tested: Render Cron or GitHub Actions actually invoking the deployment. No schedule was created.

## 7. Agents — implemented, integrated, tested locally

| Agent | Real work now possible | Live external dependency |
| --- | --- | --- |
| Research | Read-only repository transport with sources and timestamps | None beyond local root |
| Engineering | File inspection with SHA-256, allowlisted `node --check`/tests | Local Node |
| Security | Adapter/route/permission inspection | Repository only |
| Operations | Service/task/worker state inspection | Repository state |
| Memory | Approved recall, conflict reporting | Memory store |
| Content | Draft-only DropPilot/Vice City workflows | No publishing |
| Device | Real paired-device state | No physical device in this environment |

No fake transports and no fabricated findings were added.

## 8. Provider and cost control — implemented, tested locally

Per-objective budget is enforced by the reservation before dispatch. Provider attempts produce a
decision record; retries are bounded; no provider can bypass the objective limit. Default transports
are mocked/offline. **No paid provider request was made in this mission.**

## 9. D1 and storage readiness

Reports for each repository: required tables/indexes, migration version, implementation, expected
database, verified identity, schema presence, connection configuration and live-test status. Local
`node:sqlite` validation covers fresh creation, upgrade from `0004`, repeated execution, unique
indexes and data preservation (18/18 checks). This is SQL-shape evidence, **not D1 parity**.
Migration `0005` has not been applied to production or staging.

## 10. Android — compile and package only

`app-debug.apk` is built from this branch. Compile validation is separate from emulator and physical
validation. Pairing is **not** claimed fixed on hardware; see `ANDROID_DEVICE_VALIDATION.md`.

## 11. Control center

Eleven tabs: chat, workers, tasks, memory, approvals, missions, agents, device, recovery, security,
health. Objectives open a detail view with budget, executions, criteria, tasks, evidence, approval
and checkpoints. Recovery shows a scheduler card with status, lease, missed ticks and a manual tick.
Statuses include healthy, degraded, offline, unknown, not_configured and requires_approval; green is
never used just because a configuration exists.

Browser verification: Chromium at a 390×844 mobile viewport loaded `/control` from the local server,
the token gate accepted the local command token, all eleven tabs were clicked and each rendered its
panel (Chat, Workers, Tasks, Memory, Approvals, Missions, Agents, Device, Recovery, Security,
Health). Because no D1 command store is configured in this local process, the command, security,
device and recovery reads return 503/not_configured. The header therefore reads **Degraded** in red,
not Connected, and each panel says the read is failing instead of showing green. Screenshot:
`release/control-center-mobile-security.png`. This verifies rendering, navigation and fail-closed
status; it does not verify populated data views, which need the D1-backed deployment.

## 12. End-to-end demonstration

`npm run demo:objective` runs 24 checks locally: memory recall, durable objective, bounded plan,
approval gate with a simulated owner device, reservation, real file inspection with digest, real
`node --check` and real unit-suite exit codes, evidence, settlement at zero cost, verification,
completion, memory write-back, notification, audit-chain verification, restart reconstruction and
interrupted-run recovery. Output: `release/demo-evidence.json`. The owner identity is simulated and
no provider is called; both are labelled in the artifact.

## 13. Security and safety

Preserved owner authorization, device proof, adapter allowlists, sandbox restrictions, approval gates
and fail-closed behavior. No secrets are printed, no production migration was applied, no deployment
or merge occurred, no phone command was sent and no paid call was made.

## 14. Release gate

`npm run release:gate` runs syntax, full suite, migration checks, command-route authentication,
Android compilation and environment-name reporting, then writes `release/manifest.json` with commit,
schema, artifacts, limitations and rollback. A skipped check is marked skipped, never passed.

## 15. Known limitations

- Android pairing fix is not physically validated; no emulator run either in this environment.
- Migration `0005` is not applied to D1; no live D1 connection was tested.
- Scheduler is not attached to a real cron; no production schedule exists.
- Transports are local read-only; no external research API or model provider is configured.
- Security hash chain is tamper-evident, not tamper-proof.
- Control center browser proof covers rendering and tab navigation, not every deep interaction.

## 16. Rollback

Deploy the previous commit (`deb4e7f`). Migration `0005` is additive; dropping only
`habitat_ax_security_events` and `habitat_ax_scheduler` removes Mission 11 history without touching
tasks, objectives or memory. Never roll back by deleting those tables.
