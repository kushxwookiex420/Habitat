# Habitat activation runbook (Mission 14)

Everything an operator must supply, in the order that unblocks the most work. Nothing here is
authorised by this repository; each step is an owner action. Estimated effort is for someone who
already has the accounts.

---

## 0. What is already done (no action)

- Code, tests, migration 0006, the message channel, autonomy, documentation.
- A fresh APK: `app/build/outputs/apk/debug/app-debug.apk` (`0.8.5`,
  SHA-256 `e20a0729e2f7a954b49b2a58e07ba5bec589d3e7fb32211700a062cde92653b4`).
- A release gate that refuses to pass without the required documents, migrations and evidence.

## 1. Staging D1 — 20 minutes

This is the only step that turns local evidence into staging evidence.

```sh
# 1. Create a disposable database. Never reuse the production id.
npx wrangler d1 create habitat-staging-m14
#    copy the printed database_id

# 2. Apply the additive schema to the staging database only.
for f in migrations/0001_habitat_tasks.sql migrations/0002_habitat_command_tasks.sql \
         migrations/0003_ax_memory_notifications.sql migrations/0004_ax_objectives_incidents.sql \
         migrations/0005_ax_security_scheduler.sql migrations/0006_ax_nexus_messages.sql; do
  npx wrangler d1 execute habitat-staging-m14 --remote --file "$f"
done

# 3. Create an API token with D1 Edit, scoped to this account.
```

Set these **in the staging environment only** (never on production):

| Name | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | account id |
| `HABITAT_D1_DATABASE_ID` | the staging database id |
| `HABITAT_D1_API_TOKEN` | the scoped token |
| `STAGING_ALLOW_WRITES` | `true` |
| `STAGING_OBJECTIVE_KEY` | any stable key, e.g. `m14-staging` |
| `STAGING_OWNER_APPROVAL_ID` | the approval id you will use |
| `STAGING_BUDGET_USD` | optional, default `0.01` |

Then run the two-process procedure:

```sh
# Phase 1 (writes). Record the objective id it prints.
STAGING_ALLOW_WRITES=true npm run staging:demo -- write

# Phase 2 (separate process, verify). Set the id from phase 1.
STAGING_OBJECTIVE_ID=<obj_…> npm run staging:demo -- verify
```

Pass: `verify` returns `ok: true` with `status: completed`, `verified: true`, `reservedUsd: 0` and
`integrity.ok: true`. Paste that JSON into `docs/STAGING_VALIDATION_RESULTS.md` and change
`Staging status:` to `STAGING VERIFIED`. The release gate will then require the database
fingerprint, both process commands and the 64-hex audit head.

Message channel on staging (optional but recommended, after the web service exists):

```sh
curl -sS -X POST "$BASE/ax/command/messages" \
  -H "Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"task","body":"staging channel probe","objective":"report runtime health","adapter":"runtime.health","correlationId":"m14-staging","idempotencyKey":"m14-staging-1"}'
curl -sS "$BASE/ax/command/messages/thread/m14-staging" -H "Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN"
```

## 2. Render — 15 minutes

1. Deploy the commit whose `release/manifest.json` is `releaseReady: true`.
2. Environment: add `AX_NEXUS_TOKEN` (new, generate with
   `node -e "console.log('axnexus_'+require('crypto').randomBytes(32).toString('base64url'))"`), and
   confirm the variables in `docs/RENDER_MISSION_14_READINESS.md` §2.
3. Keep `NEXUS_RUNTIME_ENABLED=true` only if you accept that work runs only while the instance is
   awake. For continuous execution, create the cron job from `docs/NEXUS_CRON_DEPLOYMENT.md` (paid).
4. Verify: `/health`, `/ax/command/presence`, `/ax/nexus/channel`, one scheduler tick.

Do **not** describe a sleeping Free service as continuously autonomous.

## 3. Connect Ax — 10 minutes (managed workspace) or 2 minutes (external client)

OpenAI's documented limits (checked for Mission 04): personal ChatGPT plans cannot create GPTs or
Actions; custom MCP servers are Business/Enterprise with OAuth only. Choose one:

- **Managed ChatGPT workspace**: create an Action from
  `https://<origin>/ax/command/openapi.json`, auth = API key / Bearer =
  `HABITAT_AX_COMMAND_TOKEN`. Paste the operator instructions from
  `docs/AX_NEXUS_COMMUNICATION.md` §7.
- **External Ax client** (script, desktop agent): call the same API with the Bearer token, submit
  with a unique idempotency key, poll the thread by correlation id.

Pass condition: a real `POST /ax/command/messages` from the client, a completed thread, and the
submission visible in `GET /ax/command/security/events`.

## 4. Android — 20 minutes

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Run the 15 checks in `docs/ANDROID_MISSION_14_DEVICE_TEST.md`. Then update
`Android physical status:` to `PHYSICAL S26 ULTRA VERIFIED` with the model, serial hash, checks
passed and timestamps. The gate refuses that claim without those fields.

## 5. Final close-out

```sh
npm ci
npm run check
npm test
npm run migrations:check
npm run release:gate          # writes release/manifest.json on the validated code commit
git add -A && git commit -m "release: record the Mission 14 gate result"
npm run release:gate -- --check
```

Then update PR #93 with the new evidence and only then consider merging.

## 6. Do not do

- Do not point staging variables at the production database id.
- Do not set `STAGING_ALLOW_WRITES` on production.
- Do not reuse `HABITAT_AX_BRIDGE_TOKEN` as the Ax command token: it can unpair devices.
- Do not let Ax approve anything; only the paired owner device can.
- Do not enable a side-effecting adapter (`SIDE_EFFECTING_ADAPTERS_ENABLED=true`) to make a demo
  look better.
- Do not delete task, objective, memory or message tables to “reset” a deployment.
