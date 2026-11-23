# NEXUS Mission 21 — Production Reliability and Engineering Sandbox Preparation

Baseline: `e47f54f1c1130089b7bbe34ead533ac7653ed55f` (Mission 20, CI green). This mission is code and
local evidence only. Nothing was deployed, no D1 database was changed, no model was called, and no
production configuration was altered.

## 1. Durable cost accounting (D1)

The process-local ledger is replaced by a storage contract the governor can transact against:

- `ax-cost-governor.mjs` keeps the same reserve/settle/release API. It prefers `store.transact(day,
  mutator)`; the old read/write path remains for tests and as an honest non-durable fallback.
- `d1-ax-cost-ledger-repository.mjs` stores one row per UTC day in `habitat_ax_cost_ledger`
  (`day`, `state_json`, `updated_at`). A write is:

  ```sql
  UPDATE habitat_ax_cost_ledger
     SET state_json = ?, updated_at = ?
   WHERE day = ? AND state_json = ?
  RETURNING day
  ```

  A losing writer gets no row and retries against fresh state (eight attempts, then
  `cost_ledger_conflict`). Insert uses `ON CONFLICT(day) DO NOTHING RETURNING day`, so two instances
  starting the same day cannot both create and spend the row.
- `device-command-bridge.mjs` builds the D1 store when `CLOUDFLARE_ACCOUNT_ID`,
  `HABITAT_D1_DATABASE_ID` and `HABITAT_D1_API_TOKEN` exist and passes it to
  `resolveMissionPlanner(env, { costStore })`. Without credentials the planner uses the memory
  ledger and reports `durable: false`.
- Migration `0007_ax_cost_ledger.sql` declares the table and its `updated_at` index. It is additive
  and idempotent.

**Evidence (real SQL, SQLite):** two governors over two store instances race a $0.01 day with two
$0.006 reservations; exactly one succeeds, the other receives `daily_budget_exceeded`, and the stored
`reservedUsd` never exceeds the ceiling. A new governor over the same database sees the prior
`spentUsd` and refuses the next reservation, which is the restart proof at the storage layer.

**Limits of the proof:** SQLite is not D1. The CAS SQL is standard and the HTTP contract is unchanged,
but the migration and the repository have not run against the production D1 database. The live
service also has no D1 credentials or deployed key, so production durability is unverified.

## 2. DNS-rebinding-safe web research

`createPinnedHttpsFetch` in `ax-web-research.mjs` uses `node:https` with:

- `lookup` returning the address that `validatePublicUrl` already resolved and checked (public,
  HTTPS, port 443, no credentials);
- `servername` set to the URL hostname, so SNI and certificate verification still name the host;
- `rejectUnauthorized: true`, `minVersion: TLSv1.2`, `agent: false`;
- the same abort/timeout and bounded-read path as before.

`createWebResearchTransport` passes `address`/`family` for every redirect hop, and production
`resolveAgentTransports` selects the pinned transport by default (`AX_WEB_RESEARCH_PINNED=false` is an
explicit opt-out for a controlled local environment). Redirect responses are still revalidated with
the same public-URL rules before the next hop.

**Evidence:** a fake https module captures the real request options; tests assert the pinned address
from `lookup`, `servername`, `rejectUnauthorized`, TLS version, Host header, path and body read, and
that a loopback pinned address is refused. A transport test asserts the validated public address is
what the fetcher receives.

**Limits:** the pinned transport was not exercised against a live remote host in this environment;
certificate and redirect behavior are covered by option-level tests and existing transport tests.

## 3. Approval-gated engineering sandbox

`ax-engineering-sandbox.mjs` provides `createEngineeringSandbox`:

- **Isolation:** copies a bounded snapshot of the configured source root into a fresh temporary
  directory; the deployed checkout is never written. `.git`, `node_modules`, build output and env
  files are skipped, and copy count/bytes are capped.
- **Authorization:** `apply` refuses unless an injected `approvalVerifier` accepts the approval for
  that objective and change set. The verifier is independent of the caller; a missing verifier or a
  bad token returns `approval_required` before any write.
- **Limits:** relative non-hidden paths only, containment check, `.git`/env/node_modules prefixes
  refused, 10 files, 200 KB per file, 600 KB per change set, six checks, 60 s per check, 8 KB output
  tail.
- **Checks:** no shell; command must be in `allowedCommands`, arguments are arrays, the child gets
  only `filteredEnv` (no credentials), runs in the copied workspace and is killed by process group on
  timeout.
- **Rollback:** `rollback` restores the copied originals (or deletes newly created files); `discard`
  removes the workspace.
- **Audit:** `sandbox.approved`, `sandbox.applied`, `sandbox.check_failed`, `sandbox.refusal`,
  `sandbox.rolled_back`, `sandbox.discarded` are emitted through the audit hook.
- **Independent verification:** a proposal is `verified` only when at least one check ran and every
  check exited zero; a refused check counts as failure.

`createSandboxEngineeringTransport` (in `ax-agent-transports.mjs`) keeps the read-only engineering
behavior when no change set is supplied and uses the sandbox when a caller supplies `changes` plus an
owner approval. The engineering agent passes `changes`, `approval` and `checks` through only when the
caller supplied them.

Enable on a host with a local snapshot:

```text
AX_AGENT_LOCAL_ROOT=/path/to/repo
NEXUS_SANDBOX_ENABLED=true
NEXUS_SANDBOX_APPROVAL_TOKEN=<owner-held secret>   # never commit or log
```

**Evidence:** without approval the source file is byte-for-byte unchanged and the call returns
`approval_required`; with approval the copied file changes, `node --check` exits zero, the diff shows
the change, and the source remains unchanged. Traversal, too many files, non-allowlisted commands,
and failing checks are covered. Rollback restores the copied original and discard removes the
workspace.

**Limits:** the sandbox is not mounted behind a command route yet; a route must authenticate the
owner and carry the approval token before this is remotely usable. It runs on the host filesystem (a
copy), not a VM/container; it is not a kernel isolation boundary. No live agent used it in this
mission.

## 4. Tests and checks run

- `npm test` — 789 tests, 789 pass, 0 fail (was 781; +8 Mission 21 tests).
- `npm run check` — exit 0 (includes the new modules and test).
- `npm run migrations:check` — 24 checks, 24 pass, 0 fail (fresh, repeated and upgrade preservation).
- Mission 21 focused suite — 8/8 pass.
- `node scripts/release-gate.mjs --skip-android` — every executable gate check passes (syntax,
  789-test suite, migrations, route auth, release inputs, evidence claims, critical adversarial
  suites, channel/acceptance). The gate reports `releaseReady: false` solely because the Android
  build is skipped and a skip is never counted as a pass; the local Gradle/SDK toolchain is absent.
- CI was run after the push; the result is reported in the handoff (not in this document).

## 5. Known limitations

- D1 durability is proven in SQL shape and SQLite semantics only; migration 0007 is not applied to
  production and no live restart has been observed.
- The process-wide cost ledger remains the fallback when D1 credentials are absent; it is not durable.
- DNS rebinding protection is pinned at the HTTP client layer; any other outbound client added later
  must use the same helper.
- The sandbox is a filesystem copy with policy checks, not a hardware/VM isolation boundary, and is
  not remotely reachable until an authenticated route is added.
- Sandbox approval is a bearer token in the environment; rotating it requires a deploy/config change.
- No live model call, deployment, staging D1 write or paid provider was used.

## 6. Owner actions to reach live validation

1. Apply `0007_ax_cost_ledger.sql` to the production D1 database through the normal migration process
   and verify the table/index exist. Do not run it from this environment.
2. Deploy this branch when authorized and confirm `GET /ax/command/agents` reports the planner with
   `durable: true` once D1 credentials are present.
3. Run one real mission and restart the service; confirm the daily spend survives and a second
   mission cannot exceed the ceiling.
4. Add an authenticated owner-only sandbox route (or keep the sandbox disabled) before enabling
   `NEXUS_SANDBOX_ENABLED`; set its approval token through the host secret store.
5. Keep `AX_WEB_RESEARCH_ENABLED` off until an owner wants live research; when enabled, leave
   `AX_WEB_RESEARCH_PINNED` at its default.
6. Move to the revenue path: one live objective, one measured outcome, and the first paid offer. Stop
   expanding the platform without a revenue signal.

## 7. Rollback

Deploying the previous commit is safe for application code. Migration 0007 only adds a table and an
index; leaving it in place after a rollback is harmless. Do not drop task, objective, memory or
message tables to roll back this mission.
