# Revision 4.2 — Readiness, Migration, and Acceptance Runbook

This runbook is for a **nonproduction** Habitat environment. It does not authorize any production D1 access, deployment, secret change, phone command, or Android installation.

## Branch baseline

- Base: Revision 4.1, `113b14a61a0e64c7d19b753675573268b0ceaf92`
- Work branch: `ax-nexus/revision-4.2-readiness`
- Previous revision branches remain untouched.

## Nonproduction safety gate

Before running the backfill, set all of these explicitly in the shell that runs the script:

```bash
export HABITAT_RUNTIME_ENV=nonproduction
export NODE_ENV=development
export HABITAT_D1_DATABASE_ID='<nonproduction-d1-database-id>'
export CLOUDFLARE_ACCOUNT_ID='<cloudflare-account-id>'
export HABITAT_D1_API_TOKEN='<nonproduction-d1-api-token>'
export HABITAT_OWNER_DEVICE_IDS='<owner-device-id>[,<second-owner-device-id>]'
```

Requirements:

- `HABITAT_D1_DATABASE_ID` must be the nonproduction database. Compare it with the production database ID configured outside this runbook; if they match, stop.
- Do not paste secret values into source, chat, logs, or the mapping file.
- `HABITAT_OWNER_DEVICE_IDS` is authoritative. The CLI deliberately has no `--owners` override.
- Every owner must exist, be unrevoked, and have a nonempty credential hash. Every target device must already exist.
- A mapping where `deviceId === ownerDeviceId` is rejected as `self_ownership`.

## Migration sequence

### 1. Verify the branch and existing schema

```bash
git fetch origin
git switch ax-nexus/revision-4.2-readiness
git rev-parse HEAD
git status --short --untracked-files=no
```

The schema is additive. Revision 4.1 created:

- `habitat_device_ownership`
- `habitat_device_pairings`
- `habitat_paired_devices`
- `habitat_pairing_owners`
- `habitat_security_audit`
- `habitat_device_commands`

Do not drop or recreate these tables as part of this run.

### 2. Create an explicit mapping

Create a local file outside version control, for example `ownership-nonprod.json`:

```json
{
  "devices": [
    { "deviceId": "android-device-a", "ownerDeviceId": "owner-phone" },
    { "deviceId": "android-device-b", "ownerDeviceId": "owner-phone" }
  ]
}
```

Rules:

- A bare array of the same objects is also accepted.
- Each `deviceId` may appear only once.
- Maximum 5,000 rows.
- Do not use `"*"`, spaces, or path fragments as IDs.
- Do not map a device to itself.
- Do not infer owners from pairing order, last-seen time, device name, or a default owner.

### 3. Capture the existing ownership rows

Run a read-only query against the **nonproduction** database and retain the output locally:

```bash
npx wrangler d1 execute "$HABITAT_D1_DATABASE_ID" --remote \
  --command "SELECT device_id, owner_device_id, assigned_at FROM habitat_device_ownership ORDER BY device_id"
```

Store the result as `ownership-before-nonprod.json`. This is the rollback source of truth.

Also record a code/schema reference:

```bash
git rev-parse HEAD > revision-4.2-base.txt
```

### 4. Dry-run (must be completely side-effect-free)

```bash
node scripts/backfill-device-ownership.mjs --map ./ownership-nonprod.json
```

Expected behavior:

- Calls `preflightOwnership` for each row.
- Performs **no** `initialize()`, schema creation, ownership insert, audit insert, or other write.
- Reports `mode: "dry-run"`, `wouldAssign`, `alreadyAssigned`, `failed`, and a per-row result.
- Exits nonzero if any row fails.
- If the schema is absent, the read-only query fails safely. Dry-run does not create it.

Inspect every row. Do not continue if any row reports `owner_missing`, `owner_inactive`, `owner_revoked`, `owner_unauthorized`, `owner_authorization_required`, `device_not_paired`, `already_owned` with a different owner, `invalid_mapping`, or `self_ownership`.

### 5. Apply

Only after a clean dry-run:

```bash
node scripts/backfill-device-ownership.mjs \
  --map ./ownership-nonprod.json \
  --apply \
  --confirm APPLY_DEVICE_OWNERSHIP_BACKFILL
```

Expected behavior:

- Initializes the additive schema.
- Repeats the full preflight before each write.
- Inserts only when the target is unowned and the owner is still active.
- Rechecks after a conditional-write miss and reports the current reason.
- Writes one `device.ownership.backfilled` audit row for each newly assigned mapping.
- Reports `assignedAt`; keep the JSON report with the run ID.
- A rerun is safe: already-correct rows report `already_owned_same` and are not written or audited again.

### 6. Verify

```bash
npx wrangler d1 execute "$HABITAT_D1_DATABASE_ID" --remote \
  --command "SELECT device_id, owner_device_id, assigned_at FROM habitat_device_ownership ORDER BY device_id"
```

```bash
npx wrangler d1 execute "$HABITAT_D1_DATABASE_ID" --remote \
  --command "SELECT occurred_at, event, actor_device_id, target_device_id, detail_json FROM habitat_security_audit WHERE event = 'device.ownership.backfilled' ORDER BY occurred_at DESC LIMIT 20"
```

Confirm that only intended rows changed and that each new assignment has an audit row.

## Partial failure and rerun

Apply is not one transaction across all mappings.

- A failure after row N leaves rows 1..N committed.
- The command exits nonzero and prints the per-row report.
- Fix the cause (for example restore an owner or correct the mapping), then rerun the same command.
- Previously completed rows are detected by preflight as `already_owned_same`; they are not rewritten or re-audited.
- Do not delete ownership rows merely to make a rerun pass.

## Rollback

### Preferred: restore only rows written by this run

Use the apply report's `assignedAt` and the `ownership-before-nonprod.json` snapshot.

For each row that was newly assigned:

```sql
DELETE FROM habitat_device_ownership
WHERE device_id = ?
  AND owner_device_id = ?
  AND assigned_at = ?;
```

Do not delete a row that already existed before the run. If a row's owner changed unexpectedly, stop and inspect the audit table instead of overwriting it.

If audit rows must be removed for a nonproduction reset, delete only rows matching the exact run timestamp and event, after exporting them:

```sql
DELETE FROM habitat_security_audit
WHERE event = 'device.ownership.backfilled'
  AND occurred_at >= ?
  AND occurred_at <= ?;
```

Use a bounded timestamp window from the run report; never delete the whole audit table.

### Code rollback

Revert the Revision 4.2 branch in the nonproduction checkout, or redeploy the previous Revision 4.1 commit. The additive schema does not need to be dropped for code rollback. Dropping the tables destroys device ownership, pairing, commands, and audit evidence; do not do it unless the environment is disposable and that loss is explicitly approved.

### Pairing-state rollback

If a bad pairing/ownership test polluted the nonproduction environment:

1. Revoke the affected device through the owner or Ax path; this cancels queued/claimed commands and deletes that device's pairing codes.
2. Restore ownership only from the pre-run snapshot.
3. Do not reuse a consumed pairing code. Mint a fresh one.

## Rollback acceptance

After rollback:

- The ownership table matches the pre-run snapshot for the affected IDs.
- No target is self-owned.
- No revoked or inactive owner has an ownership row.
- The dry-run reports the expected pre-run state.
- No queued device command remains executable by a revoked device.

## Automated acceptance map (simulated)

The consolidated suite is `tests/readiness-acceptance.test.mjs`. It uses fakes and the in-memory task store; it is not a live integration run.

| # | Check | Test |
|---|-------|------|
| 1 | Authorized owner authenticates | `1. an authorized owner can authenticate` |
| 2 | Unauthorized device is rejected | `2. an unauthorized device is rejected` |
| 3 | Pairing succeeds and consumed codes cannot be replayed | `3. pairing succeeds, a consumed code cannot be replayed by another device, and recovery is bounded` |
| 4 | Ax accepts a command and creates a persistent task | `4. Ax accepts a command and creates a persistent task` |
| 5 | A worker claims and executes an authorized task | `5. a worker claims and executes an authorized task` |
| 6 | Results return to Ax and are accurately reported | `6. results return to Ax with verified evidence` |
| 7 | Failed tasks retry or escalate correctly | `7. a failed task is not falsely completed and can be retried within the cap` |
| 8 | Duplicate commands do not duplicate execution | `8. duplicate command delivery cannot cause duplicate execution` |
| 9 | Revoked devices lose access | `9. a revoked device loses access and its queued commands are cancelled` |
| 10 | Reconnection/restart preserves valid state | `10. restarting the engine preserves valid task state` |
| 11 | Sensitive actions require approval | `11. a sensitive action parks for approval and is not executed by the worker` |
| 12 | Dry-run migration changes nothing | `12. migration dry-run produces no database changes` |

The suite also includes `tests/task-authorizer.test.mjs`, which verifies that the legacy task and
system-check routes reject anonymous callers, accept only the internal/Ax/owner credentials, and
surface a store outage as `503` rather than a misleading `401`.

## Real-device acceptance test (not run here)

After the nonproduction environment is configured and the ownership migration is verified:

1. Pair the real Android phone with a fresh code. Confirm the app remains in the foreground and the
   device appears in the authenticated `/device/status` and `/device/habitat` responses.
2. From the owner AX session, send the harmless read-only action:
   `POST /device/habitat/phone` with body `{ "action": "status", "arg": "acceptance" }`.
3. The relay should queue `device.status`; the phone's outbound bridge should execute only that
   read-only command and POST its result to `/device/commands/:id/result`.
4. Confirm `/device/habitat` reports the queue entry as completed and the device is online.
5. Lock and unlock the phone, switch away from Habitat and back, and confirm the bridge reconnects
   without a new pairing. Then revoke the device and confirm the next poll is unauthorized.

This test is intentionally not claimed as passed: it requires a real device, nonproduction D1,
nonproduction Render configuration, and an owner credential. Do not run it against production.

## What remains unverified

These procedures were not executed against Cloudflare D1, Render, a real phone, or production. The test suite uses fakes and an in-memory SQLite-compatible harness. Real D1 latency, SQL dialect differences, Render sleep behavior, and Android lifecycle behavior still require a nonproduction acceptance run.
