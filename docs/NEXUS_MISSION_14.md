# NEXUS Mission 14 — complete the system

**Verdict: the code side of Mission 14 is complete and locally verified. Habitat is not operable in
production yet, because staging credentials, Render settings and a physical phone are owner-only and
were not available. Do not merge or deploy on the strength of this document alone.**

- Base head: `216f9ebb146a2a391d47f447937dd327c90955d5` (PR #93, draft, clean).
- Evidence levels in this report: **implemented**, **locally tested**, **CI verified** (after the
  workflows on the final head), **staging verified: none**, **physically device verified: none**,
  **production verified: none**.
- No production D1, Render environment, secret, deployment, purchase, refund, phone action or merge
  occurred.

---

## 1. What was actually completed

| Deliverable | State | Proof |
| --- | --- | --- |
| Ax ↔ NEXUS message channel | implemented, locally tested | `ax-message-channel.mjs`, `d1-ax-message-repository.mjs`, migration 0006, 9 tests |
| NEXUS → Ax questions and approval requests | implemented, locally tested | `ask`/`answer` routes, channel tests |
| Correlation-id thread retrieval | implemented, locally tested | `GET /ax/command/messages/thread/:correlationId` |
| Autonomy pass on the scheduler tick | implemented, locally tested | `ax-scheduler.mjs` + `runAutonomy` in `device-command-bridge.mjs` |
| Autonomous policy (risk/permission/approval) | implemented, locally tested | `ax-objective-dispatch.mjs`, E2E test 3 |
| Shared objective dispatch | implemented, locally tested | `ax-objective-dispatch.mjs` |
| Retry, dead-letter, duplicate-execution protection | implemented, locally tested | channel tests, E2E restart test |
| Audit of every message transition | implemented, locally tested | security categories + E2E audit assertions |
| Release gate inputs for Mission 14 | implemented | `scripts/release-gate.mjs` |
| Android rebuild after lifecycle/IME fixes | compiled, **not physically verified** | `docs/ANDROID_MISSION_14_DEVICE_TEST.md` |
| Documentation set | written | five Mission 14 documents + runbook + render readiness |

## 2. What is now connected (locally, through the real composition root)

`registerDeviceCommandBridge` mounts the channel, the command engine, the NEXUS runtime, the
objectives service, the scheduler and the security log on one D1-shaped database. The E2E suite
proves this sequence:

```
Ax submit → durable row → authenticated acknowledgement → command engine task
→ NEXUS tick executes read-only adapter → evidence → message completed
→ correlated thread retrieval → audit entries → restart reconstruction → no duplicate
```

That is a genuine integration test, not a unit-test collage: the HTTP handlers, the engine, the
worker claim, the adapter and the stores are the production implementations.

## 3. What is local or simulated

- **Model transport**: a fixture returns a fixed plan. No OpenAI/Gemini/OpenRouter call, no spend.
- **Database**: `node:sqlite` behind a D1-shaped transport. It proves SQL shape and idempotence, not
  D1 parity.
- **Deployment**: none. No Render change, no cron job, no live health probe.
- **Ax client**: none. This ChatGPT session has no connector and cannot reach a private server.
- **Phone**: none. The APK is build-only.

## 4. What is staging verified

Nothing. `docs/STAGING_VALIDATION_RESULTS.md` remains `Staging status: NOT RUN — owner-blocked`,
with the harness refusal recorded. Migration 0006 was **not** applied to any D1 database.

## 5. What is production verified

Nothing. No production database, service, secret or environment was read or changed.

## 6. Can Ax communicate with NEXUS directly?

**Not through this ChatGPT session, and not against a deployment yet.** The protocol, credentials,
persistence, idempotency, correlation and retrieval are built and locally proven. To make it real,
an owner must deploy the service and either create a workspace Action from
`/ax/command/openapi.json` or run an Ax client with the Bearer token. This is stated in
`docs/AX_NEXUS_COMMUNICATION.md` §7 and is not something the repository can do on its own.

## 7. Can NEXUS execute tasks without manual intervention?

**Yes for the permitted class, when a trigger exists.** A scheduler tick drains queued messages,
submits them to the engine, reconciles real task state, completes them with evidence, retries
retryable failures, dead-letters after three attempts, and starts low-risk objectives that need no
approval. It cannot approve anything, cannot complete an objective, cannot use a side-effecting
adapter, and cannot run while nothing triggers a tick.

## 8. Is Habitat ready to deploy?

| Dimension | Answer |
| --- | --- |
| Code shape, tests, migrations, gate | ready pending CI on the final head |
| Staging evidence | **no** — never run |
| Render configuration | **unknown** — not inspected live |
| Ax connection | **no** — no deployed origin, no connector |
| Android physical pairing | **no** — build only |
| Production | **not authorised, not attempted** |

**Decision: keep PR #93 open and draft. Deploy only after the owner steps in §9, then re-run the
gate on the deployed commit.**

## 9. Exact owner actions remaining

1. **Staging (20 min)** — create a disposable D1, apply 0001–0006, set the six staging variables,
   run `staging:demo write` then `verify` in a second process. Runbook §1.
2. **Render (15 min)** — deploy the validated commit, add `AX_NEXUS_TOKEN`, confirm the variable
   list, decide on a cron job. Runbook §2.
3. **Ax (10 min)** — create the Action in a managed workspace, or point an external Ax client at the
   API. Runbook §3.
4. **Android (20 min)** — install the APK, run the 15 checks, record model/serial hash/timestamps.
   Runbook §4 and the Android sheet.
5. **Close-out** — re-run `npm run release:gate`, commit the manifest, re-run with `--check`, update
   PR #93, then decide on merge.

## 10. Commit and PR state

Validated code commit: `282da02b0e77ce2a6dfc9a542cdbf9036e5a1a4a`. The release record that follows
it changes only `release/` and `docs/`, and the gate is re-run with `--check` on that head.
PR #93 stays **open, draft and clean**. No merge, force-push or history rewrite was performed.

CI: **six checks green on `113e298`** — `syntax`, `test`, `verify`, `backend-regression`,
`d1-repository`, `sandbox guarantees`; all `success`, observed 2026-11-22T05:13:45Z.

Local verification on that commit: `npm run check` exit 0; `npm test` 703/703; migration checks
22/22; release gate 13/13 checks, `releaseReady: true`; Android build successful
(`e20a0729…`, 908,446 bytes). Only Node 26.13.1 was available in this environment for Mission 14;
Node 22 was used in Mission 13 but was not re-run here.

## 11. Known limitations carried forward

- Delivery is at-least-once; only read-only adapters are allowed.
- A crash between a paid model response and its persistence can under-report one call.
- Autonomy depends on a trigger; a sleeping Free service is not continuous.
- Dead-lettered messages need an owner decision to requeue.
- The research and engineering agents need `AX_AGENT_LOCAL_ROOT`; research is repository research,
  not internet research.
- Migration 0006 is SQLite-validated only.
