# NEXUS Mission 12 — Independent adversarial review and release readiness

Date: 2026-11-22
Branch: `ax-nexus/revision-4.6-nexus-mainline-integration`
PR: #93 (draft, open, not merged)
Starting release commit: `411ea5298734e963cb0824970fbfd266879ee64a`
Mission 11 implementation commit: `7939f39`

This report separates what was implemented, integrated, tested, live, and independently verified.
Local tests are not production evidence.

## 1. Starting state and audit discrepancies

The branch was at `411ea52` and had not moved. The Mission 11 commits (`7939f39`, `411ea52`) and all
six workflows on that head were green. The release manifest and local demo evidence were present.

Discrepancies found before implementation:

| Claim or assumption | Verified state | Action |
| --- | --- | --- |
| PR #93 describes the cumulative implementation | Title/body were still the older revision 4.5 worker integration; the prior update did not apply | Corrected in the final PR update |
| Bounded accounting history is safe | `slice(-50)` could drop an active reservation (H-1) | Fixed and tested |
| Engineering inspection is root-contained | `path.resolve` allowed a symlink escape (H-2) | Fixed and tested |
| D1 security appends are reliable under contention | Four of eight concurrent appends could be lost (H-3) | Retry bounded to 24 rounds; tested |
| Child checks are isolated from service secrets | They inherited the full process environment (M-1) | Filtered environment |
| Timeout terminates child work | Only the direct child was killed (M-2) | Process-group kill |
| Audit redaction covers short credentials | Token/password assignments were not covered (M-3) | Extended redaction |
| File reads are bounded before allocation | Read happened before the size check (M-4) | `stat` first |
| Control center reports read health | Green came from token presence (M-5, already fixed during Mission 11 verification) | Verified in browser |
| Android pairing is validated | Compiled only | Still not physically validated |
| Staging D1 exists and is reachable | No disposable credentials available | Harness built; exact owner action documented |

## 2. Independent security review

The evidence-backed findings, reproductions and fixes are in
[`docs/SECURITY_REVIEW_MISSION_12.md`](SECURITY_REVIEW_MISSION_12.md). No Critical finding was found.
Three High findings were fixed; four Medium and three Low/Informational remain documented. Existing
unit tests passing was not accepted as proof.

## 3. Accounting invariants

Implemented and adversarially tested in `tests/ax-adversarial-accounting.test.mjs`:

- Concurrent independent reservations cannot jointly exceed the limit. Twelve simultaneous $0.01
  reservations against $0.05 accepted at most five; reserved sum never exceeded the limit.
- A failed accounting write leaves no reservation and no spend.
- Duplicate execution ids reserve once; a replayed settlement never charges twice (even with a
  different amount).
- A bound run id cannot be reassigned.
- Bounded history keeps every active reservation (H-1).
- Stale reconciliation releases an unbound reservation, keeps a bound one when the run store is
  unknown, and releases a bound one only when the run store says it does not exist.
- A restart rebuilds identical accounting and settles once.

No invariant depends on a single mutable counter; reserved and actual amounts remain separate.

## 4. Security-event log

`tests/ax-adversarial-security.test.mjs` adds 100 concurrent appends with one contiguous chain,
duplicate-id replay refusal, edited content, broken previous hash, missing event, reordering,
pagination stability during appends, short-secret redaction, malformed timestamp rejection, and an
optional independently retained head anchor. The D1 HTTP test now proves eight concurrent appends
all persist after H-3.

The log is append-only and tamper-evident relative to an observed head. It is not tamper-proof, and
the API states that limit. No route can update or delete an event.

## 5. Scheduler across real processes

`tests/ax-scheduler-multiprocess.test.mjs` uses a SQLite file and four separate Node processes:

- A lease held by one process makes another process return `tick_overlap`.
- After expiry, a new process takes over; the stale holder's heartbeat and complete both return
  `lease_lost` and cannot overwrite the new state.
- Four processes starting together produce exactly one successful tick; state survives a new
  process reading the file.
- A gap in durable state is reported as missed ticks/degraded.
- A tick reconciles a stale reservation while keeping a reservation whose bound run exists.

The SQLite store is a harness, not a production adapter. D1 remains the production path; its lease
SQL is covered through the D1 HTTP-shape test but not against a live database.

## 6. Agent transport adversarial validation

`tests/ax-adversarial-transports.test.mjs` proves:

- traversal (`../outside.txt`) is refused;
- hidden files are refused;
- a symlink to an outside file is refused;
- oversized files are refused before reading;
- a filename cannot become a shell command or create a file;
- children see neither parent service secrets nor credential-named check env values;
- a timed-out child is killed promptly and reported as failed;
- research cites only real local files with digests, no web sources, and skips the hidden/symlink
  fixture.

The transport is read-only and cannot fix code. It does not claim a fix unless a command actually ran
and exited zero. External web research remains unavailable rather than simulated.

## 7. D1 and staging readiness

Migration checks remain 18/18 (fresh, upgrade from 0004, repeat, unique index, data preservation).
`tests/d1-http-compat-mission-12.test.mjs` runs the real D1 objective, security and scheduler
repositories through the D1 HTTP request/response shape with SQLite behind it, including CAS
conflicts, concurrent sequence assignment and scheduler lifecycle.

This is not live D1. `scripts/staging-demo.mjs` is the staging harness, with a `write` phase and a
separate-process `verify` phase. It refuses without a disposable staging database and explicit
`STAGING_ALLOW_WRITES=true`, and it refuses to fabricate owner approval. No staging run occurred;
the exact owner setup is in [`docs/STAGING_VALIDATION.md`](STAGING_VALIDATION.md).

## 8. Android

`:app:assembleDebug` succeeds. Current artifact: 908,394 bytes, SHA-256
`aa022d8b3f56f8cf9c45c8e5f79fdb8706e64d80cb9e8a006d7afbc61e71f950`.

Compiled only. No emulator run, no physical Galaxy S26 Ultra run. The pairing fix is not claimed
fixed on hardware. The test sheet and install procedure are in
[`docs/ANDROID_DEVICE_VALIDATION.md`](ANDROID_DEVICE_VALIDATION.md).

## 9. Control center and operational truthfulness

Chromium verification at 390×844 and 1440×900:

- Empty state against the real local server with no D1 command store: eleven tabs render, all data
  reads fail closed, header says **Degraded** (not Connected), Security panel reports
  `security_log_not_configured`, Health reports the 503.
- Populated state with stubbed API data: objective detail shows limit/reserved/spent/remaining and a
  settled child execution; Security shows the hash-chain summary and an owner-authorization event;
  the scheduler card shows lease/heartbeat fields.

The populated views used fixture responses to test rendering; they are **not** live backend data.
The empty-state check used the real service. Screenshots:
`release/control-center-mobile-empty.png`, `release/control-center-desktop-empty.png`,
`release/control-center-mobile-populated.png`, `release/control-center-desktop-populated.png`.

## 10. Release gate hardening

`scripts/release-gate.mjs` now also fails when:

- required migrations or release documents/artifacts are missing;
- migration 0005 is absent, non-additive, or lacks its tables;
- the adversarial accounting/security/transport/auth, multi-process scheduler or D1-compat suites
  fail (these run even with `--skip-tests`);
- Android assembly fails or the APK is missing;
- a required environment variable name is undocumented (presence is reported without values).

`releaseReady` is false if any required check is skipped, so a skipped suite cannot be reported as a
pass. The gate writes the commit, schema, artifacts (including APK SHA-256), limitations and rollback
to `release/manifest.json`.

## 11. Local end-to-end demonstration

`npm run demo:objective` still runs 24/24 checks: memory recall, durable objective, bounded plan,
owner gate (simulated locally), reservation, real file inspection and real syntax/unit checks,
evidence, zero-cost settlement, verification, completion, memory write-back, notification, audit
chain, restart reconstruction and interrupted-run recovery. It is local and in-memory, not staging.

The staging harness adds the D1 write/verify path that the owner can run when credentials exist.

## 12. Performance

`npm run perf:check` writes `release/perf-mission-12.json` with p50/p95/max for bounded local
operations. On this machine (Node 26, in-memory stores):

- reservation: p50 0.191 ms, p95 0.407 ms (100 samples)
- settlement: p50 0.296 ms, p95 0.498 ms
- objective read: p50 0.135 ms, p95 0.205 ms
- security append: p50 0.018 ms, p95 0.052 ms
- security verify (200 events): p50 0.441 ms, p95 1.112 ms
- scheduler tick: p50 0.542 ms, p95 1.685 ms
- control center initial navigation in Chromium: DOMContentLoaded/load 392 ms, 300-byte transferred
  HTML document (cached test environment)

These are local measurements, not D1/Render/production latency, and no capacity claim is made.

## 13. Test counts and CI

- Full suite: **689/689 pass** on Node 26.13.1.
- Full suite: **689/689 pass** on Node 22.23.5.
- New adversarial suites: accounting 8, security 8, transports 7, auth 6, multi-process scheduler 5,
  D1 HTTP compatibility 3, staging harness 2.
- Migration checks: 18/18.
- Local demo: 24/24.
- CI: exact results for the final commit are in the PR checks; no merge is performed.

## 14. Findings and fixes

See [`docs/SECURITY_REVIEW_MISSION_12.md`](SECURITY_REVIEW_MISSION_12.md). High findings H-1, H-2 and
H-3 are fixed with reproductions. Medium M-1..M-5 are fixed or verified. Low L-1..L-3 are documented
residual risk. The PR description defect was fixed.

## 15. Limitations

- No live D1, Render, model provider or physical phone access.
- Staging harness not executed.
- SQLite behind the D1 HTTP shape is not Cloudflare D1.
- SQLite scheduler harness is not the production D1 adapter.
- Hash chain has no external trust anchor.
- Research is local-only; no external web research transport exists.
- Control-center populated views were rendered from fixtures, not live records.
- Android pairing remains unverified on hardware.

## 16. Owner actions

1. Review the security review and this report.
2. Provide a disposable staging D1 database and run the staging harness, including a real owner
   approval id.
3. Run the Android test sheet on the physical Galaxy S26 Ultra.
4. Decide whether to merge PR #93; it remains draft and open.
5. If scheduling is wanted, configure a trigger and `AX_SCHEDULER_TOKEN` in the owner-controlled
   environment.

## 17. Production and deployment status

**No deployment, no merge, no production database mutation, no production secret change, no paid
call, no publishing, no commerce action and no phone command.** PR #93 is open and draft. The exact
final commit and CI results are reported with the completed mission; the branch was not force-pushed
and history was not rewritten.
