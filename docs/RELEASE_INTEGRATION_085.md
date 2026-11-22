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
| 5 | #106 | `fad7b99` | 4 | clean | 7 (idempotent audit append) |
| 6 | #102 | `901fe9d` | 2 | clean | 12 (strict surface + cold-start retry) |
| 7 | #99 | `a059174` | 1 | clean | 5 (restart recovery) |
| 8 | #101 | `71883cd` | 1 | clean | 7 (concurrency/failed writes) |

Targeted suites on the merged tree (command routes, audit, restart, concurrency, checker) →
**54/54 pass, exit 0**.

**#97** (`4b872f6`, Control Center pairing panel) is based on `main`. Cherry-picking it onto the
release branch is clean and was measured at **826/826** with dependencies installed, but it is
**held separate** and is not part of the merge sequence. Its base is `main`, so merging it as-is
would not deliver it to the release branch; that needs an owner-approved cherry-pick.

**#103** (`46d33c6`, Android upgrade plan, signing investigation and checksum verifier) targets
`main` and is documentation and tooling; it does not ship to the server.

## 3. Measured merged-tree total

Branch-tip totals on top of `57a5123` (789 tests): 802 (#96), 805 (#98 stacked), 809 (#100
stacked), 794 (#99), 796 (#101), 796 (#102). Those tips cannot simply be added: shared test files
are replaced, so the real total is smaller than the arithmetic suggested.

The full suite was actually executed on the merged tree, with `node_modules` linked:

| Tree | Result |
|---|---|
| release + #95, #96, #98, #100, **#106**, #99, #101, #102 (`901fe9d`) | **841/841 pass, 0 fail, exit 0** |
| earlier tree without #106 | 825/825 pass |
| same earlier tree + #97 cherry-pick | 826/826 pass |
| console + pairing targeted with #97 | 23/23 pass |

The exact proposed release tree is the 841-row: all eight commits verified as ancestors in one
scratch worktree, zero conflicts. An earlier draft predicted 829 from branch arithmetic; only
measured numbers are used. A run without `node_modules` showed 5 unrelated files failing on the
missing `sharp` package — an environment artifact, not an integration failure.

## 4. Merge procedure (owner-authorized)

1. Merge **#95**, then **#96** into the release branch (both independent, clean).
2. After #96, retarget **#98** to the release branch if GitHub does not, then merge it.
3. Retarget/merge **#100** to the release branch (it was stacked on #98).
4. Retarget/merge **#106** (stacked on #100); it changes the same repository file and must come after.
5. Merge **#99**, **#101**, **#102** in any order (new files; no conflicts).
6. Run the full suite on the merged release branch and record the real total (841 on the exact
   tree measured here).
7. **#97 stays separate.** Only after explicit owner approval, cherry-pick `4b872f6` and re-run the
   suite; its earlier measured result was 826/826 before #106. Do not merge #97 into `main` and
   assume it reached the release branch.
8. Only then request a deploy authorization. Use `DEPLOYMENT_CHECKLIST.md`.

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
5. **Android 0.8.5 is not device-verified**; the pairing single-flight fix is compile- and
   JVM-test-verified only.
6. **Audit duplicates are possible under network uncertainty.** `append()` reads the head, then
   inserts; if D1 commits the row but the response is lost, the retry reads its own row as head and
   appends a second event. The chain stays valid and sequence stays unique, but an approval can be
   logged twice. There is no idempotency key; operators should treat duplicate audit rows as
   possible and not as a second action.
7. **The append retry loop treats every error as contention** (24 rounds with backoff). A D1 outage
   therefore delays an audit write and then throws; an approval that already applied returns 502
   `recorded:false`, which is why reconciliation is required.
8. **Audit duplicates under a lost D1 response are fixed at the store level (#106).** The stable
   `sec_…` id is re-read before every insert, so a committed-but-unacknowledged write returns its
   row instead of appending. A client that retries the whole HTTP request still creates a new id and
   therefore a new event; request-level idempotency is not included.
9. **No schema migration is needed.** `habitat_ax_security_events` is created idempotently, has no
   CHECK constraint on `category`/`outcome`, and the new categories (`approval.created`,
   `owner.rejection`, `work.stop_requested`, `command.unauthorized`) fit the existing schema.
   Existing rows keep their hashes; nothing is rewritten.
10. **Ordering is semantic, not just textual.** #96 introduces the recorder wiring that #98 and #100
   extend; merging those first would leave their audit branches inert until #96 lands. Merge #96
   before #98/#100 even though all three are conflict-free.
11. **Rollback is additive.** Reverting the code does not invalidate audit rows or the sequence;
    never delete security events to "clean up" a rollback.

## 8. Not done by this document

No merge, no deploy, no environment change, no secret access, no D1 write, no executor activation.
