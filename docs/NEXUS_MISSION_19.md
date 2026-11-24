# NEXUS Mission 19 — readiness, live verification and gap closure

Branch: `ax-nexus/revision-4.6-nexus-mainline-integration` (PR #93, **not merged**)
Starting head: `8b5b168` (Mission 18 evidence; CI 6/6). This mission adds runtime fixes and two
operator tools on top of it. Nothing was deployed, merged, reconfigured or spent.

| Phase | Status | Evidence |
| --- | --- | --- |
| 1. Verify latest code | **COMPLETE** | head, Mission 17/18 presence, CI, 759/759 tests, conflict/security review |
| 2. Prepare deployment | **PREPARED, BLOCKED** | live origin is Mission 16; exact commit deploy steps and rollback below |
| 3. Automated verification | **COMPLETE (tool), live run recorded** | `npm run verify:deployment` → `OUTDATED` with JSON evidence |
| 4. Runtime activation checklist | **COMPLETE (checklist)** | §4; no production change made |
| 5. First live mission | **PREPARED, BLOCKED** | `npm run mission:live`; cannot run without deploy + token |
| 6. Gap removal | **PARTIAL (safe fixes shipped)** | interruptible stop, durable revocation, audit bug, deployment identity |
| 7. Continuous progress | **FOLLOWED** | independent work completed; one owner action recorded once |

## 1. Phase 1 — verification of the latest code

| Check | Result |
| --- | --- |
| Branch head at start | `8b5b168ea3dc79d604b1c8a4729f82752016fe7e` |
| CI on that exact commit | **6/6 SUCCESS** — test, syntax, verify, d1-repository, backend-regression, sandbox guarantees |
| Mission 17 present | `ax-work-cycle.mjs`, `ax-mission-plan.mjs`, `work` / `work/stop` / `agents/revoke` routes, Director + Verification roles |
| Mission 18 present | `docs/NEXUS_MISSION_18_LIVE_READINESS.md`, `scripts/live-readiness.mjs`, `release/mission-18-live-readiness.json`, release-gate wiring |
| Full suite | **759/759 pass** (`npm test`) |
| Static check | `npm run check` exit 0 |
| Schema harness | `npm run migrations:check` 22/22 |
| NEXUS readiness | 14/14 |
| Release gate | passes |
| Conflicts | `git merge-tree HEAD origin/main` exit 0; `origin/main` is an ancestor of HEAD; no conflict markers |
| Secrets | no literal credentials in the new scripts or tests; tokens are environment-only and never written to evidence |

### Defects found and fixed in this mission

1. **Audit events were silently dropped.** The work cycle recorded `agent.revoked` and
   `work.stop_requested`, but neither was an allowed `SECURITY_CATEGORIES` value, so `record()`
   returned `invalid_security_category` and the audit trail lost the event. Both are now valid
   categories, together with `agent.restored` and `work.interrupted`.
2. **A stop could not interrupt an in-flight agent.** The cycle waited for the agent to return.
   It now races the agent call against an `AbortController`; the unfinished result is discarded and
   never persisted, and the run resumes at the interrupted step. Engineering checks are killed at
   the process-group level when the signal aborts.
3. **Revocation was process-local.** A restart cleared it. Revocation and restoration are now
   hash-chained security events, reloaded once per process; `agents/restore` is the explicit,
   audited way back. Without a readable audit log the response reports `durable:false` instead of
   pretending.
4. **A resumed run could be blocked by its own stop.** If the stop and the resume landed in the same
   millisecond, the timestamp comparison refused the resumed run. Recovery now records a
   `work:resume:` marker that consumes the earlier stop.
5. **The deployment could not identify itself.** `/health` now reports a non-sensitive `commit`
   (`RENDER_GIT_COMMIT`, `GIT_COMMIT` or `HABITAT_COMMIT`) and `startedAt`, so an outdated build is
   detectable without a credential.

Route inventory is now 88 (`agents/restore` added). The ChatGPT-facing OpenAPI document is
deliberately unchanged: the contract excludes operator routes (`agents`, `objectives`, `scheduler`,
`work`) with recorded reasons, so its 10 operations stay correct.

### Deployment recommendation

Deploy **the branch head that contains this document** — it is `dfcfcf7` plus Mission 18 evidence
plus the tested fixes above. Confirm the exact SHA with `git rev-parse HEAD` on this branch and use
that value in the Render "deploy a specific commit" field. `dfcfcf7` is the minimum for the Mission
17 routes, but it predates the health commit field and the restore route, so it verifies as
`UNKNOWN` rather than `CURRENT`; deploy the head. Anything older omits Mission 17 entirely.

## 2. Phase 2 — deployment preparation

The live origin is **still Mission 16**, proven by the verifier in §3: `/health` answers 200 with
`version 0.5.0` and `commit: null`, the OpenAPI document has 10 operations, and all three Mission 17
routes answer **404** (absent), while Mission 14–16 routes answer 401 (present, guarded).

- Mission 17 routes are in the recommended commit (registered in `command-routes.mjs`, exercised by
  the suite, and no longer omitted from the route count).
- D1 compatibility: **no migration is added**. Mission 17 and Mission 19 use existing tables;
  Mission 18's audit found zero referenced-but-missing tables. No data rewrite or reset is involved.
- Render injects `RENDER_GIT_COMMIT`, so the new `/health.commit` becomes populated by the deploy
  itself; no environment change is needed for verification.

**Manual deployment (owner action):**

1. Render → Habitat service → Manual Deploy → Deploy a specific commit → paste the branch-head SHA.
2. Do not merge PR #93; do not deploy `main`.
3. Do not run migrations (there are none); do not change environment variables in this step.
4. Verify: `npm run verify:deployment -- --expect-commit <sha>` must print `status: CURRENT`.
5. **Rollback:** redeploy the previous commit from the dashboard. No data rollback is required
   because the schema is unchanged.

## 3. Phase 3 — automated deployment verification

`scripts/verify-deployment.mjs` (`npm run verify:deployment`) checks `/health`, the OpenAPI document,
and the Mission 17 routes, records version/commit, and writes machine-readable JSON.

Its central distinction: **404 = route absent; 401/403 = route deployed and guarded**; 400/409 = route
present and reached. A missing commit is reported as `UNKNOWN`, never as a pass. Exit code 0 means
`CURRENT`; anything else exits 1 so CI or an operator can gate on it. The token is read from
`HABITAT_AX_COMMAND_TOKEN` and never written to evidence; authenticated probes are read-only
(`presence`, `agents`) and the revoke/work routes are never called with a credential.

Actual live run (2026-11-22, unauthenticated):

| Field | Value |
| --- | --- |
| status | **OUTDATED** |
| version | 0.5.0 |
| observed commit | `null` (pre-Mission-19 build reports none) |
| Mission 17 present | **false** |
| missing routes | `work`, `work_stop`, `agents_revoke` |
| OpenAPI operations | 10 |
| evidence | `release/mission-19-deployment-verification.json` |

Tests: 9 cases covering current/outdated/unknown/unreachable states, commit abbreviations, the
401-vs-404 distinction, non-HTTPS refusal, and the rule that a missing commit never becomes a pass.

## 4. Phase 4 — safe runtime activation checklist

No production variable was changed. Every item is owner-authorized.

| Variable / subsystem | Required value | Why | Verification |
| --- | --- | --- | --- |
| `AX_AGENT_LOCAL_ROOT` | service checkout, e.g. `/opt/render/project/src` | mounts the real read-only research and engineering transports; without it those steps block as `capability_unavailable` | `GET /ax/command/agents` → `research`/`engineering` available |
| `NEXUS_RUNTIME_ENABLED` | `true` (mission request) | starts the in-process executor; the fenced lease prevents double execution, but running it alongside an Actions tick is redundant — choose one executor | `/health` → `nexus.configured=true`, `nexus.started=true` |
| D1 connectivity | existing credentials | durable objectives, evidence, messages, audit | authenticated `GET /ax/command/objectives`; a created objective is readable after restart |
| Agent capabilities | 9 roles | Director/Verification plus specialists | `GET /ax/command/agents` |
| Scheduler auth | `AX_SCHEDULER_TOKEN` (or Ax token) | `POST /ax/command/scheduler/tick` | 401 without a credential; 200 with `trigger` |
| Ax command bridge auth | `HABITAT_AX_COMMAND_TOKEN` | every objective, message and work route | 401 without it; 200 with it |

Order: deploy → `/health` → agents → presence → scheduler status → one objective create/read. Stop
if any check reports unavailable; do not "fix" it by enabling side-effecting adapters.

## 5. Phase 5 — first live mission (prepared)

`scripts/live-mission.mjs` (`npm run mission:live`) submits the harmless read-only objective through
the real API, plans it across `memory → research → security → verification`, asks the scheduler to own
it, polls the durable objective, and records every endpoint response:

```bash
HABITAT_AX_COMMAND_TOKEN=... npm run mission:live -- --json release/mission-19-live.json
# after a Render restart:
HABITAT_AX_COMMAND_TOKEN=... npm run mission:live -- --objective <id>
```

Objective: *Research the README.md evidence in this repository and audit the adapter allowlist*, with
criteria *Repository evidence cites README.md with evidence* and *The adapter allowlist was audited*.
Budget ceiling `$0.05`; the deterministic plan makes no model call.

It refuses without a token, refuses to report an `executing` objective as a success, and refuses a
completion whose verification did not pass. **It was not run: the live service does not have Mission
17 or the token, so any result would be fabricated.** Tests cover the endpoint sequence, the
post-restart read, and token non-disclosure.

## 6. Phase 6 — remaining autonomy gaps, prioritized

Shipped now (safe, tested, no production change): interruptible stop, durable revocation/restoration,
audit-category bug, deployment identity, abortable engineering checks.

| Gap | Risk | Proposed next step |
| --- | --- | --- |
| Model-backed planning | Medium: cost and non-determinism | Director calls a provider with a JSON schema and a hard cost ceiling, falling back to deterministic routing on refusal; tests use a fake client |
| Real web research | Medium: SSRF and untrusted content | Injected search transport (owner-provided key), HTTPS-only, bounded redirects, no private IPs, citations kept as data |
| Engineering write sandbox | High: the only path that writes | Isolated worktree, approval record, time/size limits, allowed checks, diff + test evidence, discard path; never the deployed checkout |
| Durable cross-service agent communication | Low–Medium | Messages and audit are already durable in D1; the remaining work is NEXUS-side consumption/acknowledgement of Ax messages |
| Render sleep / restart recovery | Medium: interrupted runs | Startup sweep that marks orphaned leases and a tick that recovers interrupted objectives; the durable stop/resume markers already exist |
| Stop cannot cancel a completed HTTP response | Low | The control now returns promptly; the abandoned call is bounded by the agent timeout |

## 7. Owner actions

1. Deploy the branch head (§2) — the only blocker for Phases 2, 3-live and 5.
2. Authorize and set `AX_AGENT_LOCAL_ROOT` and `NEXUS_RUNTIME_ENABLED`, then restart.
3. Run `mission:live` with the Ax token held outside chat, and send back only the **non-secret**
   report (`release/mission-19-live.json`), or authorize a follow-up where I do it.
4. After a restart, run `mission:live --objective <id>` to capture restart-survival evidence.

No fabricated success is claimed: the live service remains the Mission 16 build, no objective has been
submitted, and no runtime configuration has been changed.
