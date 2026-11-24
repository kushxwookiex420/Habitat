# NEXUS Mission 09 — integration, operational intelligence and control center

This document records what Mission 09 actually connected, what the tests exercise, and what remains
unverified. It is deliberately narrower than the mission brief: a capability is listed as integrated
only when a test drives it through the real application path.

Starting commit: `d20a7cc921d934f9d81ca40327f94e6730899439` on
`ax-nexus/revision-4.6-nexus-mainline-integration`, PR #93 (draft).

---

## 1. Status vocabulary

The mission requires these to stay distinct, so every claim below uses one of them:

| Term | Meaning here |
| --- | --- |
| **Implemented** | Code exists and is reachable from the running service |
| **Unit tested** | A test exercises the module directly |
| **Integration tested** | A test drives the real route → orchestrator → engine → worker → store path with only the model transport mocked |
| **Live tested** | A real external account or database was contacted — **not claimed anywhere in this mission** |
| **Deployed** | Running on Render or a production database — **not done** |
| **Independently verified** | Reviewed by someone other than the author — **not done** |

---

## 2. Architecture — before and after

Before Mission 09 the pieces existed but were not connected:

```
/ax/command/runs ──> orchestrator ──> engine ──> tick ──> adapters
                          │
                          └── provider planner          memory store (unread)
                                                       notification: none
                                                       UI: marketing pages + Android overlay
```

After Mission 09:

```
 owner / phone ──┬── /control (mobile web UI, WebGL neural brain)
                 │        │ session-scoped Ax command token
                 │        ▼
                 └── /ax/command/* ─────────────────────────────────────────────┐
                          │                                                      │
        ┌─────────────────┼──────────────────┬───────────────────┬──────────────┐│
        ▼                 ▼                  ▼                   ▼              ▼│
   orchestrator      memory routes      notifications      diagnostics     history/recovery
        │                 │                  │                   │              │
        │  recall         │                  │                   │              │
        ├──────────► habitat_ax_memory ──────┼───────────────────┼──────────────┤
        │  verified write-back               │                   │              │
        │                                    ▼                   │              │
        │                          habitat_ax_notifications      │              │
        │                                                          │              │
        ├── provider failover (openai | gemini | openrouter)       │              │
        ├── engine.submit ──► habitat_command_tasks ◄── tick ──► adapters        │
        └── run record ─────► habitat_ax_runs ────────────────────┴──────────────┘
```

The task engine did not change. `habitat_tasks`, `habitat_command_tasks` and `habitat_ax_runs`
keep their existing responsibilities; memory and notifications are new additive stores.

| Boundary | Module | Rule |
| --- | --- | --- |
| Planning | `ax-providers.mjs` | provider priority, transient-only failover, summed cost, adapter allowlist |
| Memory → prompt | `ax-memory-context.mjs` | active rows only, provenance + confidence, labelled untrusted data, bounded |
| Memory store | `d1-ax-memory-repository.mjs` | conditional SQL compare-and-set, append-only revisions, owner-only delete |
| Execution | `universal-command-engine.mjs` + `nexus-runtime.mjs` | one task store, lease + fence + evidence digest |
| Events | `ax-notifications.mjs` + `d1-ax-notification-repository.mjs` | idempotent dedupe key, bounded retries, inbox only |
| History | `mission-history.mjs` | pure projection from durable run + notification records |
| Diagnostics | `ax-diagnostics.mjs` | probe results, explicit `unchecked`/`not_configured`, no secrets |
| Control center | `control-center.mjs` | public shell, authenticated data, no placeholder state |

---

## 3. Workstreams

### A. Durable memory is now in the Ax planning path

- `createAxOrchestrator` accepts a `memory` context. `planPhase` recalls **before** the model is
  called, records `run.memory = { used, recalled, context, citations, kinds, error }`, and passes the
  context to the planner. A recall failure sets `run.memory.error` and planning continues.
- Only `active` rows are readable. An imported conversation becomes active only after
  `applyMemoryImport` receives explicit `approvedIds`, so an unapproved import cannot influence a plan.
- Each context line carries kind, source, confidence and version. Verified facts and unverified
  records are separate sections, and the block states that it is data, not instructions.
- After a **verified** completion (including one settled by reconciliation) the run writes one
  `status` record keyed by `run:<id>`. A memory write failure is recorded on the run, never thrown.
- Routes: `GET /ax/command/memory`, `/memory/search`, `/memory/stats`, `/memory/:project/:key`,
  `/memory/:project/:key/history`; `POST /ax/command/memory` (Ax, never `verified_fact`),
  `POST /ax/command/memory/owner` (owner device proof, may write `verified_fact`),
  `POST /ax/command/memory/:project/:key/delete` (owner only, current version required),
  `POST /ax/command/memory/import/preview` and `/import/apply` (owner approval required; candidates
  are re-derived on the server, so a client cannot supply its own content).

### B. Provider system is the real orchestrator planner

`device-command-bridge.mjs` builds the planner with `createAxPlannerFromProviderConfig`. Provider
priority, ordered fallbacks, transient-only failover and summed costs are unchanged from Mission 08;
what changed is that the planner now receives retrieved memory, and an unconfigured **primary** no
longer disables Ax when a configured fallback exists (the failover planner skips keyless providers).
`GET /ax/command/providers` reports configuration and explicitly marks health `checked: false`.

### C. One durable task engine

Ax still submits through `universal-command-engine` only. Run ids are deterministic from `runKey`;
step task ids are derived from the idempotency key before submission; a resume adopts the existing
task instead of creating a second one. Completion still requires the engine's evidence digest,
worker identity and attempt match. `GET /ax/command/history` projects missions from durable run rows
and notifications; `GET /ax/command/recovery` reports unsettled runs and open steps read-only.

### D. Recovery, scheduling and notifications

- The one-shot tick is unchanged and remains the scheduler. Recovery is still the lease path plus
  orchestrator reconciliation from task rows.
- New durable events: `run.completed`, `run.failed`, `run.budget_exceeded`, `run.needs_approval`,
  `run.recovery`, plus task/system types. The dedupe key `run:<id>:<type>` makes recording idempotent.
- The only implemented channel is `inbox`: the event is a D1 row surfaced by
  `GET /ax/command/notifications`. `deliverPending` supports an injected external transport with a
  bounded attempt count; **no push, email or SMS provider is configured or claimed**.
- No Render service, cron job or paid resource was created.

### E. Control center

`GET /control` serves a dependency-free, mobile-first page with seven sections — Chat, Workers,
Tasks, Memory, Approvals, Missions, Health. It renders a WebGL point-cloud brain (two hemispheres
with a sagittal gap, cerebellum, brainstem and synapses) that rotates and pulses, and honours
`prefers-reduced-motion`. There is no framework, CDN or build step.

The page itself is public and contains no data. Every value comes from the authenticated routes with
an Ax command token the owner enters; it is kept in `sessionStorage` only. Missing token, 401, 503
and network failure each render as themselves. Owner actions (approval, memory deletion) require the
paired device credential, entered in the Memory panel and also session-scoped.

**Android app: unchanged.** The native overlay was not modified because this environment has no
Android SDK, and an uncompiled Kotlin UI change would be unverified. The control center is reachable
from the phone browser at `/control`. Wiring it into the native overlay is the obvious next step and
is listed as a limitation, not as done.

### F. Security and approval boundaries

- Adapter allowlists are unchanged; the planner still cannot name an adapter the worker lacks.
- Credentials are refused by the memory validator before SQL, and diagnostics never read secret
  values. Notification bodies are redacted.
- `verified_fact` is owner-only. The Ax command token cannot satisfy any owner action even with a
  valid device header; the device-capable bridge token still needs real device proof.
- Imported text is labelled as untrusted data in the prompt and is stored as `claim`; approval makes
  it accepted context, never a verified fact.
- Approval records remain durable in the task lifecycle; no route was added that approves, denies or
  closes a fenced task without owner proof.
- The sandbox was not weakened. `docs/SANDBOX_SECURITY.md` remains accurate.

### G. End-to-end verification

`tests/ax-mission-integration.test.mjs` drives the whole path with only the model transport mocked.

| # | Scenario | Evidence |
| --- | --- | --- |
| 1 | Command retrieves approved memory | integration: `command → memory → provider fallback …`, asserts citations and context |
| 2 | Ax plans through the provider abstraction | same test: OpenAI 500, Gemini answers |
| 3 | Missing primary provider falls back | integration: `provider status …` (keyless primary, configured fallback) |
| 4 | Budget enforced across attempts | integration: `the run budget counts every provider attempt` |
| 5 | Plan submits through the task engine | same end-to-end test: one `habitat_command_tasks` row |
| 6 | Duplicate submissions create no duplicate work | integration: `the same run key and idempotency key …` |
| 7 | Sensitive action enters approval state | integration: `a plan step that needs approval parks the run` |
| 8 | Unauthorized action rejected | integration: `memory, approvals and diagnostics reject …` |
| 9 | Approved task executes through the adapter | end-to-end test: `runtime.health` through the real tick |
| 10 | Evidence collected and verified | end-to-end test: step `verified`, evidence non-empty |
| 11 | Verified result updates memory | end-to-end test: `run.memoryUpdate.ok`, `run:<id>` row |
| 12 | Memory conflicts handled | `ax-memory`: stale-version and concurrency cases (Mission 08) |
| 13 | Interrupted work recovers after restart | integration: `a run abandoned by its driver …` |
| 14 | Notifications recorded and retried safely | `ax-notifications`: dedupe, retry, attempt ceiling |
| 15 | Unauthorized users cannot read memory/approvals | integration: 401 without token, 403 for command token as owner |
| 16 | Secrets never in diagnostics | `ax-diagnostics` and integration serialized-response assertions |
| 17 | Control center shows real state | `control-center`: every panel calls an authenticated route, no seeded data |
| 18 | Mission reconstructed from durable history | end-to-end test: `GET /ax/command/history` |

### H. Diagnostics

`GET /ax/command/diagnostics` returns: application version and commit; database reachability;
memory repository status and counts; provider configuration with health explicitly unchecked;
orchestrator state; worker/heartbeat/queue; scheduler mode; sandbox capability; notification status
and channel; device bridge state. Probes are individually wrapped, so one outage cannot turn the
whole report into a false green. `/health` stays public and only adds the version and `/control` link.

---

## 4. Test inventory

| Suite | Cases | Tier |
| --- | --- | --- |
| `tests/ax-memory-context.test.mjs` | 8 | portable, SQLite behind the D1 shape |
| `tests/ax-notifications.test.mjs` | 8 | portable, SQLite behind the D1 shape |
| `tests/ax-diagnostics.test.mjs` | 4 | portable, injected probes |
| `tests/control-center.test.mjs` | 6 | portable, served bytes |
| `tests/ax-mission-integration.test.mjs` | 8 | integration, mocked model transport only |
| `tests/command-routes.test.mjs` | 18 | existing suite, route-surface contract updated |

Full suite: **563 tests**. On this namespace-capable VM: 563 pass, 0 fail, 0 skipped. On
GitHub-hosted runners the 20 namespace-dependent sandbox cases skip with their named missing
capability, as recorded in `docs/SANDBOX_SECURITY.md`.

---

## 5. Database status

Additive only. No production or staging D1 database was contacted at any point.

| Object | Created by | Destructive? |
| --- | --- | --- |
| `habitat_ax_memory` + unique index | repository `initialize()` / `migrations/0003` | no — `IF NOT EXISTS` |
| `habitat_ax_memory_revisions` | same | no |
| `habitat_ax_notifications` + unique dedupe index | same | no |
| `habitat_command_tasks`, `habitat_ax_runs`, `habitat_nexus_workers` | existing | unchanged |

No table was dropped, renamed or altered; no task row was migrated.

## 6. Provider status

| Provider | Configured in tests | Live call made |
| --- | --- | --- |
| OpenAI | mocked transport only | no |
| Gemini | mocked transport only | no |
| OpenRouter | not exercised in Mission 09 | no |

The abstraction and failover are integration-tested; an account, quota and real latency are not.

## 7. Scheduler and notifications

- Scheduler: unchanged one-shot tick; exit codes 0/1/2/3. No Render resource exists.
- Notifications: recorded durably, list/ack routes exist, retries are bounded. No push transport.
- A sleeping free web service still cannot stop execution; it relies on an external scheduler that
  has not been created (owner action).

## 8. Known limitations

1. **No live provider call, no live D1, no deployment.** Every external integration is mocked.
2. **Android native UI unchanged.** The control center is a served mobile page, not an in-app screen.
3. **No push notifications.** Only the durable inbox exists.
4. **Sandbox Tier 2/3** still cannot be proven on GitHub-hosted runners; no restriction was weakened.
5. **Independently reviewed:** no. PR #93 remains open and draft.
6. **Memory retrieval is keyword-based**, not semantic; results are bounded and deterministic, which
   favours reproducibility over recall quality.
7. **The control center was contract-tested, not exhaustively driven.** It was loaded once in a
   browser to confirm the page and brain render; every panel's data path is covered by route tests,
   but interactive owner actions were not clicked through end to end in a browser.

## 9. Owner actions remaining

1. Set `HABITAT_AX_COMMAND_TOKEN` (and optionally `HABITAT_AX_BRIDGE_TOKEN`) on the service.
2. Pair an owner device and set `HABITAT_OWNER_DEVICE_IDS` before using approvals or memory deletion.
3. Set a provider key and `AX_ORCHESTRATOR_ENABLED=true` to allow paid planning; otherwise Ax stays
   off and says so.
4. Run `migrations/0003_ax_memory_notifications.sql` in the D1 console (optional; boot also creates it).
5. Create the scheduler (Render Cron Job or equivalent) if autonomous execution is wanted.
6. Review PR #93 and merge only after independent review.

## 10. Production statement

No production deployment, no production or staging database mutation, no paid resource, no live
customer/commerce/TikTok/Shopify/phone action, and no merge of PR #93 was performed in this mission.
