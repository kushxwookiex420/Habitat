# Mission Execution Engine

Builds on the durable workforce (`260a67c`), scheduler integration and the identity/memory layer
(`fa0ceeb`). Disabled by default; nothing here activates it.

## What a mission is

A durable aggregate with its own lifecycle, stored in `habitat_ax_missions` (migration 0011):

- objective, requirements, constraints, risks
- acceptance criteria (`c1…cn`, each required)
- approvals detected from the specification (deploy, publish, spend, destructive/credential, merge)
- dependency-aware milestones and tasks (capabilities, dependencies, criteria coverage)
- task state: `pending | running | completed | failed | blocked`, attempts, assignment, evidence,
  verification evidence, tests
- mission state: `planned | running | blocked | verification_failed | approval_required | completed |
  rejected | failed`
- append-only events in `habitat_ax_mission_events`

Missions are deliberately separate from objectives: an objective is a NEXUS execution record with its
own lifecycle. Reusing it would have coupled two state machines; duplicating the scheduler or workforce
was not necessary because the engine delegates to them.

## Rules enforced in code

1. A task is `completed` only when the workforce recorded an independent `verified` result.
2. A mission with a pending approval never reports `completed`, whatever its tasks say.
3. Every acceptance criterion must be covered by a verified task with passing tests, or the mission is
   `verification_failed` with the gaps listed.
4. A mission is assigned only by the workforce's own `assign`, so capacity, permissions, scopes and the
   partial unique index still apply.
5. Approval requires a valid owner attestation; the string "owner" is not enough.

## Planning

`buildMissionPlan` is deterministic: explicit tasks are validated (unique ids, known dependencies,
dependency cycle rejection, every criterion assigned), otherwise a two-stage plan is derived (assess →
implement and prove) with milestones as dependency waves. Same specification → same mission id, which
is also the duplicate-submission guard; an `idempotencyKey` takes precedence for request-level
deduplication.

## Execution and recovery

`execute(id)` reconciles first: tasks marked `running` whose assignment was completed or lost are
resolved from workforce results, requeued while attempts remain, or failed (`assignment_lost`). Then it
runs ready tasks (dependencies completed), bounded by `maxTasksPerRun`, retries provider failures up to
`maxAttempts` via the workforce's own retry, verifies through a different agent, and persists after
every transition. `recover()` applies the same path to every non-terminal mission, which is what a
scheduler tick calls.

## States

| Word | Meaning |
| --- | --- |
| configured | D1 binding complete |
| enabled | `HABITAT_MISSIONS_ENABLED=true` |
| initialized | schema verified and the engine built |
| running | a scheduler tick used the engine since boot |
| verified | at least one mission reached `completed` |

`/system/status` reports `components.missions` separately, including migration readiness with
`appliedByRuntime: false`.

## Security audit (Phase Two)

**Finding 1 — owner provenance was self-asserted.** `provenance.source: "owner"` was any string; an
in-process agent holding the repository could write a "verified fact" as the owner. Fixed by
`ax-owner-attestation.mjs`: an HMAC over the exact written fields (project, key, kind, statement, tags,
confidence, operation), with a TTL and constant-time verification. The memory repository accepts
`ownerPolicy: "required"` and then refuses unsigned owner writes; identity directives refuse unsigned
owner claims whenever a verifier is configured. Remaining limitation: the bridge currently constructs
the memory repository in `optional` mode unless a key is supplied, so route-authenticated owner writes
keep working; repository-level owner trust is only closed when `HABITAT_OWNER_ATTESTATION_KEY` is set.
This is recorded, not hidden.

**Finding 2 — backup integrity was not authenticity.** A SHA-256 digest detects corruption but an
attacker who can edit entries can recompute it. Backups now carry an HMAC (`mac`) over project, export
time, entry count and digest. `restoreMemory` refuses a signed backup whose MAC does not verify, and
`requireSigned` refuses unsigned documents outright. Without a signing key the export is explicitly
`signed: false` and remains integrity-only — an honest limitation, not a claim of authenticity.

## Staging procedure for 0011 (not applied)

Mirror of the workforce procedure:

1. Preflight (read-only): the runtime's own schema check, or `SELECT name FROM sqlite_master` for
   `habitat_ax_missions` / `habitat_ax_mission_events`.
2. Record a Time Travel bookmark or export before writing.
3. Apply `migrations/0011_ax_missions.sql` (`wrangler d1 execute … --file`); every statement is
   `IF NOT EXISTS`, so a re-run is a no-op.
4. Re-check: both tables present; restart with the flag unset and confirm `/system/status` shows
   `missions: disabled` and nothing else changed.
5. Only on separate activation approval: set `HABITAT_MISSIONS_ENABLED=true` **and** attach a workforce
   (`HABITAT_WORKFORCE_ENABLED=true` + 0010 applied); otherwise the runtime reports
   `worker_unavailable` rather than pretending to run.
6. Rollback: drop the two mission indexes and two tables after export. Mission history is lost.

## Tests

15 engine tests: complete execution, partial failure, retry then success, worker loss and return,
restart between assignment and completion without a duplicate assignment, `recover()`, verification
failure with gaps, approval-required with signed/unattested decisions, duplicate submission, planning
validation, schema-missing refusal, enabled runtime through the scheduler, scheduler attachment, and
disabled-by-default with zero storage reads. 8 owner-security tests cover the audit findings.

## Not done

- No model-backed planning: plans are deterministic from the specification.
- Executors are injected; no code executor is attached to a deployment, so a real deployment can
  coordinate missions but cannot yet implement code changes.
- Missions do not write results into memory yet (learning from verified outcomes is still a follow-up).
- Acceptance Test E (a real software-building mission in an environment) is not satisfied by these
  local tests.
