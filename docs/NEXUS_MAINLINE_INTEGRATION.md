# NEXUS mainline integration (Revision 4.6)

Branch: `ax-nexus/revision-4.6-nexus-mainline-integration`
Base: `main` @ `261eaf7` (`ci: register isolated Nexus D1 verification workflow`)
Target: pull request into `main`. Nothing here is merged, deployed or enabled in production.

This document records what `main` actually runs today, what the revision 4.5 branch adds, what the
branch in this PR changes, and exactly what remains before a worker can be considered operational.

---

## 1. current architecture (verified from source and the live service)

### Live service

`Habitat-1` — `https://habitat-1-szzd.onrender.com`, branch `main`, start command `node server.mjs`,
auto-deploy enabled. Observed on 2026-11-21:

| Probe | Result | What it establishes |
| --- | --- | --- |
| `GET /health` | `200`, `deviceBridge.ready=true`, `deviceBridge.durable=true`, `deviceBridge.axTokenConfigured=true` | D1 credentials are configured and the device store is mounted |
| `GET /ax/command/tasks` | `401` | The `/ax/command` routes are mounted and `HABITAT_AX_BRIDGE_TOKEN` is set (an unset token answers `503`) |
| `GET /diagnostics` | `404` | The live service is `main`, not revision 4.4/4.5, where `/diagnostics` exists |

### Task systems on `main` (two, deliberately separate)

1. **`habitat_tasks`** — the existing worker-task routes: `/tasks`, `/tasks/:id/delegate`,
   `/tasks/:id/...`, dispatch leases (`habitat_dispatch_leases`), recovery. Unchanged by this PR.
2. **`habitat_command_tasks`** — the universal command engine: `/ax/command/*` routes, one row per
   command objective (`id`, `record_json`, `status`, `updated_at`), created lazily by
   `createD1CommandTaskRepository.initialize()` with `CREATE TABLE IF NOT EXISTS`.

They share a database and nothing else. No code in this PR reads or writes `habitat_tasks` from the
command path, and no command objective can appear in the worker-task list.

### Command API lifecycle on `main` (before this PR)

```
POST /ax/command/tasks            (Ax bridge token)
        │
        ▼
createUniversalCommandEngine.submit()  →  repository.create()  →  habitat_command_tasks (queued)
        │
        ▼
   … nothing ever claims the row …
        │
        └── approve / deny / complete / fail via HTTP, `by` taken from the request body
```

Consequences on `main`, all of them real:

- **No executor.** A queued command stays queued forever. There is no worker, no claim, no lease.
- **No adapter binding.** `submit()` has no `adapter` parameter, so a task cannot even name work.
- **Self-attestation.** `complete({ verifiedBy: req.body.verifiedBy })` and the other mutations take
  their actor from the request body. A caller holding the Ax token can approve or complete its own
  task with any attribution it likes. That is not an owner-only approval.
- **No cancellation, fencing, lease recovery, heartbeat or retry ceiling.**
- **Broken CI on `main`.** `.github/workflows/nexus-d1-live.yml` runs `node scripts/d1-live-test.mjs`,
  but that file does not exist on `main`. The workflow fails at its only real step.

---

## 2. what revision 4.5 has that `main` does not

Revision 4.5 (`ax-nexus/revision-4.5-free-deployment-readiness`) diverged from `3ec19af`, one commit
behind `main`. Compared with `main` it adds, in the command/NEXUS area:

| Capability | Module |
| --- | --- |
| Worker: atomic claim, fence, lease renewal, bounded retries, heartbeat table, drain on shutdown | `nexus-runtime.mjs` |
| `/nexus/runtime` heartbeat inspection, `/device/command/approvals`, phone approval/denial, phone cancel | `nexus-runtime.mjs` |
| Read-only adapters: `repo.inspect`, `task.inspect`, `runtime.health` (path-confined, hashed evidence) | `nexus-adapters.mjs`, `nexus-adapter-registration.mjs` |
| Namespace sandbox for the excluded `repo.test` adapter | `nexus-sandbox.mjs`, `sandbox/sandbox-setup.sh` |
| Adapter allowlist at submission, fenced completion/failure, `cancelled`, ownership refusal, idempotency race replay | `universal-command-engine.mjs` |
| `transition()` fenced compare-and-set and optimistic `update()` | `d1-command-task-repository.mjs` |
| Owner-device proof on approve/deny/complete/fail/cancel/retry, fenced-task rejection, audit hook, `cancel` route | `command-routes.mjs` |
| Environment identity, production-D1 sealing, `/diagnostics` | `environment-identity.mjs`, `server.mjs`, `device-command-bridge.mjs` |
| Contract tests for all of the above | `tests/nexus-*.test.mjs` |

Out of scope for this PR and **not** taken from 4.5: the Android/APK changes, the pairing-recovery
rework, the ownership migration (`0003`), the nonproduction Render blueprint (`render.yaml`), and the
environment-sealing behaviour. Those belong to the nonproduction deployment line and are reviewed
separately.

---

## 3. what this PR changes

Additive. The `habitat_tasks` system, every existing route and every existing response shape is
untouched.

### New modules

- `nexus-runtime.mjs` — the worker and its runtime routes.
- `nexus-adapters.mjs`, `nexus-adapter-registration.mjs` — the three read-only adapters.
- `nexus-sandbox.mjs`, `sandbox/sandbox-setup.sh` — required by `nexus-adapters.mjs` and used only by
  the deliberately unregistered `repo.test`.
- `scripts/d1-live-test.mjs` — the file `main`'s own CI workflow already calls.

### Changed modules

- **`d1-command-task-repository.mjs`** — `transition()` (single conditional `UPDATE … RETURNING` on
  status + fence + claimedBy) and an optimistic `update()` whose token is the stored bytes. New
  exported `d1DatabaseEndpoint()` is now the *only* place a D1 URL is built.
- **`universal-command-engine.mjs`** — `adapter` allowlist at submission (`repo.inspect`,
  `task.inspect`, `runtime.health`), `claim`-aware `complete()`/`fail()` that write through the fenced
  transition, `cancelled` as a terminal state, refusal to mutate a worker-fenced record through a
  legacy path, and replay of a concurrent idempotent submission instead of a 502.
- **`command-routes.mjs`** — owner device id + device token required for every owner action and
  verified against the **device** repository; fenced tasks cannot be closed around the worker;
  `audit` hook; `POST /ax/command/tasks/:id/cancel`; actor identity no longer read from the body.
- **`device-command-bridge.mjs`** — mounts the command API with the device verifier, mounts the worker
  against the *same* store, engine, registry and D1 query, and reports `nexus` in `status()`.
  New optional parameters (`taskRepository`, `query`, `adapters`, `handleSignals`, `exitOnSignal`,
  `log`) exist for tests; a deployment passes none of them.
- **`server.mjs`** — `/health` gains a read-only `nexus` block. It is not part of the success
  condition, so a Render health check never depends on the worker.
- **`package.json`** — syntax checks for every new module and test.

### Mount and startup order

```
registerDeviceCommandBridge(app)
  ├── device store (unchanged)
  ├── existing device / pairing / heartbeat / console routes (unchanged)
  ├── registerUniversalCommandRoutes(repository: taskRepository, deviceRepository: deviceStore)
  │       └── /ax/command/*  (owner actions now require a verified owner device)
  └── registerNexusRuntime(repository: sameStore, engine: sameEngine, query: sameD1)
          └── only if NEXUS_RUNTIME_ENABLED === "true" and a store + query exist
initialize()
  ├── device store.initialize()      (unchanged, first)
  ├── ready = true
  └── nexus.initialize()             (creates the command table if needed, starts the worker)
```

The runtime routes are registered only when the worker is mounted; they answer `503` until
`initialize()` has completed. A failed worker start leaves the device bridge usable and reports
`nexus.ok=false`, which `POST /health` shows as `nexus.started=false`.

### Default state

`NEXUS_RUNTIME_ENABLED` is **off** unless the value is exactly `true`. The PR therefore does not
start a worker in production by itself. `/health` will report
`nexus: {configured: false, reason: "disabled_by_config"}` until an operator opts in.

---

## 4. database configuration findings

Verified from code and the live service; **not** verified against the live database, because no
Cloudflare or D1 credential was available to this audit.

| Question | Answer | Basis |
| --- | --- | --- |
| Is D1 reachable and mounted on the live service? | Yes | `/health` `deviceBridge.durable=true`, `axTokenConfigured=true` |
| Which database does it use? | Exactly one: `HABITAT_D1_DATABASE_ID`, with `CLOUDFLARE_ACCOUNT_ID` and `HABITAT_D1_API_TOKEN` | single env read in `command-routes.mjs`, `nexus-runtime.mjs`; now a single endpoint builder |
| Has `habitat_command_tasks` ever been created in the live DB? | **Unknown** | see below |
| Could the live service be pointing at a nonproduction database? | Not determinable here | requires the D1 id or a logged-in Cloudflare session |

**Why "unknown" is the honest answer.** The table is created by
`createD1CommandTaskRepository.initialize()`, which is called lazily from the route guard *after*
`requireAx` succeeds:

```js
const guard = fn => async (req, res) => {
  if (!(await ready(res))) return undefined;   // ready() → store.initialize() → CREATE TABLE IF NOT EXISTS
  return await fn(req, res);
};
```

`requireAx` runs first, so an unauthenticated probe (such as `GET /ax/command/tasks` → `401`) never
reaches D1. The table exists if and only if some request has been made **with the correct Ax bridge
token** since `main` was deployed. An absence from a SQL inventory is consistent with that never
having happened; it is not evidence that the API uses a different database. There is no other runtime
path that creates the table: `migrations/0002_habitat_command_tasks.sql` is an idempotent copy of the
same DDL, and is not applied by any migration runner in this repository.

**Separation, structurally enforced.** Both the command repository and the worker's claim query now
build their endpoint through `d1DatabaseEndpoint({ accountId, databaseId })`, and the bridge passes
`repository`, `query`, `engine` and `registry` from one construction site. There is no second
database id anywhere in the mainline command path, not even an unused fallback.
`tests/nexus-mainline-integration.test.mjs` asserts that a second D1 id present in the environment
(`HABITAT_PRODUCTION_D1_DATABASE_ID`) is never contacted.

**Non-secret identity check.** `GET /nexus/runtime` (Ax token) returns
`runtime.databaseFingerprint` — the first 12 hex characters of `SHA-256(HABITAT_D1_DATABASE_ID)`.
Compare it with the same hash of the nonproduction id to prove the two services differ, without
publishing either id:

```sh
printf '%s' "$NONPROD_D1_DATABASE_ID" | sha256sum | cut -c1-12
```

---

## 5. missing components (after this PR, and on both branches)

1. **No adapter that performs work.** The only registered adapters are read-only inspections. There is
   no `android.command` adapter that enqueues a real device action through the device command queue
   and reports the phone's result, and no GitHub/web/publish adapter. An objective naming anything
   else is rejected at submission; a row written by another writer is claimed and **failed** with
   `No adapter registered for "<name>".`
2. **No durable command audit on `main`.** Revision 4.5 writes audit rows through the device store's
   `audit()`; `main`'s device store has no such method, so this PR passes no audit hook. Actions are
   recorded in each task's own `history` only.
3. **No scheduler yet.** The in-process timer still runs only while the web service is awake. The
   one-shot entrypoint that removes that dependency now exists (`scripts/nexus-tick.mjs`), but the
   Render Cron Job that would call it has **not** been created — see
   `docs/NEXUS_CRON_DEPLOYMENT.md`.
4. **No migration runner.** Schema creation remains lazy. This is adequate for the two tables involved
   (`CREATE TABLE IF NOT EXISTS`) and is not a substitute for migrations.
5. **No live verification.** Nothing in this branch has executed against Cloudflare D1 or a physical
   device.

---

## 6. tests executed

Local, on this machine only. `node --test`, Node v26.13.1; the repository's `engines` require >=22.

| Command | Result |
| --- | --- |
| `npm run check` | exit 0 (all modules and new tests parse) |
| `npm test` | **395 / 395 pass**, exit 0 |
| `node --test tests/nexus-mainline-integration.test.mjs tests/nexus-habitat-integration.test.mjs` | **16 / 16 pass** |

New or newly relevant coverage:

- `tests/nexus-mainline-integration.test.mjs` (6) — one endpoint builder for the API and the worker;
  the builder refuses a missing id; a second database id in the environment is never contacted; no
  credential appears in a URL; incomplete D1 mounts no worker and no `/nexus/runtime` route; the
  runtime endpoint reports a 12-hex fingerprint and never the id or token; an unregistered adapter
  fails the task with no fabricated result.
- `tests/nexus-habitat-integration.test.mjs` (10, ported from 4.5, passes unmodified on this base) —
  real bridge → real `/ax/command` routes → real engine → real repository code → real worker → real
  adapter → SQLite through the D1 HTTP shape: retryable failed init, exactly-once worker start,
  authorized execution persisted as `done` with evidence, adapter rejection before storage,
  owner-only approval routes (403 for a paired non-owner, 401 without a token), graceful drain of an
  in-flight adapter, and pairing/heartbeat still working.
- `tests/nexus-runtime.test.mjs`, `nexus-runtime-sqlite.test.mjs`, `nexus-repository-sql-sqlite.test.mjs`,
  `nexus-fencing-guards.test.mjs`, `nexus-adapter-binding.test.mjs`, `nexus-adapters.test.mjs`,
  `nexus-adapter-registration.test.mjs`, `nexus-sandbox.test.mjs`, `nexus-lifecycle.test.mjs` —
  claims, fences, lease recovery, retry ceiling, stale-worker refusal, adapter path confinement,
  evidence requirements and shutdown.
- `tests/command-routes.test.mjs`, `tests/universal-command-engine.test.mjs`,
  `tests/d1-command-task-repository.test.mjs` — updated for owner proof, cancellation, adapter
  allowlisting and fenced transitions.

Storage in every one of these tests is `node:sqlite` or in-memory. **They prove the code paths, not
the deployment.** No test contacted Cloudflare D1, Render, or a phone.

---

## 7. security and deployment risks

| Risk | State in this PR |
| --- | --- |
| Ax token alone can approve or complete work | Closed. Every owner action requires a paired owner device id **and** its device token, verified against the device repository; `by`/`verifiedBy` come from the verified device, not the body. No verifier ⇒ `503`. |
| Two workers complete or overwrite the same task | Closed. Claim is one conditional `UPDATE … RETURNING`; completion/failure are fenced compare-and-set on `status='working'` + `fence` + `claimedBy`; a stale worker gets `stale_claim` and writes nothing. |
| A task is retried forever | Closed. Only an expired lease is retried, at most `maxAttempts` (3), then failed with a stated reason. An adapter failure is terminal. |
| A task "completes" without doing anything | Closed. Completion requires non-empty `evidence` and a summary; an unknown adapter fails the task. |
| Owner approval deadlocks on a fenced task | Closed. Parking for approval clears the fence through the same fenced transition, so the owner can then decide. |
| Duplicate task system | No. `habitat_tasks` and `habitat_command_tasks` stay separate; the worker touches only the latter plus the new `habitat_nexus_workers`. |
| Worker silently not running | Reported, not hidden: `/health` `nexus`, `/nexus/runtime` (`workerConfigured`, `workerStarted`, `liveWorkers`, `heartbeatVerified`), and a `NEXUS_RUNTIME_MOUNT` log line. |
| D1 write cost from polling | Fixed by the heartbeat policy: routine beats are written at most once per `NEXUS_HEARTBEAT_SECONDS` (>= 30 s) and lifecycle transitions (`starting`, `executing`, `stopped`, `error`) are never throttled, so an idle worker at a 5 s poll writes ≈2,880 rows/day instead of ≈34,600. See `docs/NEXUS_AUTONOMOUS_EXECUTION.md` §3. |
| Render Free sleep | The worker stops when the service sleeps. Queued work waits. Not solved here. |
| Data-loss / destructive action | Not reachable. Only read-only adapters are registered, and `repo.test` (the only executor) is deliberately excluded from the mount. |
| Silent behavioural change on deploy | Worker is off unless `NEXUS_RUNTIME_ENABLED=true`. The command API's owner actions change from "body-supplied actor" to "verified owner device", which is the point of the PR and the main review item. |

---

## 8. exact remaining deployment requirements

Nothing below was performed. All of it needs either owner credentials or the owner's decision.

1. **Review and merge this PR into `main`.** No merge, no push to `main`, no Render action was taken.
2. **Confirm the live database identity.** In the Render dashboard, note `HABITAT_D1_DATABASE_ID` for
   `Habitat-1` and compare it with the nonproduction database id. They must differ. Record both
   fingerprint values (`printf '%s' "<id>" | sha256sum | cut -c1-12`) only if the owner wants a
   durable note — never the ids themselves.
3. **Decide whether to create the table.** Either make one authenticated call
   (`GET /ax/command/tasks` with `Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN`), which triggers the
   lazy `CREATE TABLE IF NOT EXISTS`, or run `migrations/0002_habitat_command_tasks.sql` once in the
   D1 console. Both are idempotent and additive. Do not run anything that drops or renames a table.
4. **Set `HABITAT_OWNER_DEVICE_IDS`** to the paired owner device id. Without it, every owner action
   answers `503` by design, and the phone approval routes do too.
5. **Only then set `NEXUS_RUNTIME_ENABLED=true`.** After the deploy, verify:
   - `GET /health` → `nexus.configured=true`, `nexus.started=true`, `nexus.worker=true`;
   - `GET /nexus/runtime` with the Ax token → `workerConfigured=true`, `workerStarted=true`,
     `liveWorkers>=1`, `heartbeatVerified=true`, and the expected `databaseFingerprint`.
   If `started` is false, read the `NEXUS_RUNTIME_*` server log line; do not report the worker as
   operational.
6. **Submit one read-only smoke objective** (`adapter: "runtime.health"`) and confirm it reaches
   `done` with `runtime:` evidence in `result.evidence`. If it stays `queued`, the worker is not
   running (most likely Render sleep or a failed init), and that is the finding.
7. **Keep `HABITAT_AX_BRIDGE_TOKEN` server-side.** It must never enter the APK, a browser bundle or a
   log. This PR adds no place that echoes it.

### What this audit could not verify

- Whether `habitat_command_tasks` exists in the live database (needs the Ax token or D1 access).
- Which D1 database the live service uses (needs the dashboard or D1 access).
- Any runtime behaviour on Render, including worker start, sleep/wake and the SIGTERM path.
- Anything on a physical device.
