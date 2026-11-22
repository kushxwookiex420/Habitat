# Security review — Mission 12

Date: 2026-11-22
Branch: `ax-nexus/revision-4.6-nexus-mainline-integration`
Base commit reviewed: `411ea52`
Method: source review plus new adversarial tests. Existing tests passing was not treated as evidence.

Severity is impact-based. A finding is only marked fixed when a test reproduces the original failure
and passes after the change.

## Critical

None found in the reviewed surface.

## High

### H-1 — Active reservations could be pruned out of the accounting history

- **Where:** `ax-objectives.mjs`, `reserveExecution` / `pruneExecutions`.
- **Defect:** history was capped with `slice(-50)`. Once an objective had more than 50 executions,
  an in-flight `reserved` row could fall out of the window. Its budget was then no longer counted,
  so later children could reserve against money already committed. A dropped execution id could
  also be re-reserved and settled again.
- **Impact:** objective overcommit and duplicate attribution under long-lived objectives.
- **Reproduction:** `tests/ax-adversarial-accounting.test.mjs` — “bounded history never discards an
  in-flight reservation”. It creates 50 terminal rows, one active reservation, then 60 more terminal
  rows, and asserts the active row and its budget are still present.
- **Remediation:** `pruneExecutions()` keeps every `reserved` row and trims only terminal history.
- **Verification:** original behavior fails the test; fixed behavior passes. Full suite remains green.

### H-2 — Engineering transport could read a symlink that escapes the repository root

- **Where:** `ax-agent-transports.mjs`, `inspect()`.
- **Defect:** containment used `path.resolve()` only. A symlink inside the root pointing outside it
  passed the check and `readFile` followed it.
- **Impact:** arbitrary local file read through an agent inspection path.
- **Reproduction:** `tests/ax-adversarial-transports.test.mjs` — “engineering refuses traversal,
  hidden files and symlink escapes” (symlink to an outside file).
- **Remediation:** refuse symlinks with `lstat`, verify `realpath` containment, refuse non-files, and
  refuse hidden path segments. Traversal (`..`) is reported as `inspect_outside_root`, not hidden.
- **Verification:** all three refusals pass; a normal file still inspects with a digest.

### H-3 — Concurrent security-event appends could be dropped after four retries

- **Where:** `ax-security-event-repository.mjs`, D1 `append`.
- **Defect:** a `UNIQUE(seq)` collision retried only four times. Under eight concurrent refusals,
  four appends still failed with `security_store_unavailable`; those audit events were lost.
- **Impact:** missing authentication-failure evidence during exactly the burst an audit log exists
  for.
- **Reproduction:** `tests/d1-http-compat-mission-12.test.mjs` — eight concurrent appends through
  the D1 HTTP shape. Before the fix, four returned `ok:false`.
- **Remediation:** bounded 24-round retry with small backoff; the unique sequence constraint still
  guarantees one writer per sequence. This does not change append-only semantics.
- **Verification:** eight concurrent appends now all succeed, contiguous sequence 1–8, chain verifies.
  A replayed event id is still rejected by the primary key.

## Medium

### M-1 — Agent child processes inherited the service environment

- **Where:** `ax-agent-transports.mjs`, `runCommand`.
- **Defect:** `spawn` passed `{ ...process.env }`, so any allowlisted check inherited provider keys,
  command tokens and database credentials.
- **Impact:** a compromised or misconfigured check could read service credentials.
- **Reproduction:** `tests/ax-adversarial-transports.test.mjs` — “child checks inherit no
  credentials”. A check prints `HABITAT_AX_COMMAND_TOKEN`; it prints `absent`.
- **Remediation:** `filteredEnv()` passes only interpreter basics (`PATH`, `HOME`, locale/Windows
  system keys) and filters credential-shaped names from caller-supplied extras. `NODE_OPTIONS` is
  not passed.
- **Verification:** test passes; ordinary `node --check` still runs.

### M-2 — A timed-out check killed only the direct child

- **Where:** `ax-agent-transports.mjs`, timeout handling.
- **Defect:** `child.kill("SIGKILL")` left grandchildren alive; a test runner could leave work behind
  after the parent returned.
- **Impact:** resource persistence and output pipes held open after a timeout.
- **Reproduction:** “a timed-out check is killed, bounded and reported as a failure” exercises a
  child that sleeps five seconds with a 150 ms bound and asserts a fast failure.
- **Remediation:** POSIX children run in their own process group and the timeout kills the group;
  Windows falls back to the direct kill.
- **Verification:** test reports `timedOut: true` and returns well under the child's sleep.

### M-3 — Short token/password assignments were not redacted

- **Where:** `ax-security-events.mjs`, `redact`.
- **Defect:** redaction covered `sk-…`, Bearer, GitHub prefixes and 40+ character blobs, but not
  `HABITAT_AX_COMMAND_TOKEN=abc123`, `password=hunter2` or `x-owner-device-token: short`.
- **Impact:** credentials could be persisted in audit evidence.
- **Reproduction:** “short token assignments, passwords and JSON credentials are redacted”.
- **Remediation:** added a credential-name assignment rule, case-insensitive, for token/secret/
  password/api-key/authorization/credential names.
- **Verification:** test asserts none of four short secrets appear and `[redacted]` does.

### M-4 — Files were read before their size bound was checked

- **Where:** `ax-agent-transports.mjs`, engineering inspect and research scan.
- **Defect:** `readFile` loaded the whole file and only then sliced it. A very large repository file
  could exhaust memory.
- **Impact:** local denial of service from a configured or matched path.
- **Reproduction:** `tests/ax-adversarial-transports.test.mjs` — oversized file reports
  `inspect_file_too_large` with `maxFileBytes: 100`.
- **Remediation:** `stat` before read; engineering refuses oversized/non-file paths; research skips
  files above the bound instead of loading them.
- **Verification:** test passes and no content is returned.

### M-5 — Control-center header claimed Connected from a stored token

- **Where:** `control-center.mjs`.
- **Defect:** a token in `sessionStorage` set green “Connected” even when every API read returned
  503.
- **Impact:** operational false confidence.
- **Reproduction:** browser verification against a process without a command store; header must be
  Degraded and the panel must say the read failed.
- **Remediation:** header reads the actual per-render read outcome; any failure produces Degraded.
- **Verification:** Chromium, 390×844 and 1440×900, no D1: header “Degraded”, panels
  `security_log_not_configured` / `http_503`. Populated fixture views were checked separately and are
  labelled as stubbed data.

## Low

### L-1 — Hash chain has no independently protected trust anchor

Tampering with one historical row is detected (`hash_mismatch`), a broken link and a sequence gap
are detected, and `integrity()` now accepts an independently retained `expectedHeadHash` for
`head_anchor_mismatch`. An actor who can rewrite the whole table and every retained head copy can
rebuild the chain. That limitation is printed by `integrity()` and is not described as tamper-proof.

### L-2 — Multi-process scheduler evidence uses SQLite, not D1

`createSqliteSchedulerRepository` is a harness store, not mounted in production. Four separate
processes contend for one lease and a stale holder loses heartbeat/complete. D1 lease behavior
remains verified only through its SQL path with SQLite behind the HTTP shape.

### L-3 — Local end-to-end demo simulates the owner device

`scripts/ax-demo.mjs` simulates owner identity and makes no provider call. The staging harness
requires an owner-supplied approval id instead of fabricating device proof.

## Informational

- PR #93's title and body were still the older revision 4.5 description at audit time. This is a
  release-integrity defect, not a code vulnerability; it is corrected in the final PR update.
- Android pairing remains compile-verified only; no emulator or physical S26 Ultra run exists here.
- No live staging run was possible: no disposable D1 credentials were present.
- No secret values were printed, logged or committed during this review.

## Boundaries preserved

Owner device proof is still required for owner actions; the command token cannot approve. Route
authentication remains fail-closed. No production migration, deployment, paid call, publishing,
commerce action or phone command was performed.
