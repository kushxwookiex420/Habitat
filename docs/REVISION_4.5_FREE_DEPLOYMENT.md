# Revision 4.5 — $0/month nonproduction deployment readiness

Branch: `ax-nexus/revision-4.5-free-deployment-readiness` (from Revision 4.4 `e215aa5`)
Production, the production service, and the production database are untouched. Nothing here has been
deployed: no Render service, no Cloudflare database, no account was created by this revision.

## Status

| Item | State |
| --- | --- |
| Render plan | **Free (`plan: free`, $0/month)** selected in the committed Blueprint |
| Paid resources | **None declared** (no paid plan, disk, database, or multi-instance) |
| Auto-deploy | **Off** (`autoDeployTrigger: "off"`) |
| Blueprint validation | **6 automated checks pass** against Render's documented fields |
| D1 isolation | **Fail-closed added and tested**: missing/conflicting production declaration disables storage |
| Real server boot checks | **3/3 pass locally** (`/health`, `/diagnostics`, pairing route) |
| Backend tests | **472/472 pass** |
| Acceptance tests | **21/21 pass** (local HTTP, local SQLite, local server process) |
| Android APK | **Unchanged** from 4.4, inspected, no rebuild needed |
| Live deployment | **NOT DONE** — needs your Cloudflare + Render accounts |
| S26 Ultra pairing | **NOT DONE** — physical device action |

---

## 1. The exact $0/month configuration

| Resource | Plan | Cost |
| --- | --- | --- |
| Render web service `ax-nexus-habitat-nonprod` | **Free** — 0.1 CPU, 512 MB | **$0** |
| Cloudflare D1 database `habitat-nonprod` | **Workers Free / D1 free** | **$0** |
| **Total** | | **$0/month** |

Render Free limits that matter here (Render docs, checked for this revision):

- Spins down after **15 minutes without inbound traffic**; next request wakes it in **about one
  minute**. The phone polls every 5 seconds while the app is open, so an active phone keeps it awake.
- **750 free instance hours** per workspace per calendar month; a spun-down service uses none.
- **0.1 CPU / 512 MB**, one instance, no shell/SSH, Render may restart it at any time.
- Ephemeral filesystem: nothing written to disk survives a restart. All state lives in D1.
- 5 GB bandwidth per workspace; 500 build minutes per workspace.

Do not attach a persistent disk or a Render database, and do not add `numInstances`: all of those
are paid or unsupported on Free. The Blueprint test fails if a paid plan, database, or disk appears.

Cloudflare free tier used: 5M row reads/day, 100k row writes/day, 5 GB storage, 10 databases. A
single phone polling every 5 seconds is far below those limits (a poll is a small indexed read).

---

## 2. Validated Blueprint

`render.yaml` (single service, no production entry):

| Setting | Value |
| --- | --- |
| `type` | `web` |
| `name` | `ax-nexus-habitat-nonprod` |
| `runtime` | `node` |
| **`plan`** | **`free`** |
| `region` | `oregon` |
| `branch` | `ax-nexus/revision-4.5-free-deployment-readiness` |
| `rootDir` | `.` |
| `buildCommand` | `npm install --omit=dev --ignore-scripts` |
| `startCommand` | `npm start` → `npm run check && node server.mjs` |
| `healthCheckPath` | `/health` |
| `autoDeployTrigger` | `"off"` |
| `NODE_VERSION` | `22.14.0` (required by `package.json` engines) |
| Port | Render injects `PORT` (default 10000); the server binds `0.0.0.0` |

Validated fields match Render's Blueprint YAML reference (`runtime`, `plan`, `region`, `branch`,
`rootDir`, `buildCommand`, `startCommand`, `healthCheckPath`, `autoDeployTrigger`, `envVars`).
The repository has no other `render.yaml`; the production service is managed only in the Render
dashboard and is not referenced here.

`--ignore-scripts` is intentional: it skips the repository's `postinstall` (`check && test`) on the
Render builder. It also means the optional `ffmpeg-static` binary is not downloaded. This was tested
locally with the binary absent: `server.mjs` still boots and the device bridge works. Video/rendering
endpoints are unavailable on this nonproduction service and are not needed for pairing.

---

## 3. Create the separate D1 database (phone-friendly)

Do this in the Cloudflare dashboard:

1. Open **dash.cloudflare.com** → **Storage & Databases** → **D1 SQL Database** → **Create**.
2. Name it **`habitat-nonprod`**. Choose a region near you. Confirm the plan shows **Free**.
3. Open the database and copy its **Database ID** (a UUID). This is your
   `HABITAT_D1_DATABASE_ID`.
4. Copy the **production** database id from the production database's own page. This is your
   `HABITAT_PRODUCTION_D1_DATABASE_ID`. It is used only for comparison; the nonproduction service
   never connects to it.
5. Apply the schema to `habitat-nonprod`. Either use the dashboard's SQL console and paste each file
   in order, or run:

   ```bash
   npx wrangler d1 execute habitat-nonprod --remote --file=migrations/0001_habitat_tasks.sql
   npx wrangler d1 execute habitat-nonprod --remote --file=migrations/0002_habitat_command_tasks.sql
   npx wrangler d1 execute habitat-nonprod --remote --file=migrations/0003_device_ownership_security.sql
   ```

   All migrations are additive (`CREATE TABLE IF NOT EXISTS`), and the service also creates its own
   device tables on first boot. Running them twice is safe.
6. Create a Cloudflare API token: **My Profile → API Tokens → Create Token**, permission
   **Account → D1 → Edit** (or a token scoped to this database). This is
   `HABITAT_D1_API_TOKEN`. It is shown once; store it directly in Render, not in a file.

**Isolation check before deploying:** the two database ids must differ. If they are equal, the
service refuses durable storage and answers `503` on every device route; it does not fall back.

---

## 4. Environment-variable checklist

Set every row marked **Secret** in the Render dashboard (Environment tab or the Blueprint prompt).
Never commit a value, paste one into chat, or put one in a log.

| Variable | Required | Secret | Source |
| --- | --- | --- | --- |
| `HABITAT_SERVICE_NAME` | yes | no | already `ax-nexus-habitat-nonprod` in `render.yaml` |
| `HABITAT_RUNTIME_ENV` | yes | no | already `nonproduction` in `render.yaml` |
| `NODE_VERSION` | yes | no | already `22.14.0` in `render.yaml` |
| `NEXUS_RUNTIME_ENABLED` | no | no | already `true` in `render.yaml` |
| `CLOUDFLARE_ACCOUNT_ID` | yes | yes | Cloudflare dashboard → account id |
| `HABITAT_D1_DATABASE_ID` | yes | yes | nonproduction D1 database id |
| `HABITAT_D1_API_TOKEN` | yes | **secret** | token from §3 step 6 |
| `HABITAT_PRODUCTION_D1_DATABASE_ID` | **yes** | yes | production database id, comparison only |
| `HABITAT_AX_BRIDGE_TOKEN` | yes | **secret** | generate a long random value (32+ chars) |
| `HABITAT_OWNER_DEVICE_IDS` | yes | no | exactly one owner id, e.g. `owner-s26` |
| `HABITAT_BREAK_GLASS_TOKEN` | no | **secret** | only for emergency owner recovery |
| `HOME_BRIDGE_URL` / `HOME_BRIDGE_AX_TOKEN` / `HOME_BRIDGE_BUFF_TOKEN` | no | **secret** | only for the Home Bridge console |
| `OPENAI_API_KEY` | no | **secret** | only for `/chat`; device pairing does not need it |
| `HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH` | no | **secret** | SHA-256 of a one-time pairing code |
| `HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT` | no | no | ISO timestamp for the code above |

`HABITAT_PRODUCTION_D1_DATABASE_ID` is required even though the service never uses production: it is
the only way the process can prove its database is not production. Without it, a nonproduction
process that holds D1 credentials fails closed.

---

## 5. Deploy on Render (Free, no auto-deploy)

1. Render dashboard → **New → Blueprint** → connect `kushxwookiex420/Habitat` → branch
   `ax-nexus/revision-4.5-free-deployment-readiness`.
2. Render reads `render.yaml` and shows **one web service, Free instance type**. If it offers a paid
   plan, stop and check the branch is the 4.5 branch.
3. Enter the secret values from §4 when prompted.
4. **Create / Apply**. Auto-deploy is off, so later commits will not redeploy until you ask.
5. Copy the service URL (`https://<name>.onrender.com`). The Free service may take a minute to wake
   on the first request.

Verify (a browser works; `curl` is optional):

```bash
curl -s https://<service>/health
```

Expected, and the fields that matter:

```json
{
  "habitat": "online",
  "service": "ax-nexus-habitat-nonprod",
  "environment": "nonproduction",
  "isolation": { "productionD1Conflict": false, "productionDatabaseUndeclared": false, "productionD1Sealed": false, "productionDatabaseConfigured": true, "databaseConfigured": true },
  "deviceBridge": { "ready": true, "durable": true, "environment": { "runtime": "nonproduction", "productionD1Conflict": false } }
}
```

`deviceBridge.ready: true` means the D1-backed device store initialized. If it is `false`, read the
Render logs: the process logs `DEVICE_COMMAND_BRIDGE: disabled — D1 credentials are not configured`
or a `HABITAT_ENVIRONMENT_CONFLICT` line explaining the refusal. Do not "fix" a conflict by changing
the production id — fix the database id.

Authenticated diagnostics (never contains ids or tokens):

```bash
curl -s -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" https://<service>/diagnostics
# 401 without the header, 200 with it
```

---

## 6. Fail-closed behavior (verified locally)

| Configuration | Device store | Device routes | `/health` isolation | Server log |
| --- | --- | --- | --- | --- |
| nonproduction, no D1 credentials | not mounted | `503` | `databaseConfigured: false` | `D1 credentials are not configured` |
| nonproduction, D1 id **without** production id | refused | `503` | `productionDatabaseUndeclared: true`, `productionD1Sealed: true` | `isolation cannot be proven` |
| nonproduction, D1 id **equals** production id | refused | `503` | `productionD1Conflict: true`, `productionD1Sealed: true` | `D1 credentials are sealed` |
| production runtime, production id | mounted | normal | conflict `false` | — |

When sealed, the server deletes `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, and
`HABITAT_D1_API_TOKEN` from its own environment before any task, content, secret, or Nexus
repository is created, so those stay memory-only too. This was exercised against the real
`server.mjs` process, not only the bridge module.

---

## 7. Android readiness (no rebuild)

The committed APK is byte-identical to Revision 4.4 (`git diff e215aa5 -- app artifacts` is empty),
so no new APK was produced.

| Check | Result |
| --- | --- |
| SHA-256 | `83f78a6777156cc7cb22b74a7614f5265f24740ecf1a7d613053b99a503d92d6` |
| Package / version | `com.habitat.axbridge.nonprod`, `0.9.0-nonprod` (86) |
| Label | `Habitat NX (nonproduction)` |
| URL strings in `classes.dex` | only `https://ax-nexus-habitat-nonprod.onrender.com` as an endpoint |
| Production host string | present twice, only for refusal (endpoint policy) and the production DNS-fallback error text; never a target of a nonproduction build |
| Production fallback | impossible: build fails without `-PhabitatBaseUrl`; app refuses the production host at runtime |
| Editable endpoint | rejects `https://habitat-1-szzd.onrender.com` (test: `aProductionEndpointIsRefusedBeforeAnyRequestLeavesThePhone`, `theEndpointOverrideAcceptsAnIsolatedServiceAndStillRefusesProduction`) |
| Pairing states | `UNPAIRED → PAIRING → PAIRED_UNVERIFIED → LIVE`, `REVOKED`; `LIVE` only after an authenticated poll |

If the Render URL is not exactly `https://ax-nexus-habitat-nonprod.onrender.com`, open the app's
LINK dialog and set the real URL. No rebuild is needed.

---

## 8. Pair Habitat NX on the S26 Ultra

1. **Install** the APK (download link in §9) — tap it on the phone and allow install from that
   source, or `adb install -r habitat-ax-bridge-0.9.0-nonprod-debug.apk`.
2. **Open the service once** so the Free instance wakes: visit `https://<service>/health` in the
   phone browser and wait for JSON.
3. **Mint a one-time code** (10-minute TTL, single use):

   ```bash
   curl -s -X POST https://<service>/ax/device/pairings \
     -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"deviceId":"android-s26"}' | jq -r '.pairing.code'
   ```

4. In the app tap **LINK**. Confirm the dialog says `NONPRODUCTION BUILD` and shows the service URL.
   Paste the code and tap **Pair phone**.
5. Expected: `PAIRING` → `VERIFY` → `LIVE` within a few seconds. `VERIFY` means the credential is
   stored but the backend has not authenticated the phone yet. If it stays on `VERIFY`, read the
   diagnostics panel for the HTTP status and refusal reason.
6. **Verify the heartbeat**:

   ```bash
   curl -s -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
     https://<service>/ax/device/devices | jq '.devices[] | {device_id, model, last_seen_at}'
   ```

   A `last_seen_at` within the last minute proves this phone reached the isolated backend.
7. **Verify `device.status`**:

   ```bash
   ID=$(curl -s -X POST https://<service>/ax/device/commands \
     -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"deviceId":"android-s26","type":"device.status"}' | jq -r '.command.id')
   sleep 10
   curl -s -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
     https://<service>/ax/device/commands/$ID | jq '.command | {status, result}'
   ```

   `status: "completed"` with `result.details.model` naming the phone is the acceptance evidence.
8. **Revoke** when done:

   ```bash
   curl -s -X POST https://<service>/ax/device/android-s26/revoke \
     -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN"
   ```

If the app minimizes or closes during pairing, capture `adb logcat -b crash -d` and the diagnostics
panel. That crash is still unverified on hardware; do not assume the 4.3 fix worked until seen.

---

## 9. APK

- https://github.com/kushxwookiex420/Habitat/raw/ax-nexus/revision-4.5-free-deployment-readiness/artifacts/habitat-ax-bridge-0.9.0-nonprod-debug.apk
- SHA-256 `83f78a6777156cc7cb22b74a7614f5265f24740ecf1a7d613053b99a503d92d6`

---

## 10. Test report (local only)

| Check | Command | Result |
| --- | --- | --- |
| Syntax | `npm run check` | exit 0 |
| Backend suite | `npm test` | **472 pass, 0 fail, 0 skipped** |
| Acceptance bundle | `npm run test:acceptance` | **21 pass, 0 fail** |
| Blueprint fields/plan/secrets | `node --test tests/render-blueprint.test.mjs` | **6 pass** |
| Real `server.mjs` boot: clean / undeclared / conflict | `node --test tests/deployment-readiness.test.mjs` | **3 pass** |
| Isolation rules and sealing | `node --test tests/nonprod-environment-isolation.test.mjs` | **8 pass** |
| Android nonproduction unit tests (4.4 run, unchanged code) | `gradle :app:testNonproductionDebugUnitTest` | **16 pass** |
| Android production unit tests (4.4 run, unchanged code) | `gradle :app:testProductionDebugUnitTest` | **13 pass** |

**Local, not live:** every backend check above runs on this machine against a local listener,
local SQLite, or the local `server.mjs` process. None of them proves the Render hostname resolves,
that Render accepts the Blueprint, that Cloudflare D1 accepts the token, or that the phone can pair.
Those are the owner actions below. The Android numbers are from Revision 4.4; the app sources and
APK are unchanged, so they were not rebuilt or re-run for 4.5.

---

## 11. Remaining owner approvals and actions

1. **Approve creating free accounts/resources**: a Cloudflare D1 database and a Render Free web
   service. Cost: **$0/month**. I will not create them.
2. **Create the D1 database** `habitat-nonprod` and its schema (§3), and a D1 API token.
3. **Create the Render Blueprint** from this branch and enter the secrets (§4). Confirm the dashboard
   shows **Free** and auto-deploy **off**.
4. **Confirm `/health`** reports `environment: "nonproduction"`, `deviceBridge.ready: true`, no
   conflict/undeclared flags; keep the JSON.
5. **Note the real service URL.** If it differs from the compiled host, set it in the app dialog.
6. **Sideload the APK on the S26 Ultra** and pair with a minted code.
7. **Run the heartbeat and `device.status` checks** in §8 and keep the outputs as the first real
   device evidence.
8. **Report back** the `/health` JSON, the `device.status` JSON, and any crash log if pairing fails.
   Until then, the phone is not paired and the backend is not deployed.
