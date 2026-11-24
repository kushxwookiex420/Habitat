# NEXUS Mission 15 — final activation

**Verdict: NO-GO for release. Code, gate and live local channel behaviour are green; Habitat is still
not operational, because the deployed Render service runs older code, no staging database was ever
available, and no physical device or Ax connector exists.**

- Baseline at mission start: `f03f904ea162ab052212987127ec0547aaf67441` — identical to PR #93 head
  and to `origin/ax-nexus/revision-4.6-nexus-mainline-integration`.
- Evidence levels used here: **implemented**, **locally tested**, **live local HTTP (not staging)**,
  **CI verified**, **staging verified: none**, **physically device verified: none**,
  **production verified: none**.
- No production D1 read/write, Render change, deployment, paid resource, secret exposure, merge,
  publication, purchase, refund or phone command occurred.

---

## 1. Baseline re-check (not assumed)

| Item | Observed |
| --- | --- |
| Repository | `kushxwookiex420/Habitat` |
| Branch | `ax-nexus/revision-4.6-nexus-mainline-integration` |
| Head | `f03f904` (local and remote matched) |
| Commits since Mission 13 | `282da02` (channel + autonomy), `113e298` (release record), `f03f904` (CI record) |
| PR #93 | open, draft, mergeable `clean` at baseline |
| CI on `f03f904` | `syntax`, `test`, `verify`, `backend-regression`, `d1-repository`, `sandbox guarantees` — all `success` |
| Release manifest | `releaseReady: true`, commit `282da02`, 13 gate checks |
| Credentials present in this environment | none of the six `STAGING_*` inputs, no Render API key, no Cloudflare/D1 token |

No implementation from Missions 08–14 was found missing or reverted. The only previously unproven
link was a real socket: the Mission 14 E2E drove captured route handlers, not HTTP.

## 2. Ax ↔ NEXUS channel — live HTTP proof

New, reproducible acceptance run:

```sh
npm run activation:live
```

It starts the real composition root (`registerDeviceCommandBridge`) on a real Express server and a
real TCP port in a **separate Node process**, drives it with real `fetch` over `127.0.0.1`, using two
independently generated credentials, then **kills the process and starts a new one over the same
SQLite file**. Execution uses the real one-shot scheduler entrypoint (`scripts/nexus-tick.mjs`).

Result on this commit: **20/20 checks pass, exit 0.**

| # | Check | Result |
| --- | --- | --- |
| 1 | Authenticated presence over HTTP | pass |
| 2 | Ax submits a harmless task; durably queued | pass |
| 3 | Direction assigned by authenticated surface (`from: ax`) | pass |
| 4 | Unauthenticated submission rejected (`401 invalid_token`) | pass |
| 5 | Duplicate idempotency key replays the original id | pass |
| 6 | Ax credential refused on `/ax/nexus/*` (`401 invalid_nexus_token`) | pass |
| 7 | NEXUS acknowledges with its own credential | pass |
| 8 | Scheduler tick drains and dispatches (`submitted: 1`) | pass |
| 9 | Message `working` with a bound `cmd_…` task | pass |
| 10 | Real NEXUS tick claims and executes the read-only adapter | pass |
| 11 | Second tick completes the message from real evidence | pass |
| 12 | Ax retrieves the completed result by correlation id | pass |
| 13 | No decision left pending | pass |
| 14 | Audit contains submitted + completed + auth failure | pass |
| 15 | Result survives a **real server-process restart** | pass |
| 16 | Duplicate still replays after restart | pass |
| 17 | Nothing claimable after restart | pass |
| 18 | No duplicate execution after restart | pass |
| 19 | Scheduler advances the **next** permitted task autonomously | pass |
| 20 | NEXUS surface fails closed without its credential | pass |

Evidence artifact: `release/mission-15-live-activation.json`.

**Labelled substitutions:** the D1 network transport is `node:sqlite` behind a D1-shaped fetch shim;
the Chat Completions provider is a fixture (and is not used for message execution). This is
**local**, not staging, not Render, not production — no Cloudflare or OpenAI account was contacted.

## 3. Staging — still NOT RUN

Re-run on this commit:

```json
{ "ok": false, "code": "staging_not_configured", "missing": [
  "CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN",
  "STAGING_ALLOW_WRITES", "STAGING_OBJECTIVE_KEY", "STAGING_OWNER_APPROVAL_ID" ] }
```

Exit code `2`. No network request was made; production was not contacted. Migration `0006` has still
never been applied to a real D1 database. The exact owner sequence remains
`docs/HABITAT_ACTIVATION_RUNBOOK.md` §1.

## 4. Render — live probe found an **older deployment**

Read-only probe of `https://habitat-1-szzd.onrender.com/health` on 2026-11-22:

```json
{"habitat":"online","brain":"ready","backend":"ready",
 "deviceBridge":{"ready":true,"durable":true,"axTokenConfigured":true,"perDeviceTokens":true},
 "provider":"multi-provider","model":"openrouter/free","free_brain":true}
```

The service is awake and its durable device bridge is live. However the response has **no `nexus`
block and no `version` field**, both of which this branch's `server.mjs` always returns. Conclusion:
the deployed service is running **pre-Mission-14 code**, not `f03f904`. The message routes therefore
do not exist at that origin yet, and no claim about the channel can be made against Render.

What is still needed, exactly:

1. Deploy `f03f904` (owner action; no Render API credential here).
2. Set `AX_NEXUS_TOKEN` (and confirm `HABITAT_AX_COMMAND_TOKEN`, `HABITAT_AX_BRIDGE_TOKEN`,
   `HABITAT_OWNER_DEVICE_IDS`, the three D1 variables).
3. Choose a scheduler trigger. A **Free web service sleeps after ~15 minutes idle**, so
   `NEXUS_RUNTIME_ENABLED=true` alone is "autonomous while awake", not continuous.
   - Least expensive reliable option: a **Render Cron Job** running `npm run tick` every 5 minutes
     (~$1/month), documented in `docs/NEXUS_CRON_DEPLOYMENT.md`.
   - Zero-cost alternative: any external scheduler (e.g. GitHub Actions schedule) calling
     `POST /ax/command/scheduler/tick` with `AX_SCHEDULER_TOKEN`. It is free but delivery can be
     delayed by minutes and depends on a third party.
   - Do not call a sleeping Free instance continuously autonomous.
4. Post-deploy probes (record raw JSON): `/health` must now include `nexus`, `/ax/nexus/channel` must
   return `200` with the three read-only adapters, and a scheduler tick must report `autonomy`.

## 5. Autonomous execution — what is and is not proven

- **Proven live (local):** message-driven autonomy. A queued task is drained, dispatched, executed by
  the real NEXUS tick, completed from evidence, audited, and the next task is advanced, with no
  manual step between ticks.
- **Proven in tests:** objective autonomy with a mock model transport and a run store; approval-gated
  objectives are never started; the command token cannot approve; retry/dead-letter and leases hold.
- **Not proven live:** objective autonomy against this local harness, because no Ax run store or
  planner provider was configured (`autonomy.objectives` reported `provider_unconfigured`). The
  message path does not need a model; the objective path does.

## 6. Control center

- Served at `/control`; the page ships **11 tabs**: chat, workers, tasks, memory, approvals,
  missions, agents, device, recovery, security, health.
- Rendered from the real harness, HTTP `200`, all 11 tab buttons and the `<canvas id="brain">` are
  present; the client application is served as `/control/app.js` and contains the WebGL brain
  (two hemispheres, sagittal groove, cerebellum, brainstem, connectome edges, travelling pulses —
  not a sphere or star field). If WebGL is unavailable the canvas stays transparent rather than
  faking a brain.
- Mobile: viewport meta is correct and inputs are 16 px with ≥46 px height to avoid iOS zoom. The
  layout was **not visually inspected on a device or emulated viewport in this mission**; no claim of
  visual correctness on the S26 Ultra is made.

## 7. Memory continuity

The safe ChatGPT export path already exists and is tested:

1. `POST /ax/command/memory/import/preview` parses an export, keeps **user messages only**, stores
   candidates with conversation id, title, timestamp and source, rejects secrets, and writes nothing.
2. The owner reviews candidate ids.
3. `POST /ax/command/memory/import/apply` writes only explicitly approved ids through the normal
   memory repository (credential scanning, versioning, conflict detection).

Facts remain classified as confirmed / user-reported / hypothesis / unverified at write time. **No
ChatGPT export has been imported here**, so no memory or session transfer is claimed.

## 8. Android

- Source at `0.8.5` unchanged since Mission 14; APK `app-debug.apk` 908,446 bytes, SHA-256
  `e20a0729e2f7a954b49b2a58e07ba5bec589d3e7fb32211700a062cde92653b4`.
- No `adb`, no emulator and no attached device in this environment (`adb: command not found`).
- Physical pairing is **not verified**. Owner procedure: `docs/ANDROID_MISSION_14_DEVICE_TEST.md`.

## 9. Release decision — NO-GO

| Criterion | State |
| --- | --- |
| Authenticated Ax↔NEXUS protocol | yes — live local HTTP |
| Persist + retrieve by correlation id | yes — live local HTTP, survives process restart |
| NEXUS executes permitted tasks independently | yes for message tasks; objective autonomy tests only |
| Agents do real work with evidence | read-only adapters yes; model-backed agents simulated |
| Budget/security controls | yes in tests; audit chain asserted live |
| Scheduler + recovery on durable storage | yes in SQLite/D1-shaped tests; not D1 |
| Render ready for authorized deployment | repository-ready, live service outdated |
| Android pairing physically verified | **no** |
| Control center reflects real services | code/HTTP verified; not visually verified |
| Memory import/retrieval | implemented + tested; not run on a real export |
| Gate + CI on exact final commit | re-run after this record |
| Owner actions specific and minimal | yes — §10 |

## 10. Owner-only actions, in priority order

1. **Deploy** `f03f904` (or the final record commit) to Render, then add `AX_NEXUS_TOKEN`; confirm the
   other variables. Verify `/health` contains `nexus`.
2. **Create a scheduler trigger** (Render Cron `npm run tick`, $1/mo, recommended; or an external
   scheduler with `AX_SCHEDULER_TOKEN`).
3. **Staging**: disposable D1, apply 0001–0006, export the six `STAGING_*` names, run
   `staging:demo -- write`, then `verify` in a second process.
4. **Ax connector**: workspace GPT Action from `/ax/command/openapi.json` with the Ax Bearer token, or
   an external authenticated client. A personal ChatGPT plan cannot create an Action.
5. **Android**: install the APK and run the 15-check sheet on the S26 Ultra; record model, serial
   hash, timestamps.
6. **Merge**: after 1–5, re-run the gate and CI, then undraft PR #93.

## 11. Security notes and unresolved defects

- Channel delivery is **at-least-once**, restricted to read-only adapters; no arbitrary command or
  shell execution path exists. Idempotency prevents duplicate tasks per key.
- Tokens are compared in constant time; NEXUS fails closed when `AX_NEXUS_TOKEN` is unset; the
  command token cannot approve objectives.
- Payloads are bounded and redacted before persistence; 30 messages/minute per origin.
- The channel's rate limiter is **per process**; behind multiple Render instances the effective limit
  multiplies. Acceptable for one owner, worth noting before scaling.
- Memory import depends on the owner approving candidate ids; there is no bulk auto-approve.
- The live Render deployment is stale; until redeployed, the production origin has no channel and its
  health omits executor state, which can mislead an integrator.
