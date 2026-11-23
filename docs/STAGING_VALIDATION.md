# Staging validation — Mission 12

## Status

**Not run.** No disposable staging D1 database or staging credentials were available in this
environment, so no D1 request was made. The harness is implemented and refuses to act without an
explicit staging configuration. This document is the exact procedure and the owning actions needed.

Production was not accessed. No migration was applied anywhere. No Render environment variable was
read or changed.

## What the harness proves when run

`scripts/staging-demo.mjs` has two phases, intended to run in two separate processes against one
disposable staging database:

1. `write`: create a durable objective, record a plan, request approval, confirm execution is blocked
   without approval, authorize with the owner-supplied approval id, reserve budget, perform a real
   read-only repository inspection with `node --check`, record evidence, settle cost, verify,
   complete, append a security event and record a notification.
2. `verify`: a new process reads the objective, evidence, accounting and audit head from D1 and
   confirms the same result. This is the restart/reconstruction proof.

The local `npm run demo:objective` is **not** a substitute for this staging run. Its owner identity
is simulated and its stores are in memory.

## Required staging environment (names only; never commit values)

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | staging account |
| `HABITAT_D1_DATABASE_ID` | disposable staging database, not production |
| `HABITAT_D1_API_TOKEN` | scoped D1 token |
| `STAGING_ALLOW_WRITES` | must be exactly `true` |
| `STAGING_OBJECTIVE_KEY` | unique per run, e.g. `staging:m12:2026-11-22` |
| `STAGING_OWNER_APPROVAL_ID` | approval id created through the real owner route |
| `STAGING_BUDGET_USD` | optional, default `0.01` |
| `STAGING_OBJECTIVE_ID` | printed by `write`, passed to `verify` |

The harness never prints these values. It reports only the names of missing variables.

## Owner setup needed

1. Create a disposable D1 database dedicated to staging. Do not reuse production.
2. Create a D1 API token limited to that database/account.
3. Apply migrations `0001`–`0005` to the staging database through the owner's normal authorized D1
   process. Verify the tables and indexes listed below. Do not apply them to production as part of
   this validation.
4. Put the four credentials in the staging environment. They are not to be sent through chat or
   committed to the repository.
5. Approve the objective through the real owner device route and record the approval id as
   `STAGING_OWNER_APPROVAL_ID`. The harness refuses rather than inventing a device proof.
6. Run phase one, then phase two in a separate process.

## Commands

```bash
# 1. Write and locally execute the harmless inspection against staging D1.
npm run staging:demo -- write

# 2. Reconstruct from D1 in a fresh process.
STAGING_OBJECTIVE_ID=<id printed by phase write> npm run staging:demo -- verify
```

Exit code `2` means refused or failed; the JSON body states the missing input or the failed step.
The harness does not require a web server. It uses the same D1 repositories as the deployment.

## Schema to verify in staging

- `habitat_command_tasks` and its indexes (0001/0002)
- `habitat_ax_memory`, `habitat_ax_notifications` (0003)
- `habitat_ax_objectives`, `habitat_ax_incidents` (0004)
- `habitat_ax_security_events` with `UNIQUE(seq)` and category/created-at indexes (0005)
- `habitat_ax_scheduler` with one `primary` row (0005)

Re-run the migration files once after applying them. Every statement is additive and idempotent;
nothing should change. Confirm objectives, tasks and memory rows created before 0005 are still
present.

## Local evidence and its limits

`npm run migrations:check` validates the SQL against in-memory SQLite: fresh creation, upgrade from
0004, repeat execution, unique index, and data preservation (18/18). `tests/d1-http-compat-mission-12.test.mjs`
drives the real D1 repositories through the D1 HTTP shape with SQLite as the engine, including
concurrent security appends and objective CAS. The multi-process scheduler test uses a SQLite file as
a durable harness.

These prove SQL shape, repository parsing, CAS and sequence behavior. They do **not** prove:

- Cloudflare D1 latency, limits, or `RETURNING`/transaction differences on the deployed service.
- That the staging or production database actually has the schema.
- That Render is configured with the right database id or secrets.
- That a staging run happened.

## SQLite / D1 differences to watch

- SQLite accepts the SQL used here; D1 is SQLite-compatible but enforces its own API, statement
  limits and parameter rules.
- The emulator returns one result set per statement; D1 may return additional metadata fields.
- `BEGIN IMMEDIATE` is used only by the local scheduler harness, not by the D1 adapter.
- D1's HTTP latency is not represented by local measurements.

## Database identity and Render metadata

The actual production database identity and Render service metadata were **not** verified in this
mission because no authorized read-only credentials or dashboard access were supplied to this
environment. No identity is inferred from a URL, an old note or a configuration value. If the owner
provides read-only metadata access, record the database name/id and service name without recording
credentials or connection strings.

## Production boundary

Do not point this harness at production. Do not set `STAGING_ALLOW_WRITES` in a production
environment. Do not use a production API token. The harness cannot distinguish staging from
production, so this is an operator decision and must be made deliberately.
