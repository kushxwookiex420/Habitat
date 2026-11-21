# Non-production activation (Ax / Nexus Revision 3)

Status: **configuration ready; not provisioned or deployed.** This runbook is for the isolated
service only. It does not authorize a production deployment, a production D1 query, or a `main`
merge.

## Service contract

| Setting | Value |
|---|---|
| Repository | `kushxwookiex420/Habitat` |
| Branch | `ax-nexus/revision-3-nonprod` |
| Revision 3 baseline | `62f362ab7b53416ffbb1f62695639f16445558a1` |
| Service name | `ax-nexus-habitat-nonprod` |
| Region | Oregon |
| Root directory | `/` (repository root) |
| Build | `npm install --omit=dev --ignore-scripts` |
| Start | `npm start` |
| Render health check | `/health` |

`npm start` runs the repository syntax check and then `server.mjs`. The service listens on
`0.0.0.0` and uses Render's `PORT`.

## Environment variables

Enter every value in **Render → ax-nexus-habitat-nonprod → Environment**. Do not put any value in
this repository, a chat message, a build log, or a screenshot.

| Variable | Required | Secret? | Meaning |
|---|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Yes | No | Account that owns the disposable D1 database |
| `HABITAT_D1_DATABASE_ID` | Yes | No | **Disposable non-production** D1 database ID |
| `HABITAT_D1_API_TOKEN` | Yes | **Yes** | Token scoped to that disposable database only |
| `HABITAT_AX_BRIDGE_TOKEN` | Yes | **Yes** | New random bearer token for the Ax/Nexus routes |
| `HABITAT_OWNER_DEVICE_ID` | Yes for owner approvals | No | Exact paired owner device ID |
| `HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH` | Optional | **Yes** | Lowercase SHA-256 hex of a one-time bootstrap code |
| `HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT` | Optional | No | ISO timestamp for that bootstrap code |
| `HABITAT_TOKEN_ENCRYPTION_KEY` | Optional | **Yes** | Only for the TikTok token vault; not needed for Nexus acceptance |
| `OPENROUTER_API_KEY` | Optional | **Yes** | Only for `/chat`; the Nexus worker does not need it |

The non-production service must **not** receive the production `HABITAT_D1_DATABASE_ID`, the
production D1 API token, or any production Render variables. Generate the bridge token separately
for this service; do not reuse the production bridge token.

## D1 schema and initialization

Revision 3 initializes D1 automatically on startup. Do not run the production migration against the
disposable database.

When all three D1 variables are present, `server.mjs` initializes the existing task and dispatch-lease
tables before listening. The device bridge and Nexus runtime then initialize their tables. The DDL is
idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

Tables used by this service:

- `habitat_tasks` — existing task repository and startup hydration
- `habitat_dispatch_leases` — existing dispatch lease fencing
- `habitat_command_tasks` — universal command/Nexus task records
- `habitat_device_commands` — device command queue
- `habitat_device_pairings` — one-time pairing records
- `habitat_paired_devices` — per-device token hashes and revocation state
- `habitat_nexus_workers` — worker heartbeat and counters

`habitat_content_jobs` is also created automatically whenever D1 is configured. `habitat_secret_vault`
is created only when `HABITAT_TOKEN_ENCRYPTION_KEY` is set.

If D1 credentials are present but initialization fails, startup fails closed rather than falling back
to memory. If the D1 variables are absent, the service starts without durable command storage and
Nexus is not mounted; that is not an acceptable acceptance state.

## Owner setup (phone-friendly)

### 1. Create the disposable D1 database

1. Open the Cloudflare dashboard in a browser.
2. Go to **Storage & Databases → D1 SQL Database → Create database**.
3. Name it `ax-nexus-habitat-nonprod`. Do not select or clone a production database.
4. Open the new database and copy its **Database ID**.
5. Compare it with the production database ID. They must not be equal. The live-test workflow also
   enforces this exact inequality.

No tables need to be created by hand; the service creates them. The guarded workflow can create and
verify them before the Render service starts.

### 2. Create the dedicated D1 API token

1. Cloudflare dashboard → **My Profile → API Tokens → Create Custom Token**.
2. Grant the narrowest D1 edit/query permission available for the account, and scope it to the
   account that owns the disposable database.
3. Do not reuse a Workers, production, or account-wide token.
4. Copy the token once and place it directly into Render's secret field. Do not paste it into chat.

### 3. Generate the bridge token

Generate at least 32 random bytes (for example, a password manager's 64-character hex generator).
Store it directly in Render as `HABITAT_AX_BRIDGE_TOKEN`. It authenticates `/ax/command/*` and
`/nexus/runtime`, but it does **not** approve owner actions.

### 4. Create the Render Blueprint

1. Render → **New → Blueprint**.
2. Connect `kushxwookiex420/Habitat`.
3. Select branch `ax-nexus/revision-3-nonprod`. The checked-in `render.yaml` now names this branch;
   if Render asks for a branch override, use the same value.
4. Apply the blueprint. Confirm the service is `ax-nexus-habitat-nonprod`, region Oregon, root `/`,
   and the build/start/health values in the table above.
5. Enter the five required variables in the service Environment page. Use the disposable database
   ID and the dedicated token only.
6. Deploy. Record the Render service ID, deploy ID, deployed commit, and the first successful
   `/health` response.

The blueprint sets `autoDeployTrigger: off`; configuration commits do not silently deploy themselves.

## Guarded live D1 verification

This is the only live D1 path. It never runs on push and must be pointed at the disposable database.

> **Registration prerequisite:** GitHub only registers a `workflow_dispatch` workflow from the
> default branch. `nexus-d1-live.yml` exists on `ax-nexus/revision-3-nonprod` but not on `main`, so
> the workflow is not currently listed in Actions and cannot be manually dispatched. Adding that
> single workflow to `main` requires a separate reviewed change; do not merge Revision 3 into `main`
> to unblock it.

1. In GitHub → `kushxwookiex420/Habitat` → **Settings → Secrets and variables → Actions**:
   - Variable `CLOUDFLARE_ACCOUNT_ID`
   - Variable `NEXUS_D1_TEST_DATABASE_ID` — the disposable database ID
   - Variable `HABITAT_D1_DATABASE_ID` — the production ID, used **only** for the inequality check;
     the workflow never contacts it
   - Secret `HABITAT_D1_API_TOKEN` — the disposable-only token
2. Open **Actions → Nexus D1 live verification → Run workflow**.
3. Enter `isolated` in the confirmation field and run it.
4. The workflow refuses unless the confirmation is exact and the two database IDs differ.
5. Record the run URL, commit SHA, start/end timestamps, and the complete `PASS`/`SUMMARY` lines.

Expected evidence proves live D1 create/get, exactly-once claim, lease renewal, expiry and takeover,
stale completion/failure rejection, concurrent completion, approval-then-execution, recovery race,
and single-winner exhausted takeover. The script deletes only `itest-` prefixed records it created.

Do not use this workflow with production IDs, a production token, or a database that contains real
tasks.

## Hosted worker acceptance (after Render is live)

Use a shell that does not echo the token into history. For example:

```sh
read -r -s -p "Ax bridge token: " AX_TOKEN; echo
BASE="https://<service>.onrender.com"
```

Never paste the token into chat or a committed file.

### Health and runtime

```sh
curl -fsS "$BASE/health"
curl -fsS -H "Authorization: Bearer $AX_TOKEN" "$BASE/nexus/runtime"
```

`/health` must return `habitat:"online"` and `backend:"ready"`. This is liveness, not proof of a
worker. `/nexus/runtime` must return `workerStarted:true`, a non-stale `workers[]` entry, and
`heartbeatVerified:true`. Record the `heartbeatAt` and `ageSeconds` values.

### Authorized task

```sh
curl -fsS -X POST "$BASE/ax/command/tasks" \
  -H "Authorization: Bearer $AX_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"objective":"hosted runtime health acceptance","adapter":"runtime.health","role":"ax","requestedBy":"owner"}'
```

Copy the returned task id, then poll:

```sh
curl -fsS -H "Authorization: Bearer $AX_TOKEN" "$BASE/ax/command/tasks/<task-id>"
```

Acceptance requires the stored task to reach `done`, with worker claim/fence evidence and a
`runtime:` result evidence string. A 201/200 response alone is not acceptance.

### Refusals

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/nexus/runtime"
# expect 401 without a bearer token

curl -s -X POST "$BASE/ax/command/tasks" \
  -H "Authorization: Bearer $AX_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"objective":"must be refused","adapter":"repo.test"}'
# expect 400 adapter_not_allowed
```

After a real owner device is paired, test a second paired non-owner device against an owner-only
approval or close route and expect 403. If no owner device is paired, owner-only routes fail closed
with 401/503; that is a blocker, not a pass.

### Shutdown and restart

Trigger **Manual Deploy → Restart** (or a new deploy) in Render. The logs must show
`NEXUS_RUNTIME: received SIGTERM` and a stopped state. After restart, `/nexus/runtime` must show a
fresh heartbeat. A sleeping free instance is not the same as a graceful shutdown test.

## Ax connection gate (not yet satisfied)

`integrations/ax-nexus/openapi.json` still contains
`https://REPLACE-WITH-NON-PRODUCTION-CONNECTOR-HOST` and `x-server-url-status:
"placeholder-not-verified"`. Do not import that document into ChatGPT as a working connector.

The root `render.yaml` currently defines only the Habitat service; the gateway/connector reference
under `integrations/ax-nexus/` is not part of this Blueprint and has not been deployed. There is no
ChatGPT account authorization in this environment.

After hosted worker acceptance passes, deploy the gateway and connector as separate non-production
services using `rootDir: integrations/ax-nexus`, then:

1. Verify `GET https://<gateway>/v1/health` and `GET https://<connector>/health`.
2. Verify the connector rejects a missing/wrong bearer key with 401 and enforces its per-IP rate
   limit with 429 plus `Retry-After`.
3. Import `https://<connector>/openapi.json` in ChatGPT. The connector rewrites `servers[0].url`
   from `PUBLIC_BASE_URL` or Render's `RENDER_EXTERNAL_URL`; confirm the imported URL is the
   non-production connector origin, not the placeholder.
4. Configure API-key auth with header `Authorization` and value `Bearer <AX_CONNECTOR_API_KEY>`.
5. Submit `runtime.health` from ChatGPT and retrieve the persisted task. Success requires
   `status:"done"` and `result.evidence` beginning with `runtime:`. A 202 response alone is not a
   ChatGPT round trip.

Until all five steps succeed, Ax is not connected to Nexus and no direct-communication claim is
valid.

## Remaining owner actions

- Cloudflare: create the disposable database and scoped token.
- Render: create the Blueprint/service and enter the five required variables.
- GitHub: set the three Actions variables and the disposable-only token secret, then run the
  manual workflow.
- Pair the owner device if owner-only approval tests are required.
- After the service is live, provide the service URL and the dashboard's deploy/run evidence; do not
  provide secret values.

## Boundaries

No production Render service, production D1 database, production token, production worker, `main`
merge, adapter-allowlist expansion, unrestricted shell/device execution, or phone permission/pairing
change is authorized by this runbook.
