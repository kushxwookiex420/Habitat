# NEXUS Mission 08 — autonomous core

One mission, eight workstreams. This document is the architecture map, the evidence index and the
honest status of each workstream. It records what is implemented and tested, what is implemented but
not live-tested, and what is deliberately not built yet.

Starting commit: `878ba562eee444be35b3f28a0fc00150e2de7447` on
`ax-nexus/revision-4.6-nexus-mainline-integration`, PR #93 (draft).

---

## 1. Architecture map

```
                 ┌──────────────────────────────────────────────────────────┐
 owner / Ax UI ──┤ command-routes.mjs  (/ax/command/*)                      │
                 │  requireAx + owner device token for every owner action   │
                 └───────────────┬──────────────────────────┬───────────────┘
                                 │                          │
                 ┌───────────────▼──────────┐   ┌───────────▼─────────────┐
                 │ ax-orchestrator.mjs      │   │ universal-command-      │
                 │  plan → submit → poll    │   │ engine.mjs (ONE task    │
                 │  → verify → summarise    │   │ store: habitat_command_ │
                 │  runs: habitat_ax_runs   │   │ tasks)                  │
                 └───────┬──────────────────┘   └───────────┬─────────────┘
                         │ planner                          │ claim / fence
                 ┌───────▼──────────────┐   ┌───────────────▼─────────────┐
                 │ ax-providers.mjs     │   │ nexus-runtime.mjs worker    │
                 │ openai | gemini |    │   │ lease, heartbeat, fencing,  │
                 │ openrouter + fallback│   │ deadline, recovery, prune   │
                 └──────────────────────┘   └───────────────┬─────────────┘
                                                            │ adapters
                                            ┌───────────────▼─────────────┐
                                            │ nexus-adapters.mjs          │
                                            │ repo.inspect, task.inspect, │
                                            │ runtime.health, repo.test   │
                                            │ (sandboxed, opt-in)         │
                                            └───────────────┬─────────────┘
                                                            │ repo.test only
                                            ┌───────────────▼─────────────┐
                                            │ nexus-sandbox.mjs           │
                                            │ userns+chroot+rlimits+      │
                                            │ pgid supervisor             │
                                            └─────────────────────────────┘

 Separate, untouched stores: habitat_tasks (legacy worker tasks),
 habitat_device_commands (bridge), habitat_dispatch_leases (content jobs).
 New, additive stores: habitat_ax_runs, habitat_nexus_workers,
 habitat_ax_memory, habitat_ax_memory_revisions.
```

| Boundary | Module | Rule |
| --- | --- | --- |
| Task submission | `universal-command-engine.mjs` | one task engine; idempotency by key; adapters allowlisted at submit |
| Ownership | `nexus-runtime.mjs` + `d1-command-task-repository.mjs` | lease + fence + compare-and-set `transition()` |
| Execution | `nexus-adapters.mjs` | read-only by default; `repo.test` requires an explicit opt-in |
| Isolation | `nexus-sandbox.mjs` | fail-closed; see `docs/SANDBOX_SECURITY.md` |
| Planning | `ax-orchestrator.mjs` + `ax-providers.mjs` | planner can only name adapters the worker has; budget charged per call |
| Memory | `ax-memory.mjs` + `d1-ax-memory-repository.mjs` | kinds + provenance + versioned compare-and-set |
| Scheduling | `scripts/nexus-tick.mjs` | one-shot process, D1-only state; see `docs/NEXUS_CRON_DEPLOYMENT.md` |
| Approvals | `command-routes.mjs` | owner device token, never a request-body actor |

---

## 2. Workstream A — sandbox security

Implemented: tiered verification, an honest capability report, and a test seam that proves the
fail-closed verdict without weakening a host.

- `scripts/sandbox-check.mjs` → one JSON line: `available`, `reason`, `missing`, `tools`, `limits`,
  and a per-guarantee coverage map. `npm run sandbox:check -- --require` exits `2` if unusable.
- `.github/workflows/nexus-sandbox-security.yml` → runs the portable tier on every push, writes the
  verdict to the job summary, and **warns** when the namespace tier cannot run. It never presents a
  skipped isolation run as proof.
- `tests/sandbox-security-contract.test.mjs` (7 cases) → detection shape, missing-primitive verdicts
  (`hostTools` seam), adapter refusal instead of host fallback, typed `sandbox_unavailable`, concrete
  limits, and a contract that every skip names its missing capability *and* an alternative path.
- `docs/SANDBOX_SECURITY.md` → the guarantee → test map for all eleven required areas, in three tiers.

Not done: Tier 3 (dedicated security host) is documented but not automated, and there is no
GitHub-hosted runner that can run Tier 2 — the runner blocks unprivileged user namespaces
(`namespace probe failed: namespace probe exited 1`). Weakening the runner to force it is explicitly
out of scope.

## 3. Workstream B — execution engine

No new engine was added. The existing engine was already hardened in Missions 05–07; this mission
audited it against the required properties and added nothing that duplicates it.

| Requirement | Evidence |
| --- | --- |
| Submission + idempotency | `universal-command-engine`: "an idempotency key returns the same task", "a concurrent idempotent submission replays the winning row" |
| Claim / lease / fencing | `nexus-fencing-guards`: "the legacy completion path cannot overwrite a live fenced task", "a fenced failed task cannot be requeued out from under its worker" |
| Crash recovery at every write | `ax-orchestrator-lifecycle`: the eleven recovery cases (missing submission, adopted submission, lost run write, orphaned corrective step, conflicting ids) |
| Duplicate prevention | `ax-orchestrator-lifecycle`: "a duplicate cron invocation claims and completes a task exactly once", "repeated recoveries keep one task id" |
| Approval cannot be forged | `ax-orchestrator-lifecycle`: "a persisted approval step is never submitted behind the owner's back"; `command-routes` tests for owner device verification |
| Evidence required | `ax-orchestrator`: "verifyResult never trusts a done task without worker evidence"; "copied evidence from another task does not verify" |
| Cancellation / deadline / retry cap | `universal-command-engine`: "cancellation is explicit", "failure needs a real error and retries are capped" |

## 4. Workstream C — providers and orchestration

New: `ax-providers.mjs` (23 test cases in `tests/ax-providers.test.mjs`).

- `resolveAxProviderConfig(env)` — `AX_PROVIDER` = `openai` (default) | `gemini` | `openrouter`,
  `AX_PROVIDER_FALLBACKS` (ordered, max 3), per-provider key/model/base URL. `AX_PROVIDER` unset
  reproduces the previous OpenAI behaviour exactly (`OPENAI_API_KEY`, `AX_MODEL`,
  `AX_OPENAI_BASE_URL`).
- One request builder for the OpenAI chat-completions shape; per-provider token field and JSON mode
  (`json_schema` for OpenAI, `json_object` for Gemini/OpenRouter).
- Failover only on transient failures (timeout, transport, 408/409/429/5xx). A malformed plan or a
  refused adapter does **not** spend a second provider's credits.
- Costs from every attempt are summed, so failover cannot make the budget unbounded. Calls without a
  usage block are charged `AX_FAILED_CALL_COST_USD` and flagged `estimated`.
- The adapter allowlist is enforced twice: the prompt lists only real adapters, and the planner
  refuses a plan that names anything else (`adapter_not_allowed`) before it can reach the engine.
- An unknown `AX_PROVIDER` is refused rather than silently treated as OpenAI.
- `device-command-bridge.mjs` now builds the planner through this layer; no other call site changed.

Not live-tested: no provider API was called. Every test uses a mock HTTP endpoint, which is a
simulated *transport*, not a verified Gemini/OpenRouter account.

## 5. Workstream D — persistent memory

New: `ax-memory.mjs` (validation, credential scan, conflict rules), `d1-ax-memory-repository.mjs`
(additive schema + versioned compare-and-set), `ax-memory-import.mjs` (ChatGPT export → candidates).

- Nine kinds; `verified_fact` is reserved for owner writes. An import always produces `claim`.
- Provenance is required (`source` ∈ owner | ax | import | system, plus actor, ref, observedAt).
- Credential patterns (OpenAI/GitHub/Slack/AWS keys, private keys, bearer tokens, JWTs, assigned
  secrets) are refused with `contains_credential`, before SQL.
- Versioning: every write appends to `habitat_ax_memory_revisions`; deletion is a status change plus
  a revision, owner-only, and requires the current version.
- Conflict detection: a missing `expectedVersion` on an existing row is refused; a stale version is
  refused with the current row; a kind change is refused unless explicitly allowed; an identical
  rewrite is an idempotent no-op.
- Concurrency: the write is a conditional `INSERT … WHERE NOT EXISTS` / `UPDATE … WHERE version = ?`
  with `RETURNING`, so of two concurrent writers exactly one wins. (The first draft used
  read-then-write and the concurrency test caught it; that is why the test exists.)
- Import pipeline: user messages only, minimum length, per-conversation cap, duplicate-statement
  detection, secrets rejected, nothing written without explicit `approvedIds`, existing keys skipped
  so a re-import never overwrites an owner correction.

Not done: the memory store is not yet mounted in the server or read by the Ax planner. The planner
does not currently receive retrieved memory; that is the next integration step and is not implied by
the tests.

## 6. Workstream E — scheduling and background operation

Existing and unchanged: `scripts/nexus-tick.mjs` is a one-shot process (no timer, no socket) whose
state is entirely in D1, so a Render Free web service sleeping cannot stop execution. Exit codes are
the operational signal: `0` ok, `1` failed, `2` queue stale past `NEXUS_STALE_QUEUE_SECONDS`, `3` not
runnable. `readQueueHealth` reports live/stale workers and waiting work; leases expire and are
reclaimed; retries are capped by `maxAttempts`.

`docs/NEXUS_CRON_DEPLOYMENT.md` specifies the continuous-execution option (Render Cron Job, ~$1/month
minimum) and states that nothing has been created. A GitHub Actions scheduled workflow is a $0
alternative with schedule jitter; it is not implemented here.

Not implemented: push notifications for failures or approval requests. Failures surface through the
tick's non-zero exit, `runtime.health`, and the task/run APIs; approval requests are visible on the
task record. Anything that implies a notification channel exists would be false.

## 7. Workstream F — control center contracts

No UI was changed. The contracts the center needs already exist: `GET /ax/command/runs`, `/runs/:id`,
`/events`, `/tasks`, `/tasks/:id`, `/ax/command/presence` (worker health, queue), `/ax/command/tools`,
`/ax/command/roles`, plus `/health`'s read-only `nexus` block. The provider layer adds a status-safe
`describeProviderStatus` summary (names, models, configured flags — never a key) for budget/provider
panels.

Memory has a repository and a `stats()` shape, but no route yet, so no control-center surface should
claim memory features.

## 8. Workstream G — end-to-end verification

The end-to-end path (owner command → plan → approval → submit → execute → persist → verify →
answer) is exercised by `tests/ax-native-orchestrator.test.mjs` with the real engine, real D1-shaped
storage, real adapters and a real NEXUS tick. Only the model transport is mocked.

| Scenario | Covered by |
| --- | --- |
| Normal completion | `ax-native-orchestrator`: "AX receives an objective …" |
| Worker crash / restart | `ax-orchestrator-lifecycle`: "a run abandoned by a crashed driver converges from its task rows on read" |
| API / model timeout | `ax-orchestrator-lifecycle`: "a model timeout is charged and recorded as a failure" |
| Provider failure | `ax-providers`: HTTP 500 → failover; all down → `providers_exhausted` |
| Database failure | `nexus-tick`: "an unreachable database exits 1 with the real error"; `ax-orchestrator-lifecycle`: "a run that cannot be persisted fails loudly" |
| Duplicate request | `universal-command-engine`: idempotency cases |
| Concurrent requests | `ax-orchestrator-lifecycle`: "two concurrent drivers cannot overwrite each other" |
| Stale worker | `nexus-fencing-guards`: fenced completion/failure cases |
| Missing adapter | `nexus-mainline-integration`: "an unregistered adapter fails the task instead of fabricating completion" |
| Approval required | `universal-command-engine`: "a step whose tool is approval gated parks the task" |
| Approval denied | `universal-command-engine`: "approval moves the task to working and a denial fails it honestly" |
| Cancellation | `universal-command-engine`: "cancellation is explicit" |
| Deadline exceeded | `ax-orchestrator-lifecycle`: "a deadline stops the driver"; `nexus-tick` exit 2 |
| Service restart | the recovery cases above |
| Memory retrieval | **not covered end to end** — the store is tested, the planner does not read it yet |
| Memory update + conflict | `ax-memory`: "a stale writer cannot overwrite a newer decision", history and deletion cases |
| Budget exhaustion | `ax-orchestrator-lifecycle`: `budget_exceeded` cases; `ax-providers`: summed failover cost |

## 9. Test inventory (this mission)

| File | Cases | Tier |
| --- | --- | --- |
| `tests/ax-providers.test.mjs` | 23 | portable, mocked transport |
| `tests/ax-memory.test.mjs` | 14 | portable, SQLite behind D1 shape |
| `tests/ax-memory-import.test.mjs` | 8 | portable, SQLite behind D1 shape |
| `tests/sandbox-security-contract.test.mjs` | 7 | portable + fail-closed |

## 10. Remaining risks

1. **Sandbox isolation is not proven on GitHub runners.** The namespace tier runs only on a capable
   host. Recorded in every skip and in the workflow summary.
2. **No live provider call.** Request shapes, failover and cost accounting are tested; an account,
   quota and real latency are not.
3. **Memory is not wired into planning.** Durable store and import exist; Ax does not yet retrieve
   from it, so "memory-informed planning" is not claimed.
4. **No push notifications.** Failures are observable, not pushed.
5. **D1 is unverified live.** No production or staging database was contacted.
6. **One task engine only.** `habitat_tasks`, `habitat_command_tasks` and `habitat_ax_runs` remain
   separate by design; nothing here parallelises them.
