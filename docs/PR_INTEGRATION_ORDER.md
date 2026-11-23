# Open-PR audit and integration order

Measured on 2026-11-23 against `origin/main` at `4d1f2e5`. Nothing in this document has been merged:
every merge to `main` deploys production, and the standing policy is staging-first.

## The blocking discovery: migration lineage

`origin/main` contains only:

```
migrations/0001_habitat_tasks.sql
migrations/0002_habitat_command_tasks.sql
```

The P1 branch contains `0001`–`0009`. So PR #115 does not add two migrations; it brings **seven**
(`0003`–`0007` from earlier missions, then `0008` and `0009`). Two consequences:

1. Any staging rehearsal must apply `0003`–`0009` **in order**, not just `0008`/`0009`.
2. The repository cannot tell anyone what the production D1 database actually contains. Production
   tables may exist without their migration file ever being on `main` (applied by hand through the
   dashboard). Before any merge, someone with read-only production access must run:

   ```sql
   SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'habitat%' ORDER BY name;
   ```

   and compare it with the nine migration files. Re-applying is nominally safe (`IF NOT EXISTS`
   everywhere), but "nominally safe" is not evidence, and a mismatch means the deployed code and the
   deployed schema disagree.

This makes the pre-merge schema comparison a hard gate, not a formality.

## Audit

| PR | State | Files | +/− | Shares files with #115 | Migrations |
| --- | --- | --- | --- | --- | --- |
| #115 | draft, `MERGEABLE`/`CLEAN` | 262 | +57,667/−246 | — | 0003–0009 |
| #114 | open, `MERGEABLE`/`CLEAN` | 9 | +1,489/−1 | 9 | none |
| #111 | draft, `CONFLICTING`/`DIRTY` | 11 | +749/−18 | 11 | none |
| #110 | draft, `CONFLICTING`/`DIRTY` | 5 | +619/−7 | 5 | none |
| #109 | draft, `CONFLICTING`/`DIRTY` | 4 | +156/−76 | 4 | none |
| #108 | draft, `MERGEABLE`/`CLEAN` | 4 | +174/−1 | 4 | none |
| #107 | open, `MERGEABLE`/`CLEAN` | 3 | +409/−2 | 3 | none |
| #106 | open, `MERGEABLE`/`CLEAN` | 4 | +184/−5 | 3 | none |
| #105 | open, `MERGEABLE`/`CLEAN` | 5 | +267/−27 | 2 | none |
| #104 | open, `MERGEABLE`/`CLEAN` | 2 | +259/−0 | 0 | none |
| #103 | open, `MERGEABLE`/`CLEAN` | 5 | +584/−0 | 0 | none |

## Conflict clusters

**Android app line — mutually exclusive.** #111 and #105 both edit `app/build.gradle.kts` and
`app/src/main/java/com/habitat/AndroidDeviceBridge.kt`. #110 and #109 are `DIRTY` against `main`
independently. Only one Android line can land first; landing two in parallel guarantees a rewrite of
the other.

**Device routing and presence.** #107, #109 and #108 share `home-bridge-console.mjs` and
`tests/device-pairing-recovery.test.mjs`. #110 and #108 share `device-command-bridge.mjs`.

**Status and command auth — the #115 collision.** #114 edits `command-auth.mjs`, `server.mjs`,
`system-status.mjs` and `device-command-bridge.mjs`, all of which #115 already owns.

**Independent.** #104 (documentation of the 0.8.x integration) and #103 (the 0.8.5 upgrade path)
touch nothing #115 touches.

## Recommended order

This is a *review* order chosen to minimise rewrites. Every step still needs staging evidence before
its merge.

1. **#104, #103** — documentation, zero overlap, safe to review and land first. They also give the
   Bridge work a written baseline.
2. **#106** — idempotent security-event appends. Small, clean, and it lands before anything that
   writes audits.
3. **#108, then #107** — owner-console auth/lockdown, then status routing to the durable queue. Both
   clean; #108 first because it changes who may reach the console that #107 routes through.
4. **Android: #105 first, then #111, and only then #110.** #105 is small and clean; #111 is the large
   accessibility/screenshot line that conflicts with it; #110 builds on the actions transport. #109
   collapses into whichever of these keeps the durable bridge as the sole presence authority — do not
   land it separately without re-reading #105's pairing changes.
5. **#114** — status/telemetry. It is clean today, but it rebases over everything in steps 3–4 because
   it owns `server.mjs` and `command-auth.mjs`. Cheaper to rebase it once, late, than to rebase four
   device PRs over it.
6. **#115 last.** It is the release train: 262 files, seven migrations, and it owns `server.mjs`,
   `command-routes.mjs`, `device-command-bridge.mjs`, `ax-scheduler.mjs`, `ax-treasury.mjs` and
   `package.json`. Rebasing it is the most expensive operation available, so it must be rebased
   exactly once, after the small branches are in.

## Rules applied (and why nothing was rewritten)

- **No force-push and no rebase of another worktree's branch.** Rewriting #110/#111/#109 to clear
  `DIRTY` would discard context their authors hold; each is a draft or owner branch. Conflict
  resolution belongs to the author or to an explicit request.
- **No migration renumbering.** `0003`–`0007` are already applied somewhere; renumbering them in the
  repository would be worse than a gap.
- **Nothing merged.** #115 stays a draft until `docs/D1_STAGING_VERIFICATION.md` and
  `docs/OWNER_DEVICE_AND_ORIGIN_TESTS.md` have run results.
- **One Android line at a time.** The app cluster is the only place where two open PRs contradict
  each other directly.

## Prerequisites now machine-checked

`npm run staging:preflight` (new) validates the repository side of staging without any credential:

- node ≥ 22, the P1 migrations exist and are non-empty, migration numbers are contiguous;
- the network routes and the scheduler tick route are present in `command-routes.mjs`;
- `Dockerfile` + `PORT` + `/health`, and `/health` reports the running commit;
- `NEXUS_RUNTIME_ENABLED` is not enabled;
- staging credentials present, staging id ≠ production id, `STAGING_D1_CONFIRM=provision`;
- if a token is present, Cloudflare reports it active (read-only, never printed).

It exits non-zero and names the missing pieces. On this checkout every repository check passes and
exactly three staging checks block: credentials, isolation (uncomparable until both ids exist) and the
provision confirmation.

## Android build environment

The repository intentionally has **no** Gradle wrapper jar (`gradle/wrapper/` does not exist), and this
workstation has no `java`, `gradle` or `ANDROID_HOME`. The reproducible environment is the existing
`.github/workflows/android-apk.yml`, which pins the whole toolchain:

- Temurin **JDK 17**
- Gradle **8.10.2** via `gradle/actions/setup-gradle@v4`
- Android SDK from the runner image, plus `platforms;android-35` and `build-tools;34.0.0`
- `gradle :app:assembleDebug --no-daemon --console=plain`, artifact uploaded
- a signed release **only** when the four `HABITAT_KEYSTORE_*` / `HABITAT_KEY_*` secrets exist

It has already produced successful APK runs. A dispatch from `main` fails with
*"Workflow does not have 'workflow_dispatch' trigger"* because `main`'s copy of the workflow predates
that trigger; dispatching against the branch that carries it works. Local reproduction needs the same
three pins; nothing else is missing.
