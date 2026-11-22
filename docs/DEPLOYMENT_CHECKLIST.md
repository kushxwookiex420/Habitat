# Habitat deployment checklist

**Use only after explicit owner authorization.** This checklist is read-only until the deploy step.
It does not activate the NEXUS executor, change environment variables, or write to D1.

Record every value. A checklist with remembered results is not evidence.

## 0. Scope

| Field | Value |
|---|---|
| Release branch | `ax-nexus/revision-4.6-nexus-mainline-integration` |
| Proposed tree | release + #95, #96, #98, #100, #106, #102, #99, #101 |
| Last verified tree | 841/841 tests on the exact merges (see `RELEASE_INTEGRATION_085.md`) |
| Previous production commit | `57a51237f40f` (record again before deploying) |
| Deploy mechanism | Render, owner action |

## 1. Pre-deploy checks (all must pass)

- [ ] Every PR is merged **in the documented order**: #95 → #96 → #98 → #100 → #106 → #102 → #99 → #101.
      Stacked PRs retargeted, no PR merged against a stale base.
- [ ] CI is green on the exact release head, and the full suite was run on that head (not a branch tip).
- [ ] Record the release head SHA and the full-suite pass/fail counts.
- [ ] `NEXUS_RUNTIME_ENABLED` is **absent or false**. This is a hard gate; do not deploy an enabled
      executor.
- [ ] No environment-variable change is bundled with this deploy.
- [ ] `HABITAT_OWNER_DEVICE_ID(S)` is known and unchanged.
- [ ] D1 schema objects used by the release already exist or are created idempotently
      (`habitat_ax_security_events`, `habitat_ax_scheduler`, queue tables). No destructive migration.
- [ ] A D1 recovery point exists: record the Cloudflare **Time Travel** bookmark (owner console) or
      confirm the automatic retention window. This is an owner action, not a repo script.
- [ ] The previous deployment can be restored from Render (owner access confirmed).
- [ ] Android/signing work is **not** part of this deploy.
- [ ] Read-only production check passes **before** the deploy (baseline):
      `node scripts/production-readonly-check.mjs --expect-commit <current>`.

## 2. Deploy (owner only)

- [ ] Deploy the recorded release head from Render.
- [ ] Record deploy id, start time and the commit Render reports.
- [ ] Do not change environment variables in the same step.
- [ ] Do not enable the executor, run a worker manually, or send a phone command.

## 3. Post-deploy verification (read-only, GET only)

Allow for a free-tier cold start; the checker retries one timeout.

```bash
node scripts/production-readonly-check.mjs \
  --base-url https://habitat-1-szzd.onrender.com \
  --expect-commit <deployed-sha> \
  --require-message-surface
```

- [ ] `RESULT: PASS`.
- [ ] `/health` 200 and reports the deployed commit (short prefix match).
- [ ] `nexus.configured === false`; reason recorded.
- [ ] `nexusMessageSurface.configured === true` (strict mode; requires #95 deployed).
- [ ] `/ax/nexus/channel` 401, `/ax/command/messages` 401.
- [ ] No 5xx on the public surfaces; no unauthenticated 200.
- [ ] Render logs show no boot crash and no `NEXUS_AUDIT_FAILED` storm.
- [ ] Optional authenticated read (owner token, read-only): security-event chain integrity via the
      existing integrity endpoint. Record `ok`, `checked`, `headHash`. Do not append test events.
- [ ] Record the result table below.

## 4. Stop conditions (do not proceed / roll back)

Stop immediately if any is true:

1. `/health` is not 200 after one cold-start retry window (about 60 s).
2. The deployed commit does not match the release head.
3. `nexus.configured === true` before an approved activation.
4. A protected surface returns 200 without authentication, or 5xx persists.
5. `/health.nexusMessageSurface` is absent or `configured:false` after #95 is in the deploy.
6. Repeated boot crashes, audit write failures, or D1 errors in Render logs.
7. Pairing or command routes fail for the owner in a way that did not occur before the deploy.

## 5. Rollback

Triggers: any stop condition, or the owner judges the deploy unsafe.

- [ ] Roll Render back to the recorded previous commit (owner action).
- [ ] Re-run the read-only checker with `--expect-commit <previous>`; expect PASS.
- [ ] Do **not** roll back or delete D1 data. The release is additive; audit history stays valid.
- [ ] If an audit row was written by the new build and the code is rolled back, leave it. Never
      delete security events to "clean up".
- [ ] Record what failed, at which check, with the exact response/status.

## 6. Explicitly separate

- **Executor activation** is a different change with its own approval, drill and rollback. A routine
  deploy must never flip `NEXUS_RUNTIME_ENABLED`.
- **Android replacement** is separate: signing decision, device session, possible re-pair and owner
  allowlist update.
- **#97 console panel** is not in this release unless explicitly cherry-picked and re-verified.

## 7. Evidence record

| Item | Value |
|---|---|
| Release head | |
| Full suite | __ / __ pass, exit __ |
| CI run ids | |
| Previous commit | |
| Deployed commit | |
| Deploy id / time | |
| Checker result | |
| Audit integrity (optional) | |
| Rollback needed? | yes / no |
| Notes | |
