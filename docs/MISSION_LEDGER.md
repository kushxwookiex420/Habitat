# Mission ledger

Updated on every push. Status words mean exactly this: **verified** = a command or CI run produced
evidence; **pushed** = on `staging/integration`; **CI-tested** = the run is named; **staging** = a
deployed staging service exercised it; **production** = the live service; **phone** = the S26 Ultra.

## Verified

| Capability | Evidence |
| --- | --- |
| Android debug signing identity is stable and checked | Repo keystore `debug-key.p12`, fingerprint `791eacbc33fbfcdb770a4299342cb1ad8fc6d959325df75091a03004726eb258`; CI run `45300974210` built and its guard step passed |
| Overlay typography accepts real catalog titles | Visual QA passes the 52-character title after the newline-split fix; render verified 1/1 |
| Full catalog video renders and passes QA | 892,530 bytes, 12.000 s, 1080×1920, 360 frames, SHA-256 `e3891bc0…` |
| Staging database adopted and reachable from CI | Run `45296503185`: 48 objects, 20 tables, 8/8 P1 tables, `applied: []`, `productionIdDiffers: true` |
| Improvement findings ride the scheduler tick | 9 tests in `tests/ax-scheduler-improvement.test.mjs`; suite 1,036 pass |
| Reconciliation of the two status implementations | One `system-status.mjs`, redaction policy v2, #115 7/7 green |
| Finance ledger and prioritisation modules | 25 tests; evidence-required rejections, verified-only net worth |
| Replaceable-agent workforce registry | 20 tests; adapters, agent records, capacity, conflict, retry, handoff, independent verification |
| Workforce survives a process restart | 6 tests in `tests/ax-workforce-durable.test.mjs` against real SQLite: agents, in-flight assignment, verified result, audit and pending approval all reload into a new engine; self-verification refused after reload |
| Finding → task → verified without a script | 15 tests (`ax-workforce-pipeline`, `ax-scheduler-workforce`): one scheduler tick converts a real `execution_blocked` finding into an assigned task, executes it, obtains independent verification and stops at approval-required; the tick's second run does not duplicate it |
| Workforce write-through store | `d1-workforce-repository.mjs` + `migrations/0010_ax_workforce.sql`; idempotent upserts, append-only audit, partial unique index allowing one active assignment per task; `migrations:rollback` 14/14 |
| Restart demonstrated end to end | `npm run workforce:demo`: closed the first instance at `countsBefore {agents:2, assignments:1, results:0, audit:5}`, hydrated the second to the same counts with `activeRecovered: 1`, then verified 20/20 real tests, `approvalState: "required"`, `costMeasured: false` |
| Workforce runtime attached, independently flagged | `ax-workforce-runtime.mjs`; `HABITAT_WORKFORCE_ENABLED` is separate from `NEXUS_RUNTIME_ENABLED`. Disabled mode issues no query and creates no store (12 runtime tests) |
| Fail-safe startup | Tested: disabled, unconfigured (no memory fallback), `schema_missing` (runtime creates nothing), `initialization_failed` (D1 read timeout), unavailable worker skipped, provider failure bounded to `exhausted`, plan-only default never claims `verified` |
| Scheduler runs the attached runtime | Scheduler tick over the runtime reaches `verified` with `verified: true`, `counts.approvalRequired: 1`; `/system/status` reports `running` only after a step actually happens |
| Disabled mode leaves existing behavior intact | Real server start (`tests/server-workforce-disabled.test.mjs`): `/health`, `/workers`, `/capabilities`, `/system/status`, `/continuity/status` all 200; workforce `disabled`; log shows memory-only storage and no `WORKFORCE_STATUS` |
| Staging migration procedure prepared, not applied | `docs/WORKFORCE_D1_STAGING_MIGRATION.md`; read-only `npm run workforce:preflight` (SELECT only, exits non-zero when 0010 is absent) |
| Ax identity is independent of the provider | `ax-identity.mjs`; digest identical under different providers, `coupled: false`; 8 tests; `/system/status` reports name, digest, persistence and directives |
| Identity persists and survives restart | Stored in memory project `ax`; a new instance reports `persistent`; a rewritten record is reported `not_yet_persisted`, never believed |
| Owner-only standing directives | Non-owner writes refused (`owner_required`); deletion owner-only and versioned; agent writes cannot change the code-defined digest |
| Memory export and recovery | `ax-memory-backup.mjs`; digest verified before any write; restore reproduces the source digest in a fresh database; idempotent replay; local-newer conflicts and credential-bearing entries refused with zero writes (5 tests) |
| Retention is a report, not a purge | `retentionReport` lists old entries and deletes nothing; deletion stays an owner action with a revision |
| Owner provenance is authenticated, not asserted | Audit found `source: "owner"` was an ordinary string. `ax-owner-attestation.mjs` signs the exact fields (HMAC, TTL, constant-time); memory refuses unsigned owner writes under `ownerPolicy: "required"`; identity directives refuse unsigned owner claims when a verifier is configured. **Limitation recorded:** the bridge still builds memory in `optional` mode, so repository-level owner trust closes only when `HABITAT_OWNER_ATTESTATION_KEY` is set |
| Backup authenticity is keyed, not digest-only | Audit found an edited payload plus recomputed digest passed. Backups now carry an HMAC over project/time/count/digest; a self-consistent forged backup is refused `backup_mac_invalid` with zero writes, and `requireSigned` refuses unsigned documents. Unsigned export is explicit (`signed: false`), never called authentic |
| Mission Execution Engine | `ax-mission-engine.mjs` + migration `0011`: durable intake, requirements/criteria, dependency-aware milestones, workforce assignment, bounded retries, independent verification, acceptance-gap reporting, approval gate, restart recovery. 15 tests including restart without duplicate assignment, partial failure, worker loss/return, duplicate submission |
| Missions are disabled by default | `HABITAT_MISSIONS_ENABLED` unset; runtime reads no schema and refuses (`missions_disabled`). Enabled without 0011 → `schema_missing`; enabled without a workforce → `worker_unavailable` |
| Mission coordination is attached to the one scheduler | `missionTick` is invoked inside the existing lease; `/system/status` reports `components.missions` separately; a disabled runtime changes no route |
| Owner attestation: rotation, revocation, replay | Keyring with one active key and retired keys that still verify old data; revoked keys refuse; single-use nonce; signed-field canonicalisation and constant-time compare; 13 owner-security tests |
| Backup authenticity and recovery | HMAC over project/time/expiry/count/digest; expired, incompatible, forged, unsigned (under `requireSigned`) and revoked-key backups refused with zero writes; restore into a separate database then a fresh repository read reproduces the digest |
| Ax ↔ Habitat gateway implemented, disabled | `ax-gateway.mjs` + `migrations/0012`: scoped hashed tokens, expiry/revocation, DB-level nonce replay guard, per-client rate limit, audit, status/missions/submit/recover/decision endpoints, OpenAPI at `/ax/v1/openapi.json`. 12 real-HTTP tests |
| Gateway approvals cannot be self-issued | Approval requires a valid owner attestation; a client with `missions:approve` but no signature gets 403 and the mission stays `approval_required` |
| Habitat heartbeat exists independently | `ax-heartbeat.mjs` + `0013`: persisted beat, missed-beat detection, deduped event queue and delivery states; runs with no integration present |
| ChatGPT reconnection trigger | `GET /ax/v1/heartbeat` returns the exact `AX RECONNECT — HABITAT HEARTBEAT.` trigger with active/completed/failed/approval context and queued changes; ack is scoped and idempotent |
| Event-triggered, not chat spam | Events are derived from mission/approval state with unique dedupe keys; repeated beats and restarts enqueue nothing new; 10 monitor tests + 2 HTTP tests |
| Delivery is not availability | Webhook 2xx → delivered, owner ack → acknowledged, bounded failures → dead; with no notifier events stay queued. No wake of an inactive ChatGPT is claimed |
| MCP security hardening | AES-256-GCM subscription secrets with key ids/rotation/revocation and AAD binding; DNS-pinned callback fetch refusing private/redirect targets; persistent delivery leases (0016) with crash recovery; 9 hardening tests + migration integrity tests |
| Durable approval nonces | migration 0017 `habitat_ax_approval_nonces`: nonce primary key as the replay boundary, key/mission/approval/task/decision/expiry/status audit columns, indexes for mission, approval and expiry cleanup; atomic consume-then-persist with compensating release; indexed lookup ≈2,800–3,350× faster than the retired JSON scan at 2,000 missions |
| Staging package | `docs/STAGING_DEPLOYMENT_PACKAGE.md`: env, D1 permissions, key generation/rotation/recovery, migrations 0010–0016, token lifecycle, MCP registration, HTTPS/health, backup/DR, free vs paid costs |
| OpenAI MCP Events adapter | `ax-mcp-events.mjs` + `0015`: initialize/server-discover capability, events/list catalog with filters, idempotent subscribe with callback challenge and secret rotation, unsubscribe, Standard Webhooks delivery, cursor replay, persistent retries; 19 local tests, default-disabled |
| Real ChatGPT subscription still unproven | No public origin, staging D1, plugin or Work chat in this environment; acceptance checklist staged in the runbook, no fake callback labelled end-to-end |
| Gateway, owner and staging readiness | Keyring loaded from env with one active key, revocation list and `/system/status` owner state; shared rate limiting table 0014 with local fallback; exported OpenAPI 3.1 + smoke runner; migration 0014 prepared, not applied |
| Integration is still not operational | No public HTTPS origin, staging D1 credentials, owner key or ChatGPT workspace in this environment; acceptance runbook and runner exist, real end-to-end remains owner-gated |
| Gateway default is off | `HABITAT_GATEWAY_ENABLED` unset → every `/ax/v1` route 503, no token checked, no store built; `/system/status` reports it as disabled |
| End-to-end self-improvement cycle | `scripts/self-improvement-demo.mjs`: detected an unused export, implemented on `demo/self-improvement-*`, self-verification **refused**, independent verification passed 2/2, status `verified`, `approvalRequired: true` |

## Implemented, not deployed

- Improvement engine inside the scheduler (`improvement` callback + `createImprovementMonitor`).
- `/system/status` with redaction policy v2 and per-key configuration inventory.
- Product-video renderer with the libass fallback and honest readiness.
- Finance ledger (`ax-finance.mjs`), prioritisation (`ax-priorities.mjs`), improvement engine.
- Workforce registry (`ax-workforce.mjs`) — in-memory, with no durable repository yet, so agents do not
  survive a restart. That is the next layer, not a claim.
- Phone signing comparison helper (`scripts/verify-phone-signing.sh`) — read-only; needs the phone.
- Staging Render blueprint (`deploy/render.staging.yaml`) and acceptance run plan.

## Deployed and staging-tested

Nothing. No staging service exists, so no capability has been exercised on a deployed origin.

## Production-tested

Nothing from this branch. The live origin serves commit `0d5eb6e` (not on `main`) and returns **404**
for `/system/status`; `/workers` still shows the pre-catalog shape.

## Phone-verified

Nothing. The installed Bridge reports 0.8.7 while this tree declares 0.8.6, so no APK here is assumed
compatible. The installed certificate has not been read.

## Blocked

| Blocker | Owner action needed |
| --- | --- |
| Render staging service | Collaborator access or `RENDER_API_KEY`; approval of the paid `starter` plan; the production branch value from the dashboard |
| Phone signature comparison | Run `scripts/verify-phone-signing.sh <apk>` with the phone connected — read-only, installs nothing |
| Production D1 schema comparison | A credential for the account that holds `3a906029…`; this token cannot see it |
| Live call phases 3–4 | A speech service choice and budget approval; no media server exists |

## Next highest-value task

Phases One–Three are implemented and locally verified, and the integration gateway exists behind its own
flag. Nothing is staging-verified. The gap is now **environmental and provider-facing**: applying
0010 to the staging database using `docs/WORKFORCE_D1_STAGING_MIGRATION.md`, then — on separate owner
approval — setting `HABITAT_WORKFORCE_ENABLED=true` in staging and observing `initialized`,
`recoveredAssignments` after a restart, and a scheduler-driven cycle that reaches `verified` with
approval still pending. None of that has happened yet: the runtime is attached, not activated. The
adapter contract is unchanged and provider-free: intake and the runner only ever name an `adapterId`.

## Autonomous workforce v1 (0018, prepared not applied)

Execution ownership is now durable on top of the same mission engine:

- every task attempt acquires a **lease** for exactly one worker; a partial unique index makes "two
  workers own one task" impossible rather than unlikely;
- a lease that expires cannot be renewed, and a worker whose heartbeat is stale receives no new work;
- the attempt is claimed in an **execution ledger** before the executor runs. A success is recorded before
  verification, so a verification failure cannot re-release the external operation; a crashed attempt
  becomes `uncertain` and is never retried automatically;
- `recover()` sweeps expired leases, converts orphaned attempts to `uncertain`, then resumes missions with
  a `mission.resumed` event;
- `reconcile()` requeues a task only when its lease died **before** any attempt started; otherwise it fails
  the task as `outcome_uncertain`.

The approval gate is unchanged and always runs before a lease is acquired. Contract, metrics and the
dashboard API are in `docs/AUTONOMOUS_WORKFORCE_V1.md`; the schema is in `docs/D1_TASK_SCHEMA.md`.

Still blocked on the same environmental work: 0018 has not been applied to any D1 database, so lease
enforcement is attached but not exercised on a deployed origin. `/ax/v1/workforce*` answers 503 until it is.
