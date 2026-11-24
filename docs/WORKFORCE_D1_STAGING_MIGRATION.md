# Workforce D1 migration — staging procedure

Scope: apply `migrations/0010_ax_workforce.sql` to the **staging** D1 database only. Production is out
of scope, and nothing in this document authorizes activation: the workforce stays disabled unless
`HABITAT_WORKFORCE_ENABLED` is explicitly set to `"true"` on the service.

## What is being added

Five tables and five indexes, all additive:

| Table | Purpose |
| --- | --- |
| `habitat_ax_worker_adapters` | provider adapters as records (id, kind, replaceable) |
| `habitat_ax_workers` | agent records, health and revision as last observed |
| `habitat_ax_worker_assignments` | task ownership, attempts, workspace key, one active row per task |
| `habitat_ax_worker_results` | evidence, tests, verification, `approval_state` |
| `habitat_ax_worker_audit` | append-only history, ordered by `seq` |

The partial unique index `habitat_ax_worker_assignments_active_task` is a guarantee, not a convention:
it makes a second live assignment for the same task impossible, including from two processes.

## State words

| Word | Meaning here |
| --- | --- |
| configured | the D1 binding (account id, database id, token) is present |
| initialized | the runtime hydrated agents and in-flight assignments from the store |
| enabled | `HABITAT_WORKFORCE_ENABLED=true` — an operator decision |
| running | a scheduler step has actually used intake or the runner since boot |
| verified | an independent verifier produced a stored `verified` result |

A database with the tables applied is **configured and migratable**, not initialized, not enabled and
not running. `/system/status` reports all five separately under `components.workforce`.

## 1. Preflight (read-only)

```bash
CLOUDFLARE_ACCOUNT_ID=... \
HABITAT_D1_DATABASE_ID=... \
HABITAT_D1_API_TOKEN=... \
npm run workforce:preflight
```

The script sends only `SELECT`s. It prints `schema.missing` and exits non-zero when the migration is
absent. Record the output with the migration ticket.

Also confirm the migration set is internally consistent before touching a database:

```bash
npm run migrations:check      # applies 0001…0010 repeatedly to in-memory SQLite
npm run migrations:rollback   # proves 0010's tables/indexes can be removed and recreated
```

## 2. Backup before writing

Either is acceptable; keep the artifact with the ticket.

1. **Time Travel bookmark** — Cloudflare dashboard → D1 → the staging database → Time Travel. Record the
   timestamp. This is the fastest recovery point for an accidental write.
2. **Export** — dashboard → D1 → Export (SQL), or
   `npx wrangler d1 export <staging-db> --remote --output=workforce-pre-0010.sql`.

The migration is additive, so a normal apply does not modify existing rows. The backup exists for the
case that is not normal: an apply run against the wrong database, or a later decision to remove the
tables and their history.

## 3. Apply

```bash
npx wrangler d1 execute <staging-db> --remote --file migrations/0010_ax_workforce.sql
```

Idempotency: every statement is `CREATE TABLE IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS`, so a
re-run is a no-op. That is verified locally by `npm run migrations:check`, which applies the whole set
twice and asserts preserved rows; it does not by itself prove the hosted apply succeeded.

## 4. Post-migration verification

1. Re-run the preflight: `ok: true`, `schema.missing: []`, and the counts reported.
2. Confirm no change to application behavior with the flag off: deploy/restart the staging service with
   `HABITAT_WORKFORCE_ENABLED` **unset**, then check
   `/system/status` → `components.workforce.state` is `disabled` and every other component matches the
   previous response.
3. Only under separate activation approval: set `HABITAT_WORKFORCE_ENABLED=true`, restart, and check
   `/system/status` → `initialized: true`, `recoveredAssignments` and `counts.agents`. `running` and
   `verified` stay false until a scheduler tick actually delegates.
4. To prove restart recovery in staging: let one tick delegate, restart the service, and confirm
   `recoveredAssignments` is at least 1 and the assignment is still `active`.

## Rollback

Prefer forward fixes. The tables are additive, so the safest rollback is to stop writing and leave them
in place. If removal is genuinely required:

```sql
DROP INDEX IF EXISTS habitat_ax_worker_assignments_active_task;
DROP INDEX IF EXISTS habitat_ax_worker_assignments_agent;
DROP INDEX IF EXISTS habitat_ax_worker_audit_action;
DROP INDEX IF EXISTS habitat_ax_worker_results_task;
DROP INDEX IF EXISTS habitat_ax_workers_specialty;
DROP TABLE IF EXISTS habitat_ax_worker_audit;
DROP TABLE IF EXISTS habitat_ax_worker_results;
DROP TABLE IF EXISTS habitat_ax_worker_assignments;
DROP TABLE IF EXISTS habitat_ax_workers;
DROP TABLE IF EXISTS habitat_ax_worker_adapters;
```

This discards workforce history: assignments, evidence, verification results and audit. Export first.
`npm run migrations:rollback` demonstrates that these statements restore the pre-0010 schema and
recreate the tables cleanly afterwards, but that harness runs on in-memory SQLite — it is evidence about
the statements, not about the staging database.

## Failure handling the runtime already implements

| Condition | Behavior |
| --- | --- |
| flag off | no query is issued, no store is created, no task is delegated |
| binding incomplete with flag on | `unconfigured`; refuses instead of falling back to memory |
| migration 0010 absent | `schema_missing`; the runtime does **not** create tables itself |
| hydration failure | `initialization_failed`; intake and runner refuse (`workforce_not_initialized`) |
| executor/provider throws | bounded retries, then `exhausted`; never a result |
| verifier missing | no verification, no `verified`; the result is recorded as unverified or skipped |
| worker missing or unavailable | released as `orphaned` or skipped; never executed |

## What this procedure does not authorize

Applying 0010 to staging changes no runtime behavior while the flag is off. Activating the workforce on
any environment, applying to production, merging to `main`, deploying, spending money or publishing
content all require explicit owner approval.
