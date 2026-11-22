# Staging validation results — Mission 13

Staging status: NOT RUN — owner-blocked
Owner action: create a disposable Cloudflare D1 database dedicated to staging, create a scoped D1 API token, apply migrations 0001–0005 there, supply `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN`, `STAGING_ALLOW_WRITES=true`, `STAGING_OBJECTIVE_KEY` and a real owner approval id `STAGING_OWNER_APPROVAL_ID` in the staging environment, then run `npm run staging:demo -- write` and, in a separate process, `STAGING_OBJECTIVE_ID=<id> npm run staging:demo -- verify`.

**No staging request was made. No production request was made. No database was identified, migrated or written.** This document records what was validated locally, what the harness does, and the exact remaining owner sequence. It must not be cited as staging evidence.

## Why staging did not run

At the start of Mission 13 the environment contained none of the staging variable names (checked by name only; no values were printed), no Render credential, no Cloudflare credential and no owner approval id. The harness therefore refused before any network call:

```json
{
  "ok": false,
  "code": "staging_not_configured",
  "missing": [
    "CLOUDFLARE_ACCOUNT_ID",
    "HABITAT_D1_DATABASE_ID",
    "HABITAT_D1_API_TOKEN",
    "STAGING_ALLOW_WRITES",
    "STAGING_OBJECTIVE_KEY",
    "STAGING_OWNER_APPROVAL_ID"
  ],
  "note": "No staging request was made. Production is not accessed by this harness."
}
```

Exit code was `2`. This proves the refusal path, not staging persistence.

## Staging database identity

Not confirmed. No database name, id, fingerprint or account metadata was available. Identity must be recorded from the owner's Cloudflare dashboard without copying credentials. The harness cannot distinguish staging from production, so using a production id would be an unauthorized production write; it was not attempted.

## Migrations

| Evidence level | Result |
| --- | --- |
| Locally tested (`node:sqlite`) | 18/18 checks pass: fresh 0001–0005, upgrade from 0004, repeat/idempotent execution, unique security sequence, schema objects retained |
| Staging verified | **Not run** — no staging database |
| Production verified | **Not run** — production is out of scope |

Required staging schema after applying 0001–0005: `habitat_command_tasks` and indexes, `habitat_ax_memory`, `habitat_ax_notifications`, `habitat_ax_objectives`, `habitat_ax_incidents`, `habitat_ax_security_events` with `UNIQUE(seq)`, `habitat_ax_scheduler` with the `primary` row. Pre-existing unrelated records must be counted before and after; no statement in 0001–0005 drops or rewrites a table.

## Harness validation (local only)

`scripts/staging-demo.mjs` was inspected and exercised only on its refusal path. It:

- requires all six staging inputs, including an owner approval id, before constructing D1 repositories;
- refuses if `STAGING_ALLOW_WRITES` is not exactly `true`;
- creates an objective, records understanding and a plan with `requiresApproval: true`, and proves `start` is blocked before authorization;
- authorizes with the owner-supplied approval id, reserves $0.001, runs the real read-only engineering transport (`repo.inspect` plus `node --check`), records digest evidence and a command exit code, settles at $0, verifies three criteria and completes;
- appends one security event and one notification;
- in `verify`, a separate process reads the same objective from D1 and checks status, verification, zero reserved budget and audit integrity.

Local tests for the refusal/configuration logic: `tests/staging-harness.test.mjs` 2/2.

The harness does **not** yet exercise scheduler state, project-scoped memory or a scheduler lease against staging. Those remain required checks in the owner run below and are not claimed. The local multi-process scheduler and D1-shaped tests in Mission 12 cover their repository behavior, not staging.

## Required staging checks — status

| Check | Status |
| --- | --- |
| A. Confirm database identity and non-production designation | NOT RUN |
| A. Apply and verify migrations 0001–0005, preserve unrelated records | NOT RUN |
| B. Owner authorization with a real staging approval | NOT RUN |
| B. Objective, reservation, local task, settlement, audit, notification | NOT RUN |
| B. Scheduler state write and inspect | NOT RUN |
| B. Project-scoped memory through the staging repository | NOT RUN |
| C. Process 1 writes, exits; process 2 reconnects and reconstructs | NOT RUN |
| D. Unauthorized write refused | NOT RUN against staging; covered in local auth tests |
| D. Duplicate/conflicting settlement refused | NOT RUN against staging; covered in adversarial accounting tests |
| D. Budget overspend refused | NOT RUN against staging; covered in adversarial accounting tests |
| D. Stale reservation recovery | NOT RUN against staging; covered in scheduler tests |
| D. Audit chain integrity | NOT RUN against staging; local chain tests pass |
| D. Scheduler lease fencing / stale writer rejection | NOT RUN against staging; four-process SQLite harness passes |
| D. Failed operations do not leave partial state | NOT RUN against staging |
| E. Remove only demonstration records; record cleanup | NOT RUN — no records exist |

## Exact owner run

1. In Cloudflare, create a **disposable** D1 database named for staging only. Record its non-secret name and id; do not reuse the production database.
2. Create a D1 API token limited to that account/database. Place it only in the staging environment or the owner's secret store.
3. Apply `migrations/0001` through `0005` in order through the owner's authorized D1 process. Record the before/after counts of unrelated tables and rows.
4. Create one owner approval through the real owner route for a harmless read-only staging objective. Record the approval id.
5. Export, in the staging shell only:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=...        # staging account
   export HABITAT_D1_DATABASE_ID=...       # staging database, never production
   export HABITAT_D1_API_TOKEN=...         # scoped token
   export STAGING_ALLOW_WRITES=true
   export STAGING_OBJECTIVE_KEY="staging:m13:$(date -u +%Y%m%dT%H%M%SZ)"
   export STAGING_OWNER_APPROVAL_ID=...
   ```

6. Run `npm run staging:demo -- write`. Save the JSON result and the printed objective id. It contains identifiers and timestamps, not credentials.
7. In a **new process**, run `STAGING_OBJECTIVE_ID=<id> npm run staging:demo -- verify`. Save its JSON result and exit code.
8. Run the identity and preservation queries above (read-only) and record counts. Verify the audit head and scheduler row.
9. Cleanup only if the staging database is explicitly disposable and the harness records are identified by the staging objective key/prefix. Never drop core tables or delete unrelated rows. Record exactly what was removed. If cleanup is not explicitly supported, leave the records and say so.

Pass criteria: process 2 exits 0, objective is completed and verified, reserved amount is zero, the audit chain verifies, the scheduler state reads back, project-scoped memory reads back, and unrelated records are unchanged. Anything less is not staging verification.

## Production boundary

Production D1 was not contacted. No production migration, seed, cleanup or secret change was made. Staging results must never be copied into the production manifest without a separate production run.

---

## Mission 14 addendum — 2026-11-22

**Mission 14 did not run staging either, for the same reason.** The environment still contains none
of the six staging variable names, no disposable D1 database and no owner approval id. The harness
was executed again and refused before any network call, so this document remains
`Staging status: NOT RUN — owner-blocked`.

What Mission 14 added that staging will exercise:

1. Migration `0006_ax_nexus_messages.sql` (additive, idempotent; validated locally against SQLite,
   22/22 migration checks).
2. The message channel (`/ax/command/messages`, `/ax/nexus/*`) with its own durable table.
3. An autonomy pass inside the scheduler tick that drains messages and dispatches eligible
   objectives.

The exact owner sequence is unchanged and is reproduced in `docs/HABITAT_ACTIVATION_RUNBOOK.md` §1.
No production database was contacted, read or modified.
