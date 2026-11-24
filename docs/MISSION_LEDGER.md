# Mission ledger

Updated on every push. Status words mean exactly this: **verified** = a command or CI run produced
evidence; **pushed** = on `staging/integration`; **CI-tested** = the run is named; **staging** = a
deployed staging service exercised it; **production** = the live service; **phone** = the S26 Ultra.

## Verified

| Capability | Evidence |
| --- | --- |
| Android debug signing identity is stable and checked | Repo keystore `debug-key.p12`, fingerprint `791eacbc33fbfcdb770a4299342cb1ad8fc6d959325df75091a03004726eb258`; CI run `45300974210` built and its guard step passed |
| Overlay typography accepts real catalog titles | Visual QA passes the 52-character title after the newline-split fix; render verified 1/1 |
| Full catalog video renders and passes QA | 892,530 bytes, 12.000 s, 1080×1920, 360 frames, SHA-256 `e3891bc0…` |
| Staging database adopted and reachable from CI | Run `45296503185`: 48 objects, 20 tables, 8/8 P1 tables, `applied: []`, `productionIdDiffers: true` |
| Improvement findings ride the scheduler tick | 9 tests in `tests/ax-scheduler-improvement.test.mjs`; suite 1,036 pass |
| Reconciliation of the two status implementations | One `system-status.mjs`, redaction policy v2, #115 7/7 green |
| Finance ledger and prioritisation modules | 25 tests; evidence-required rejections, verified-only net worth |

## Implemented, not deployed

- Improvement engine inside the scheduler (`improvement` callback + `createImprovementMonitor`).
- `/system/status` with redaction policy v2 and per-key configuration inventory.
- Product-video renderer with the libass fallback and honest readiness.
- Finance ledger (`ax-finance.mjs`), prioritisation (`ax-priorities.mjs`), improvement engine.
- Staging Render blueprint (`deploy/render.staging.yaml`) and acceptance run plan.

## Deployed and staging-tested

Nothing. No staging service exists, so no capability has been exercised on a deployed origin.

## Production-tested

Nothing from this branch. The live origin serves commit `0d5eb6e` (not on `main`) and returns **404**
for `/system/status`; `/workers` still shows the pre-catalog shape.

## Phone-verified

Nothing. The installed Bridge reports 0.8.7 while this tree declares 0.8.6, so no APK here is assumed
compatible. The installed certificate has not been read.

## Blocked

| Blocker | Owner action needed |
| --- | --- |
| Render staging service | Collaborator access or `RENDER_API_KEY`; approval of the paid `starter` plan; the production branch value from the dashboard |
| Phone signature comparison | Run the two `adb`/`keytool` reads in `docs/ANDROID_SIGNING_COMPATIBILITY.md` against the installed 0.8.7 |
| Production D1 schema comparison | A credential for the account that holds `3a906029…`; this token cannot see it |
| Live call phases 3–4 | A speech service choice and budget approval; no media server exists |

## Next highest-value task

The single change that most increases what can be verified is **a staging service**, because it is the
first environment where the improvement engine, scheduler ticks, notifications and recovery can be
exercised as a deployed system rather than as a module with tests. Until that access exists, the
highest-value unblocked work is the **parallel-workforce registry** (agents as replaceable records with
health, capability and isolation metadata) — it is pure runtime code that needs no paid service.
