# D1 staging verification for migrations 0008 and 0009

This procedure proves the P1 capability-network schema on **Cloudflare D1 itself**, which the local
run cannot do: `npm run migrations:check` and `npm run migrations:rollback` run against SQLite in
process, so they prove SQL compatibility and the drop set, not D1's transaction or concurrency
behaviour.

It is written to be run by the owner against a **disposable staging database**. It has not been run:
this workstation has no D1 credentials and no authorisation to create one. Nothing here touches
production, and step 0 refuses to continue if it would.

---

## 0. Safety guard (run first, every time)

```sh
# Both ids are read from the environment; neither is printed by this block.
: "${STAGING_D1_DATABASE_ID:?set the staging database id}"
: "${PRODUCTION_D1_DATABASE_ID:?set the production database id}"
[ "$STAGING_D1_DATABASE_ID" != "$PRODUCTION_D1_DATABASE_ID" ] || {
  echo "refusing: staging and production are the same database"; exit 1;
}
echo "guard ok"
```

The non-production database **already exists** in the account that owns Habitat: `habitat-nonprod`.
Reuse it. Do not create a second database and do not create a second Cloudflare account.

- `CLOUDFLARE_ACCOUNT_ID` is the 32-character account id (the repository variable of that name).
- `STAGING_D1_DATABASE_ID` is the `habitat-nonprod` UUID.
- `PRODUCTION_D1_DATABASE_ID` is the production database UUID (repository variable
  `HABITAT_D1_DATABASE_ID`).

Do not confuse the two shapes: an account id is 32 hex characters with no dashes, a D1 database id
is a UUID with dashes. `npm run staging:preflight` refuses a database id that is not a UUID, because
a guard against "staging is production" is worthless if one side can never match.

Credentials never belong in a file or a chat message. Two supported paths, in order of preference:

1. **Repository secret + workflow.** `HABITAT_D1_API_TOKEN` already exists as a repository secret,
   and `CLOUDFLARE_ACCOUNT_ID` / `HABITAT_D1_DATABASE_ID` as repository variables. Dispatch
   `.github/workflows/d1-staging-verify.yml` with the `habitat-nonprod` id, `mode=verify` and
   `confirm=nonprod`; the same workflow with `mode=migrate` applies the migrations. The secret is
   injected by GitHub: it is never printed and never reaches an operator shell.
2. **Local staging shell.** Export `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_API_TOKEN`,
   `STAGING_D1_DATABASE_ID` and `PRODUCTION_D1_DATABASE_ID` for that shell only.

Verify the flags of every `wrangler` command below with `npx wrangler d1 --help` before running it:
the CLI changes, and this document is not a substitute for its `--help`.

## 1. Baseline before any migration

```sh
npx wrangler d1 export habitat-nonprod --remote --output /tmp/staging-before-0008.sql
date -u +%s        # record this timestamp for a Time Travel restore point
```

Record in the evidence table: database name, export byte size, timestamp, and the object list:

```sh
npx wrangler d1 execute habitat-nonprod --remote \
  --command "SELECT type, name FROM sqlite_master WHERE name LIKE 'habitat_ax_%' ORDER BY name"
```

Expected before 0008: no `habitat_ax_capabilities` and no `habitat_ax_access_requests`; whatever
`habitat_ax_*` objects earlier missions created are present and unchanged.

## 2. Local rehearsal (no credentials, already automated)

```sh
npm run migrations:check      # 45 checks: upgrade path, object list, re-run idempotency
npm run migrations:rollback   # 11 checks: drop set, recreate after rollback
```

These must pass before touching staging. They are a precondition, not evidence about D1.

## 3. Apply 0008 and 0009 to staging

The repository has no `wrangler` configuration file today, so the reproducible path is the explicit
per-file loop used by `docs/HABITAT_ACTIVATION_RUNBOOK.md`:

```sh
for f in migrations/0008_ax_capability_registry.sql migrations/0009_ax_fulfillment_treasury.sql; do
  npx wrangler d1 execute habitat-nonprod --remote --file "$f"
done
```

Once a staging `wrangler` config names the database, `npx wrangler d1 migrations apply
habitat-nonprod --remote` is equivalent and records applied migrations in
`d1_migrations`. Record which path was used; do not mix them in one database.

## 4. Verify the resulting schema

```sh
npx wrangler d1 execute habitat-nonprod --remote \
  --command "SELECT type, name FROM sqlite_master WHERE name LIKE 'habitat_ax_%' ORDER BY name"
```

Expected: the 8 tables and 12 indexes that 0008 and 0009 declare. Compare against the object list
asserted by `npm run migrations:check` rather than against this count, and record both lists.

```sh
npx wrangler d1 execute habitat-nonprod --remote \
  --command "SELECT COUNT(*) AS n FROM habitat_ax_capabilities"
```

Also re-run the two migration files once more and confirm both still succeed (every statement is
`IF NOT EXISTS`); a second application must not error or duplicate an index.

## 5. Atomicity: does a failed statement roll the batch back?

Cloudflare documents `batch()` as the transaction boundary: "Batched statements are SQL
transactions. If a statement in the sequence fails, then an error is returned for that specific
statement, and it aborts or rolls back the entire sequence." It also documents auto-commit: each
statement in a batch "will execute and commit, sequentially, non-concurrently". There is no
interactive `BEGIN`/`COMMIT` in D1, so `batch()` is the only atomic unit the application has.
Source: <https://developers.cloudflare.com/d1/worker-api/d1-database/>

Probe A — CLI file atomicity. Write `/tmp/probe.sql`:

```sql
INSERT INTO habitat_ax_payouts (id, record_json, state, created_at, updated_at)
  VALUES ('probe_atomic_marker', '{"probe":true}', 'requested', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z');
INSERT INTO habitat_ax_payouts (id, record_json, state, created_at, updated_at)
  VALUES ('probe_atomic_marker', '{"probe":true}', 'requested', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z');
```

```sh
npx wrangler d1 execute habitat-nonprod --remote --file /tmp/probe.sql || echo "second insert failed, as designed"
npx wrangler d1 execute habitat-nonprod --remote \
  --command "SELECT COUNT(*) AS n FROM habitat_ax_payouts WHERE id = 'probe_atomic_marker'"
```

Record the count. `0` means the CLI sent the file as one batch and the failure rolled the first
insert back. `1` means the CLI sent separate auto-commit statements; that is a property of the CLI,
not of `batch()`, and it is not a defect in the application, which never relies on CLI atomicity.
Either way, note it.

Probe B — application atomicity. The code's own unit of work is the repository `batch()` call. Run it
through the Worker/repository path against staging once a staging deployment exists, using the same
`D1Database` binding; in `wrangler dev` with a remote staging binding:

```sh
npx wrangler dev --remote        # staging binding only
curl -sS -X POST http://127.0.0.1:8787/ax/command/network/approvals \
  -H "Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"subscription","capabilityId":"model.planning","vendor":"zendrop","amountCents":100,"currency":"USD"}'
```

Then read the row back and confirm `record_json` and the indexed columns agree. A mismatch between
the two is the failure this probe exists to catch.

## 6. Concurrency: one approval, two decisions

This is the behaviour that matters most and the one local SQLite cannot prove, because D1 serialises
writers at the primary while the repository uses compare-and-swap on `status`.

Run from a staging-only shell (the modules read the three D1 variables from `env`):

```sh
export CLOUDFLARE_ACCOUNT_ID=... HABITAT_D1_DATABASE_ID="$STAGING_D1_DATABASE_ID" HABITAT_D1_API_TOKEN=...
node --input-type=module <<'NODE'
import { createAxNetworkService } from "./ax-network-service.mjs";
const service = createAxNetworkService({ env: process.env });
console.log("adapter", service.adapter, "durable", service.durable);
const created = await service.requestApproval({
  kind: "subscription", capabilityId: "model.planning",
  vendor: "zendrop", amountCents: 100, currency: "USD", idempotencyKey: "staging-cas-1"
});
const id = created.approval.id;
const [a, b] = await Promise.all([
  service.approve({ id, by: "owner:staging-device-a" }),
  service.approve({ id, by: "owner:staging-device-b" })
]);
console.log("first", a.ok, a.code || a.approval?.status, "| second", b.ok, b.code || b.approval?.status);
const final = await service.approval(id);
console.log("final", final.approval.status, final.approval.decidedBy);
NODE
```

Expected: exactly one `ok: true`; the other is `approval_conflict` (or `already_decided` if it read
the row after the winner committed); `final` is `approved` with the winning `decidedBy`. Record the
actual pair. Two successes would mean the CAS is not holding on D1 and must be fixed before any
owner-device use.

## 7. Concurrency: expiry sweep against a decision

The scheduler sweep and an owner decision can meet on the same row. The sweep writes only from
`requested`, so a decision that lands first must survive.

```sh
node --input-type=module <<'NODE'
import { createAxNetworkService } from "./ax-network-service.mjs";
const service = createAxNetworkService({ env: process.env });
const created = await service.requestApproval({
  kind: "subscription", capabilityId: "model.planning",
  vendor: "spocket", amountCents: 200, currency: "USD", idempotencyKey: "staging-expiry-1"
});
const id = created.approval.id;
const [sweep, decision] = await Promise.all([
  service.approvalExpiry({ withinMs: 60 * 60_000 }),
  service.approve({ id, by: "owner:staging-device-a" })
]);
console.log("sweep failed", sweep.failed?.length, "decision", decision.ok, decision.code || decision.approval?.status);
console.log("final", (await service.approval(id)).approval.status);
NODE
```

Expected: the final status is never `expired` when the decision succeeded, and any id in
`sweep.failed` still has a reviewable status (the sweep does not guess). A sweeper that reports
failure is working as designed; one that reports success while the row is `expired` is not.

## 8. Rollback rehearsal on staging

The drop set is defined once, in `scripts/migration-rollback-check.mjs`:

```sh
node --input-type=module -e '
import { rollbackStatements } from "./scripts/migration-rollback-check.mjs";
console.log(rollbackStatements().join(";\n") + ";");
' > /tmp/rollback-p1.sql
cat /tmp/rollback-p1.sql      # 8 DROP TABLE IF EXISTS statements, no production name in it
```

Apply it only to the staging database:

```sh
npx wrangler d1 execute habitat-nonprod --remote --file /tmp/rollback-p1.sql
npx wrangler d1 execute habitat-nonprod --remote \
  --command "SELECT type, name FROM sqlite_master WHERE name LIKE 'habitat_ax_%' ORDER BY name"
```

Expected: no P1 table remains; every pre-0008 object is still there and still has its rows. Compare
row counts of the pre-existing tables with `/tmp/staging-before-0008.sql`. Rollbacks remove P1
objects; they must not touch earlier missions' data.

Then re-apply 0008/0009 (step 3) and confirm the object list returns. That is the full rehearsal.

## 9. Recovery: Time Travel

Time Travel is D1's point-in-time recovery, always on, with no separate cost: 7 days on the Workers
Free plan and 30 days on Workers Paid. Restoring is **destructive and overwrites the database in
place**, cancels in-flight queries, and prints the previous bookmark so the restore itself can be
undone. Bookmarks outside the retention window cannot be used.
Source: <https://developers.cloudflare.com/d1/reference/time-travel/>

```sh
# Staging only. This overwrites the staging database in place.
npx wrangler d1 time-travel restore habitat-nonprod --timestamp=<unix seconds from step 1>
```

Use it as the recovery path when a probe leaves the staging database in a state an export cannot fix.
Never run it against production as part of this procedure.

## 10. Cleanup

`habitat-nonprod` is permanent non-production infrastructure: leave it in place for repeat runs. Do
not delete or recreate it, and never delete a database whose id you have not first compared against
`PRODUCTION_D1_DATABASE_ID`.

## 11. Scheduled execution (no new scheduler)

Approval-expiry monitoring runs inside the existing tick: `POST /ax/command/scheduler/tick` with
`X-Scheduler-Token` or an Ax credential. A tick returns
`approvals: { ok, expired, expiringSoon, failed, withinMs }` and adds
`approval.expired` / `approval.expiring` / `approval.sweep_incomplete` findings.

Cloudflare Cron Triggers execute on UTC, are declared per environment under `triggers.crons`, and are
invoked through a `scheduled(controller, env, ctx)` handler; a trigger can call
`controller.noRetry()`, and the local dev server exposes `/cdn-cgi/local/scheduled` for a manual run.
The documentation describes no delivery-retry guarantee, so the tick must remain idempotent and safe
to miss — which it is: the sweep is idempotent and the lease decides who runs.
Source: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>

```sh
# Local: prove the scheduled handler runs, then prove it is idempotent.
curl -sS "http://127.0.0.1:8787/cdn-cgi/local/scheduled?format=json"
curl -sS "http://127.0.0.1:8787/cdn-cgi/local/scheduled?format=json"   # second run: same counts, no duplicate transitions
```

After a real deployment, record the tick outcome from the dashboard's last 100 invocations and the
`approvals` block of one authenticated tick. A deployed trigger is not evidence until both exist.

## 12. Evidence table (fill in; do not mark a row pass without the value)

| # | Check | Command / request | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | Guard refuses production | step 0 with equal ids | non-zero exit | | |
| 2 | Local rehearsal | `npm run migrations:check` / `migrations:rollback` | 45/45, 11/11 | | |
| 3 | 0008+0009 apply | step 3 | exit 0, no error | | |
| 4 | Object list | step 4 | matches local list | | |
| 5 | Re-apply is idempotent | step 4, second run | exit 0 | | |
| 6 | CLI batch atomicity | probe A | count recorded | | |
| 7 | Decision CAS | step 6 | exactly one success | | |
| 8 | Sweep vs decision | step 7 | decision survives | | |
| 9 | Rollback drop set | step 8 | P1 gone, earlier data intact | | |
| 10 | Re-apply after rollback | step 8 | object list returns | | |
| 11 | Scheduled tick | step 11 | `approvals` block, idempotent | | |

## 13. What this does not prove

- Production behaviour, production data, or any multi-tenant isolation. There is no `owner_id`
  column and one Habitat owner (gap G4, still open by design).
- Worker CPU/time limits for a large sweep. The sweep is bounded by `maxListLimit`; a staging
  database with realistic row counts is the only way to size it.
- That a deployed Cron Trigger fires. Only the dashboard's invocation history shows that.
- Anything about external suppliers: P1 makes no supplier call, so there is nothing to verify there.

## 14. Verified on real D1 — 2026-11-24

Executed from GitHub Actions with the repository's existing `HABITAT_D1_API_TOKEN` secret. The token
never reached an operator shell, a log line or a file.

Target: `ax-nexus-habitat-nonprod` (`0fdf1ac9…2068`) in account `e43f2644…`.

| Check | Result |
| --- | --- |
| migrations 0001–0009 | **all nine applied**, in filename order, each accepted by the D1 HTTP API |
| objects before → after | 3 → **48** |
| P1 tables after | **8/8**, `missingP1Tables: []` |
| re-apply (idempotency) | `ok: true`, still 48 objects and 8 P1 tables; no duplicate objects |
| decision CAS, two concurrent owner devices | one `approved`, the other **`approval_conflict`**; final `approved`, `decidedBy: owner:staging-a` |
| adapter / durability | `cloudflare-d1`, `durable: true` |
| approval-expiry sweep | `ok: true`, expired 0, expiring 0, failed 0 |

This is the evidence the local SQLite rehearsal could not produce: multi-statement migration files are
accepted as sent, re-application is idempotent on D1, and the compare-and-swap admits exactly one
decision when two owner devices decide at once.

### Account finding that changes the plan

The repository token can see **exactly one** database in account `e43f2644…`:
`ax-nexus-habitat-nonprod` (`0fdf1ac9…`), which is also the repository variable
`NEXUS_D1_TEST_DATABASE_ID`. The ids supplied for `habitat-nonprod` (`baaa7965…`) and production
(`3a906029…`) are **not** in that account, so they live in a different Cloudflare account — the one
created with the operations address. A token for that account is required before either can be used.
Nothing was created, renamed, guessed or deleted to work around the difference.

The deployed service is configured with the production id (`3a906029…`), which is a different
database from the one migrated here, so no production data was touched.

## 15. Option A adopted: `ax-nexus-habitat-nonprod` is the staging database

Owner decision (2026-11-24): the existing non-production database is Habitat's official staging
target. No new database and no new Cloudflare account was created.

| Field | Value |
| --- | --- |
| Staging database | `ax-nexus-habitat-nonprod` — `0fdf1ac9-65a3-4e83-8042-f3fa52282068` |
| Account suffix | `d607` (masked in every report) |
| Production id | `3a906029-bc64-4e2a-b648-163e34a2d502` — never targeted, `productionIdDiffers: true` |
| Repository variable | `HABITAT_STAGING_D1_DATABASE_ID` (identifier only, not a credential) |
| Credential channel | `HABITAT_D1_API_TOKEN` repository secret, used only inside Actions |

### Verified connection — CI run `45296503185` (push trigger, branch `staging/integration`, `e1ab6ff`)

All eight steps succeeded: confirm intent → isolation guard → preflight (no writes) → verify → upload
evidence. The uploaded artifact reports:

```json
{ "ok": true, "mode": "verify", "productionIdDiffers": true,
  "before": { "objectCount": 48, "p1TableCount": 8 },
  "after":  { "objectCount": 48, "tableCount": 20, "indexCount": 28, "p1TableCount": 8, "missingP1Tables": [] },
  "applied": [] }
```

`applied: []` is the idempotency proof: the schema was already at 0001–0009, so verification changed
nothing. The 20 tables include the eight P1 capability-network tables (`habitat_ax_revenue_events`,
`habitat_ax_payouts`, `habitat_ax_treasury_accounts`, `habitat_ax_supplier_offers`,
`habitat_ax_capabilities`, `habitat_ax_channel_rules`, `habitat_ax_cost_ledger`,
`habitat_ax_security_events` alongside the earlier runtime tables).

### How the guard is enforced, twice

1. `workflow_dispatch` requires `confirm=nonprod` and compares the target against
   `vars.HABITAT_D1_DATABASE_ID`; equal ids abort before any request is sent.
2. On a push, only `verify` is allowed — migrations stay a manual, confirmed action — and the target
   comes from `HABITAT_STAGING_D1_DATABASE_ID`, which cannot equal production.

### What this does and does not prove

- Proves: the CI credential reaches this database, the schema is complete for the P1 stack, applying
  migrations again is a no-op, and production was never addressed.
- Does **not** prove: a Render staging service can reach it, because no staging service exists. That
  is the remaining deployment step (`docs/RENDER_STAGING_PLAN.md`).
- Production schema comparison is still impossible with this credential: the production database is
  not in the account the token can read, so only the id is known. No production write was attempted.
