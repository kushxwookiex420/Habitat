# Habitat release integration — audit, recovery and verification (0.8.x)

**Status: PREPARED, NOT MERGED.** This document records a tested integration plan for the NEXUS
audit/recovery/verification PR stack. No branch was merged, no deployment was made, and the executor
remains disabled.

## 1. Target

| Item | Value |
|---|---|
| Release branch | `ax-nexus/revision-4.6-nexus-mainline-integration` |
| Current production commit | `57a51237f40ff814b177d53311a007d72605fbe2` |
| Production health | 200 · `nexus.configured:false` (`disabled_by_config`) |
| Merge authority | owner only |

## 2. Tested merge matrix

A scratch worktree was created at `57a5123` and the PR heads merged in sequence. **Every merge was
clean (0 conflicts)**, and the targeted suites passed on the merged tree.

| Order | PR | Head | Files | Merge | Tests added |
|---|---|---|---|---|---|
| 1 | #95 | `4f1f35b` | 3 | clean | 1 (`nexusMessageSurface`) |
| 2 | #96 | `5aa676d` | 4 | clean | 13 (approval/denial audit, fail-closed) |
| 3 | #98 | `26fd403` | 3 | clean | 3 (cancellation audit) |
| 4 | #100 | `f57cd42` | 3 | clean | 4 (refusal audit + write cap) |
| 5 | #99 | `a059174` | 1 | clean | 5 (restart recovery) |
| 6 | #101 | `71883cd` | 1 | clean | 7 (concurrency/failed writes) |
| 7 | #102 | `f0d8d6c` | 2 | clean | 7 (read-only production check) |

Targeted suites on the merged tree (command routes, audit, restart, concurrency, checker) →
**54/54 pass, exit 0**.

**#97** (`4b872f6`, Control Center pairing panel) is based on `main`; cherry-picking it onto the
release branch was verified clean. It is not part of the release merge sequence above unless the
pairing panel is wanted in the same deploy.

**#103** (`46d33c6`, Android upgrade plan + checksum verifier) targets `main` and is documentation
and tooling; it does not ship to the server.

## 3. Expected post-merge test total

Branch-tip measurements on top of `57a5123` (789 tests):

| Branch | Tip total |
|---|---|
| #96 | 802 |
| #98 (stacked) | 805 |
| #100 (stacked) | 809 |
| #99 | 794 |
| #101 | 796 |
| #102 | 796 |

After merging #95 (+\u200b1), #96, #98, #100, #99, #101, #102 the full suite is expected to report
**829 tests**. This is an expectation, not evidence: the merged tree still requires an actual
`node --test tests/*.test.mjs` run before any deploy. The targeted 54/54 run is the evidence
gathered so far.

## 4. Merge procedure (owner-authorized)

1. Merge **#95**, then **#96** into the release branch (both independent, clean).
2. After #96, retarget **#98** to the release branch if GitHub does not, then merge it.
3. Retarget/merge **#100** to the release branch (it was stacked on #98).
4. Merge **#99**, **#101**, **#102** in any order (new files; no conflicts).
5. Run the full suite on the merged release branch and record the real total.
6. Optional: cherry-pick `4b872f6` (#97) and re-run the console tests if the pairing panel is in
   scope for the same release.
7. Only then request a deploy authorization.

Stacked PRs must not be merged "out of order" while their base still points at an unmerged branch;
retargeting before merge keeps the diff honest.

## 5. Post-deploy verification (read-only)

After an authorized deploy, record the deployed commit and run:

```
node scripts/production-readonly-check.mjs \
  --base-url https://habitat-1-szzd.onrender.com \
  --expect-commit <deployed-sha>
```

Expected result: `RESULT: PASS`, with `/health` reporting the deployed commit,
`nexus.configured:false`, `/ax/nexus/channel` 401 and `/ax/command/messages` 401. On the new build,
`nexusMessageSurface` should also be present and report `configured:true` (only a boolean, never the
token).

Then, still without activating the executor:

- confirm `/health.nexus.configured === false` and record the reason;
- confirm the read-only checker reports the new commit;
- run one authenticated `GET /device/command/tasks` with the owner credential only if an operator
  session is explicitly approved (it is a read, but it uses a secret).

Do **not** flip `NEXUS_RUNTIME_ENABLED` as part of a routine deploy; that is a separate, staged
activation with its own approval and drill.

## 6. Rollback

- The previous deployment can be restored in Render only with owner credentials; this workspace has
  no Render API token, so rollback is an owner action.
- The audit PRs are additive (new categories already existed, no migrations). Rolling back the code
  does not corrupt the security chain; existing entries remain valid.
- If an audit PR is rolled back after approvals were recorded, the log entries remain — do not
  delete them.

## 7. Known risks carried into the release

1. **No live D1 verification.** Persistence/recovery/concurrency evidence uses behavioural doubles.
2. **Audit failure semantics:** an approval applied but not audited returns 502 with `recorded:false`.
   Operators must reconcile the task state rather than retry blindly.
3. **Refusal audit cap:** 10 recorded refusals/minute/process; a distributed flood can still write
   up to that per instance.
4. **No real worker activation:** the executor stays off, so none of this exercises a live claim in
   production.
5. **Android 0.8.5 is not device-verified**; the pairing single-flight fix is compile-verified only.

## 8. Not done by this document

No merge, no deploy, no environment change, no secret access, no D1 write, no executor activation.
