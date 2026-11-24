# NEXUS Mission 13 — starting baseline

Captured 2026-11-22 before any Mission 13 code change.

## Repository and pull request

| Item | Observed value |
| --- | --- |
| Repository | `kushxwookiex420/Habitat` |
| Pull request | [#93](https://github.com/kushxwookiex420/Habitat/pull/93) |
| State | OPEN |
| Draft | true |
| Merge state | CLEAN |
| Base | `main` |
| Branch | `ax-nexus/revision-4.6-nexus-mainline-integration` |
| HEAD | `5f2175d00e60649f0330f20f89d4327744cb7f7a` |
| Title | `AX: Missions 08-12 — autonomy, accountable operations, adversarial hardening` |
| Description | Cumulative Missions 08–12; the earlier revision 4.5 text had already been replaced |
| Working tree | Clean for tracked files; only ignored build artifacts (`app/build`, `.gradle`, `node_modules`, `local.properties`, `package-lock.json`) were present |

The reported last verified head was still HEAD. No divergence was found.

## Recent commits

```text
5f2175d release: record the mission 12 gate result
1f44412 ax: close the accounting, audit and transport gaps found adversarially
411ea52 release: record the mission 11 gate manifest and mobile proof
7939f39 ax: make objectives accountable, auditable and recoverable
deb4e7f ax: unify objectives, agents, recovery and device state into one lifecycle
```

## CI on the starting head

All six workflows completed successfully on `5f2175d`:

| Workflow | Result |
| --- | --- |
| Habitat CI | success |
| Habitat Build Test | success |
| Habitat release checks | success |
| Habitat D1 Repository Tests | success |
| NEXUS Sandbox Security | success |
| Product Demo Safety and Regression CI | success |

The earlier `1f44412` Build Test run was cancelled after a newer commit superseded it; the final `5f2175d` run passed.

## Required Mission 12 documents

Present: `docs/NEXUS_MISSION_12.md`, `docs/SECURITY_REVIEW_MISSION_12.md`, `docs/STAGING_VALIDATION.md`, `docs/ANDROID_DEVICE_VALIDATION.md`.

## Test-count reconciliation

- `1f44412` recorded **687/687** in `docs/NEXUS_MISSION_12.md`.
- `5f2175d` recorded **689/689** in the same document and in `release/manifest.json`.
- The difference is the two release-gate failure tests in `tests/release-gate.test.mjs`, executed after the text at `1f44412` was written. The final head and the manifest agree at **689**.
- Re-run at baseline on Node 22.23.5: `tests 689, pass 689, fail 0`; Node 26.13.1: 689/689. There is no current discrepancy.
- Mission 13 adds tests, so the count will rise again; each document and the manifest must use the same final count.

## Release-gate commit discrepancy

`release/manifest.json` recorded:

```text
commit: 1f44412576c4329585dbea8b5c0316df787984c9
releaseReady: true
checks: 9/9
generatedAt: 2026-11-22T03:40:26.285Z
```

The gate was executed on `1f44412`, **not** on `5f2175d`. The later commit changes only the Mission 12 document and the manifest itself. Mission 13 therefore adds a check-only gate mode and a manifest-consistency check: a manifest may name `HEAD` or a commit whose only later changes are confined to `docs/` and `release/`; any code or test change after validation fails the check. The final Mission 13 gate must run in check-only mode on the final release-record commit.

## Environment and owner-only access

At baseline, no environment variable name matching `D1`, `STAGING`, `RENDER`, `CLOUDFLARE`, `CONVEX` or `AX_` was present. There was no Render API credential, Cloudflare token, staging database identifier or owner approval id. No `adb` binary was installed and no Android device was attached. Consequently:

- No staging D1 request was made.
- No production D1 request was made.
- No Render environment was read or changed.
- No physical S26 Ultra action was possible.

These are owner blockers, not passes. Mission 13 records them explicitly in the staging and Android documents.

## Release inputs

- Android debug APK at baseline: `app/build/outputs/apk/debug/app-debug.apk`, 908,394 bytes, SHA-256 `aa022d8b3f56f8cf9c45c8e5f79fdb8706e64d80cb9e8a006d7afbc61e71f950`.
- Application id: `com.habitat.axbridge`, version `0.8.4`.
- Declared permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `RECEIVE_BOOT_COMPLETED`, `RECORD_AUDIO`.
- Render starts with `npm run check && node server.mjs`; `/health` reports `habitat: online`, `backend: ready`, device-bridge readiness and provider presence without claiming subsystem health.
