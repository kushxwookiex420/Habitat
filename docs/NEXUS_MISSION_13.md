# NEXUS Mission 13 — real validation and release closure

## Release decision

**Not ready to operate as a fully validated system.** The code branch is locally and CI ready, but the two acceptance gates that require owner-controlled resources — disposable staging D1 persistence across processes and a physical Galaxy S26 Ultra pairing run — were not executed because this environment has no staging credentials, no Render access, no `adb` and no attached device. The correct decision is: **keep PR #93 open and draft; do not merge or deploy.**

This is not a claim that the branch is broken. It is a refusal to promote local evidence to staging or physical evidence.

## Commits

- Starting independently verified head: `5f2175d00e60649f0330f20f89d4327744cb7f7a`
- Mission 13 validated code commit: `ab727b4637dde66cf1b6770ef781cb39312d7436` (recorded as `commit` in `release/manifest.json` by the gate).
- Mission 13 release-record commit: the commit containing this document and the matching manifest; it adds only docs/release files after the validated commit. A commit cannot contain its own SHA, so the final SHA is reported by Git and in the Mission 13 final report.
- No merge, force-push, history rewrite, Render change or production database write occurred.

The exact starting state is in [NEXUS_MISSION_13_BASELINE.md](NEXUS_MISSION_13_BASELINE.md).

## What Mission 13 changed

1. **Release gate final-commit correctness.** The Mission 12 manifest named `1f44412` while HEAD was `5f2175d`. The gate now supports a check-only mode and verifies that the manifest either names HEAD or is followed only by `docs/` and `release/` changes. Any code or test change after validation fails the check.
2. **Evidence-claim verification.** The gate parses the staging and Android status lines. `NOT RUN`/`BUILD ONLY` is accepted only with an explicit owner action; a `VERIFIED` claim without a database fingerprint, write process, verify process and audit head, or without a physical device model, serial hash and completed checks, fails.
3. **Mission 13 release inputs.** The gate now requires the Mission 13 baseline, staging results, Android sheet and Render readiness documents.
4. **Local populated control-center harness.** Real HTTP, real control-center page, real command routes and real services, with in-memory storage and harness-created records. This replaced route fixtures for the populated state. It is explicitly **not staging**.
5. **Fresh APK build and evidence.** The debug APK was re-assembled and its size, SHA-256, package id and permissions recorded.
6. **Owner-blocked procedures.** Staging, Render and physical-device documents now state exact actions and what evidence would be required.

No architecture expansion was undertaken.

## Evidence by level

| Level | What exists | Does not mean |
| --- | --- | --- |
| Implemented | Gate changes, harness, documentation, Android APK | Nothing is live |
| Locally tested | 691/691 tests on Node 26 and Node 22; 18/18 migrations; 6/6 gate/staging tests; local harness browser reads; APK build | Local tests are not staging or device evidence |
| CI verified | Six workflows green on `5f2175d`; final Mission 13 head must be green before handoff | CI does not exercise D1 or a phone |
| Staging verified | **None** | No staging database was contacted |
| Physical device verified | **None** | No emulator or S26 Ultra was used |
| Production verified | **None** | Production was not accessed or changed |

## Test discrepancy reconciliation

`1f44412`'s Mission 12 document said 687/687. `5f2175d` updated it to 689/689, matching the manifest. The difference is the two release-gate failure tests executed after the earlier text was written. At baseline, both Node runtimes reported 689/689, so the discrepancy was editorial, not a missing test run. Mission 13 adds two release-gate tests and now reports **691/691 on both runtimes**; the manifest records the same number.

## Staging

Status: **NOT RUN — owner-blocked**. No database identity exists to report. No migrations were applied to D1. No writes, reads or cleanup occurred. The harness's refusal path was executed and exited 2 with the missing variable names. The full procedure and status table are in [STAGING_VALIDATION_RESULTS.md](STAGING_VALIDATION_RESULTS.md).

Local supporting evidence only: `node:sqlite` migration checks 18/18; D1 HTTP-shaped repository tests; four-process scheduler harness; separate-process restart harness against local storage. None of these is staging.

## Render

Status: **repository-inspected only, not live-verified.** `/health` exists and is liveness/readiness oriented, but a green response does not prove D1, scheduler or provider health. The Render Free web service sleeps after 15 idle minutes; scheduled work cannot be relied on while asleep. The specified executor is a separate cron job, which does not exist and costs at least $1/month. Details and owner steps: [RENDER_INTEGRATION_READINESS.md](RENDER_INTEGRATION_READINESS.md).

## Android

Status: **BUILD ONLY — owner-blocked.** APK: 908,394 bytes, SHA-256 `aa022d8b3f56f8cf9c45c8e5f79fdb8706e64d80cb9e8a006d7afbc61e71f950`, package `com.habitat.axbridge`, version `0.8.4`. Build result `BUILD SUCCESSFUL`. No emulator and no physical device. Pairing is **not claimed fixed**. The 15-test sheet, source-verified behaviors and numbered owner instructions are in [ANDROID_MISSION_13_DEVICE_TEST.md](ANDROID_MISSION_13_DEVICE_TEST.md).

## Control center

The populated state was checked against a **local authenticated backend harness** (`scripts/control-center-harness.mjs`), not fixtures:

- 11 tabs render; header shows **Connected** when reads succeed.
- Missions: one objective, budget `$0.0500`, spent `$0.0040`, remaining `$0.0460`, one settled execution `run_harness`, 2/2 criteria, one evidence item.
- Security: chain `verified`; the final API read returned five events, sequence 1→5, head `059a22d9…b86efa`. The saved screenshot was captured at three events and is not evidence of a different chain.
- Recovery: scheduler `healthy`, last success recorded, zero missed ticks, lease free.
- Device: fails closed with `device_state_not_configured` and header **Degraded** because no phone state is mounted.
- Health: fails closed with `diagnostics_unavailable`; the header stays **Degraded**. No token or configuration presence is presented as health.

Screenshots: [mobile detail](release/m13-control-live-mobile-detail.png), [security](release/m13-control-live-security-mobile.png), [desktop](release/m13-control-live-desktop.png). The harness page is **not** labelled by the product UI as staging/demo; the evidence caption and this document carry that distinction. The real empty state, unauthorized state and 503 behavior were previously verified against `server.mjs` without a store; they remain local evidence, not staging.

## Gate and CI

The gate now runs in check-only mode on the final release-record commit, so it validates the exact HEAD without creating another circular commit. Required checks: commit, syntax, full suite, migrations, route auth, release inputs, evidence claims, manifest consistency, critical adversarial suites, Android assembly/APK, environment names. Any skipped required check keeps `releaseReady` false.

On `ab727b4` the full write-manifest run returned **releaseReady: true, 11/11 checks**, 691/691 tests, 18/18 migrations and a freshly assembled APK. The check-only run on the final release-record commit is reported with the final CI result. The manifest's evidence levels remain `staging: NOT RUN — owner-blocked` and `physicalDevice: BUILD ONLY — owner-blocked`; `releaseReady` here means the code gate passed, not that the system is operationally validated.

Final CI on the Mission 13 head: recorded in the final report. No workflow result is assumed.

## Remaining findings and blockers

| Item | Severity | Owner | Verification procedure |
| --- | --- | --- | --- |
| Staging persistence and D1 behavior unverified | High (release blocker) | Owner supplies disposable D1 + approval | `staging:demo` write and separate verify; record identity, migrations, audit head, cleanup |
| S26 Ultra pairing and lifecycle unverified | High (release blocker) | Owner executes 15-step sheet | Physical pass/fail table with model, build, timestamps |
| Render service/sleep/scheduler unverified | Medium | Owner confirms dashboard and deploys | `/health`, authenticated diagnostics, one cron run, one objective completion |
| Control center populated state uses in-memory backend | Medium evidence limitation | Engineering | Repeat same reads against staging; distinguish live/staging/demo in UI/evidence |
| Free web service cannot run work asleep | Medium operational | Owner decides paid cron | Manual cron run + heartbeat + queued task completes |
| Staging harness does not exercise scheduler/memory in staging | Medium | Engineering + owner | Add checks to owner run before calling staging complete |
| Hash chain has no external anchor | Low | Owner/engineering | Retain observed head off-box; compare on verify |
| `RECORD_AUDIO` declared but not exercised | Low | Owner/product | Confirm necessity or remove before production |

## Production impact

**None.** No production D1 read/write/migration, no Render variable/deploy, no paid service, no secret exposure, no external message, no phone command, no merge and no publication occurred. The only external calls were to the existing authenticated preview browser for local UI inspection; no production endpoint was probed.

## Owner actions to close Mission 13

1. Supply a disposable staging D1 database and approval id; run the write/verify procedure and record identity, migrations, audit head and cleanup.
2. Run the 15-test sheet on the physical S26 Ultra and return the table.
3. Confirm Render service settings, set variable names only through the dashboard, and run one authenticated diagnostics request.
4. Decide whether to create the paid cron job for continuous operation.
5. Re-run the release gate and CI after staging/physical evidence is appended; only then consider merging PR #93.
