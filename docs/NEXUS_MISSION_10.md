# Habitat / Ax — Mission 10: Autonomy Breakthrough

Starting commit: `74d6b2cd1b7aa44b91dd2a9be6c07f60d74cb676`
Branch: `ax-nexus/revision-4.6-nexus-mainline-integration`
PR: #93 (open, draft — not merged, not deployed)

This document describes what Mission 10 added, how it connects to Mission 09, and exactly which
claims are proven. Every capability below is labelled:

- **Implemented** — the code exists in this repository.
- **Integrated** — it is wired into the mounted runtime and its routes.
- **Tested** — an automated test in `tests/` exercises it.
- **Live** — it ran against a real external service (provider, D1, phone).
- **Verified** — an independent check reproduced it.

Mission 10 added no live provider call, no production D1 write and no deployment. Claims marked
*not live* below are deliberate, not omissions.

---

## 1. The lifecycle, and why it cannot be faked

Mission 09 could plan, execute and verify a *run*. Mission 10 adds the durable **objective**: the
record of intent that outlives any single run, process or model call.

```
received → understood → planned → awaiting_approval → authorized
         → executing → verifying → completed
```

with `blocked`, `failed`, `interrupted`, `cancelled` and `recovery_required` available from the
states where they are real.

`ax-objectives.mjs` owns the transition table. Two properties are enforced structurally, not by a
prompt:

1. **There is no edge from `planned` or `executing` to `completed`.** The only inbound edge to
   `completed` is from `verifying`.
2. **`complete()` refuses unless every required acceptance criterion has been marked met by an
   evidence check whose evidence ids exist on the objective.** A model that returns "done" has no
   path into either state.

An objective also records:

- its acceptance criteria (at least one concrete criterion is mandatory at creation);
- the plan, including the agent, adapter, approval requirement and estimated cost per step;
- the approval request, the approving owner device and the approval proof id;
- submitted task ids (idempotent: the same task id is never attached twice);
- evidence items with source, task id, digest and timestamp;
- checkpoints, transitions with actor and reason, recovered count, spend and budget;
- the full verification result, including which criteria failed and why.

Writes are compare-and-swap on the stored bytes (`ax-objective-repository.mjs`), so a retried
request, a recovery pass and a cron worker cannot silently overwrite each other.

### HTTP surface (Ax credential required)

| Method | Path | Note |
|---|---|---|
| POST | `/ax/command/objectives` | Create, idempotent by `key` |
| GET | `/ax/command/objectives` | List + counts by state |
| GET | `/ax/command/objectives/:id` | Full record + summary |
| POST | `.../:id/understand` | Constraints, missing information, questions |
| POST | `.../:id/plan` | Steps, agents, estimated cost, permissions, risk |
| POST | `.../:id/request-approval` | AX may ask; it may not approve |
| POST | `.../:id/authorize` | **Owner device only**; derived proof, replay-safe |
| POST | `.../:id/deny` | **Owner device only** |
| POST | `.../:id/start` | Re-checks approval and budget |
| POST | `.../:id/tasks` | Attach a task idempotently |
| POST | `.../:id/evidence` | Add evidence with provenance |
| POST | `.../:id/checkpoint` | Durable checkpoint |
| POST | `.../:id/verify` | Runs the evidence checks |
| POST | `.../:id/complete` | Refused without passing verification |
| POST | `.../:id/fail` | Terminal |
| POST | `.../:id/cancel` | **Owner device only**, terminal |
| POST | `.../:id/recover` | Only from `interrupted` / `recovery_required` |
| POST | `.../:id/dispatch` | Requires `executing`; runs the existing Ax run path with a deterministic run key and attaches its tasks and evidence |

Status: **implemented, integrated, tested (unit + HTTP). Not live** — no objective has been driven
against a production D1 database.

---

## 2. Specialized agents with real bounded work

`ax-agents.mjs` defines seven agents. Each has a capability manifest: permissions, forbidden
actions, approval-gated actions, the dependency it needs, and a distinct handler.

| Agent | Real work it performs | Needs | Available in this deployment |
|---|---|---|---|
| research | Calls an injected search transport and returns sourced notes | search transport | **No** — no transport is configured; returns `capability_unavailable` |
| engineering | Runs the allowlisted read-only adapter path and returns command/exit evidence | sandbox runner | **No** — returns `capability_unavailable` |
| security | Audits the supplied adapter allowlist and reports severity-ranked findings | nothing | **Yes** |
| operations | Probes mounted subsystems through diagnostics | diagnostics | **Yes** |
| memory | Retrieves approved memory and returns citations | memory context | **Yes when D1 memory is configured** |
| content | Builds a draft-only DropPilot / Vice City plan; publishing always gated | nothing | **Yes (draft only)** |
| device | Reports the real phone capability manifest and derived state | device snapshot | **Yes when the bridge is ready** |

Ax reviews every delegated envelope before accepting it: the envelope digest must match its
contents, evidence must be non-empty, confidence must be in range, and a forbidden action cannot be
claimed. A rejected envelope never becomes an accepted fact.

Runaway protection is enforced before any handler runs: maximum depth (2), circular chain rejection,
delegation budget (12 per process), wall-clock limit and a per-delegation cost ceiling. A
delegation is labelled `capability_unavailable` rather than simulated when its dependency is absent.

Status: **implemented, integrated, tested. Not live** — no research or engineering transport exists
in this deployment, and the code says so at runtime.

---

## 3. Provider resilience and decision records

`ax-providers.mjs` gained a **circuit breaker** and a **decision record**.

- Transient failures only (`408/409/429/5xx`, timeout, transport, unconfigured) trigger fallback.
  A malformed plan is not retried elsewhere, because that would spend more credits on the same bad
  answer.
- After `AX_CIRCUIT_FAILURES` (default 3) consecutive transient failures a provider's circuit opens
  for `AX_CIRCUIT_COOLDOWN_MS` (default 60s), then allows one trial.
- Every planner call returns `decision`: which provider was selected, which were skipped
  (`unconfigured`, `circuit_open`), which were attempted (`primary`, `fallback_after_transient_failure`)
  and why each fallback happened.
- The run record stores that decision (`run.providerDecision`), so mission history can explain both
  the choice and the spend.
- Costs from every attempt are summed. The run budget is charged for failures too.

`GET /ax/command/providers` reports configuration, circuit snapshots and the budget policy. Health is
still `checked: false` because no live call is made to answer it.

Status: **implemented, integrated, tested with a synthetic transport. Not live.**

---

## 4. Memory intelligence

Mission 09 already had versioned memory, owner-only verified facts, a gated ChatGPT export importer
and a provenance-labelled planning context. Mission 10 adds read-only intelligence over it
(`ax-memory-insights.mjs`):

- **Freshness policy by kind**: hypotheses are due for review after 14 days, assumptions 30, claims
  and status 90; verified facts, decisions and preferences do not silently expire. Expiry is a review
  reminder, never automatic deletion.
- **Conflict triage**: records on the same topic with substantial lexical overlap and opposing
  polarity (or two authoritative records that disagree) are surfaced as
  `owner_review_required`. Nothing is overwritten.
- **Hybrid lexical ranking**: keyword coverage + kind weight + confidence + recency − staleness. It
  is explicitly **not** semantic retrieval, and the API says so.

Exposed at `GET /ax/command/memory/insights?project=&q=` and in the control center Memory tab.

Status: **implemented, integrated, tested. Not live** (no production memory store was read).

---

## 5. Self-monitoring and safe recovery

`ax-recovery.mjs` scans live probes and records durable, deduplicated incidents:

- scheduler not mounted / mounted but stopped;
- queue unreadable or older than the age limit;
- queued work with no live worker;
- tasks stuck in `working` beyond the lease window;
- failed runs that never settled and runs past their deadline;
- no paired phone, or a phone that has not checked in;
- notifications pending without a transport.

Only reversible actions are permitted: `reconcile_run`, `probe_subsystems`, `start_scheduler`,
`request_device_checkin`, `notify_owner`, `reload_incidents`. The service refuses any other action,
including names that look destructive (`delete`, `deploy`, `migrate`, `revoke`, `rotate`). Each
attempt records what was tried, why, who authorized it, and whether the effect was verified. A repair
that cannot verify its effect leaves the incident open with the attempt attached.

Status: **implemented, integrated, tested. Not live** — the monitor has not run against a production
D1 or Render service in this mission.

---

## 6. Phone bridge: state separation and the pairing screen

The bridge now has a capability manifest and derives eight separate states from durable rows:

`installed` · `registered` · `authenticated` · `connected` · `reachable` ·
`commandAccepted` · `commandExecuted` · `commandVerified`

Each is `yes`, `no` or `unknown` with a basis. `installed` is always `unknown` because the backend
cannot observe it. A completed command receipt is **not** a verification unless the result was
actually checked. The manifest lists `device.notifications.*` and `device.shell` as
`implemented: false` with the permission and approval they would require — the phone agent has no
shell, file, messaging or UI automation path.

`GET /ax/command/device/state` and `/capabilities` expose this; `GET /ax/command/device/pairing/audit`
explains a pairing row (issued, expired, consumed, consumed-without-registration) without returning
the code.

### The reported pairing failure

Source inspection found the pairing dialog already guarded its callback against a dismissed Activity.
The remaining reproducible path to "the screen disappears and does not come back" is Android
recreating `MainActivity` when the keyboard opens or a size/orientation configuration change is
reported: the dialog belongs to the old Activity and is not restored.

Fix, compiled with the project's Gradle toolchain (`:app:compileDebugKotlin` → BUILD SUCCESSFUL):

1. `AndroidManifest.xml` declares
   `configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|smallestScreenSize|uiMode"`
   for `MainActivity`, so those changes no longer recreate it mid-pairing.
2. `MainActivity` tracks whether the pairing dialog is open and restores it after a real recreation,
   with a message that the code must be re-entered.
3. The Pair button re-enables after 30 seconds if no network callback arrives, so a lost response
   cannot leave the control permanently disabled.

Status: **implemented, compiled. Not executed on a device** — no Android hardware or emulator is
available in this environment. The pairing exchange itself remains covered by the existing
`device-pairing-recovery` and bridge tests on the server side.

---

## 7. Control center

`/control` now has ten sections: Chat, Workers, Tasks, Memory, Approvals, Missions, **Agents**,
**Device**, **Recovery**, Health.

- **Missions** also lists durable objectives with state, criteria progress and spend.
- **Agents** shows the capability matrix, distinguishing *implemented* from *available right now*.
- **Device** shows each connection state separately, the pairing audit and the phone capability
  manifest (including what is not implemented).
- **Recovery** lists incidents and offers only the reversible action attached to each one; it
  requires the owner device credential from the Memory tab.
- **Memory** gains a health card: stale records, upcoming reviews and possible conflicts.
- The brain's rotation and pulse are driven by the last observed unsettled run count. With none it
  says **idle**; the slow idle rotation is a visual, not a claim of work.
- Navigation is a five-column grid on mobile (two rows for ten tabs), with a taller bottom inset so
  content is not hidden behind it.

Status: **implemented, integrated, contract-tested and HTTP-checked. Visual layout is not
re-verified in a browser in this mission** (no browser UI run was performed for Mission 10).

---

## 8. Security review

| Check | Result |
|---|---|
| Owner-token bypass on approval | Refused: the command token cannot approve; owner device verification is required; the owner list is mandatory |
| Approval replay | Idempotent by derived proof; a second approval returns `replayed`, not a second authorization |
| Objective completion without evidence | Structurally impossible; `verification_required` from `complete()` and no edge from `executing`/`planned` |
| Delegation runaway | Depth, cycle, count, time and cost limits enforced before the handler |
| Agent tampering | Envelope digest, evidence and confidence are re-checked by Ax |
| Secret exposure | Memory refuses credential-shaped writes; diagnostics redact; an HTTP test asserts no token is echoed |
| Cross-user data access | **Not applicable yet**: Habitat is single-tenant. There is no per-user partition, so multi-tenant isolation is not claimed |
| Provider fallback spending | Every attempt is charged; budget is re-checked after each call |
| Destructive recovery | Refused by allowlist and by a destructive-name guard |
| Sandbox weakening | None. `docs/SANDBOX_SECURITY.md` guarantees are untouched; the runtime remains fail-closed |

No critical or high-severity defect was found that could be fixed within this branch's authorization
without weakening a control.

---

## 9. What is not done

- **Objective ↔ run accounting**: `dispatch` attaches run tasks, evidence and a checkpoint to the
  objective, but the run's spend is not automatically charged to the objective's budget, and
  dispatch does not map each acceptance criterion to an evidence check. That mapping stays an
  explicit verification step, which is intentional but means the two budgets are still separate.
- **Research and engineering agents** have no transport in this deployment; they refuse honestly.
- **No semantic memory retrieval**; ranking is lexical.
- **No notification transport**; the inbox is the only channel.
- **No production D1 migration applied**: `migrations/0004_ax_objectives_incidents.sql` is additive
  and idempotent, but no staging or production database was touched.
- **No Android device test** for the pairing fix; it is compile-verified only.
- **No live provider call**, no deployment, no merge.

## 10. Owner actions

1. Deploy `migrations/0004` (or start the service once on a database where the repository is allowed
   to create additive tables) when you want durable objectives and incidents.
2. Configure `AX_CIRCUIT_FAILURES` / `AX_CIRCUIT_COOLDOWN_MS` only if the defaults do not fit.
3. Use the control center's Memory → Owner controls to store the paired device credential; recovery
   and approval actions require it.
4. Review surfaced memory conflicts; only an owner write can correct a verified fact.
5. Test the phone pairing fix on the Galaxy S26 Ultra: open LINK, paste a code, submit, rotate or
   show/hide the keyboard, and confirm the dialog no longer disappears.
