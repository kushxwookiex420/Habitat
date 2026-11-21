# Revision 4.4 — Nonproduction deployment and real-device integration

Branch: `ax-nexus/revision-4.4-nonprod-device-integration` (from Revision 4.3 `4eb638e`)
Production (`main`, `ax-nexus/revision-4.2-readiness`) and the production service are untouched.

> Revision 4.5 supersedes the cost and deployment sections below: `render.yaml` now selects Render
> **Free ($0/month)**. Use [REVISION_4.5_FREE_DEPLOYMENT.md](REVISION_4.5_FREE_DEPLOYMENT.md) for
> the current phone-first deployment guide.

## Status at a glance

| Item | State |
| --- | --- |
| Dedicated nonproduction APK | **Built and committed** (details below) |
| Nonproduction build cannot target production | **Enforced at build time and runtime; tested** |
| Isolated nonproduction backend | **Configuration ready, not deployed** — deployment needs your paid Render approval |
| Backend tests | **461/461 pass** |
| Acceptance (real HTTP) | **10/10 pass**, including 6 isolation tests |
| Android unit tests | **16/16 nonproduction, 13/13 production** |
| Physical S26 Ultra pairing / heartbeat | **NOT TESTED** — no device is reachable from this environment |
| Render / Cloudflare D1 deployment | **NOT DONE** — no nonproduction credentials, and a paid plan is required |

Nothing in this revision was verified on a phone. The APK is installable and its logic is covered
by JVM tests against a real HTTP listener, but the phone itself is your test to run.

---

## 1. Nonproduction APK

| Field | Value |
| --- | --- |
| File | `artifacts/habitat-ax-bridge-0.9.0-nonprod-debug.apk` |
| Size | 918,898 bytes |
| SHA-256 | `83f78a6777156cc7cb22b74a7614f5265f24740ecf1a7d613053b99a503d92d6` |
| Checksum file | `artifacts/habitat-ax-bridge-0.9.0-nonprod-debug.apk.sha256` |
| Package id | `com.habitat.axbridge.nonprod` (never the production package) |
| Version | `0.9.0-nonprod` (versionCode 86) |
| Launcher label | `Habitat NX (nonproduction)` |
| Compiled backend | `https://ax-nexus-habitat-nonprod.onrender.com` |
| Signing | debug key — sideload only, not a release artifact |

Download from the branch:

- https://github.com/kushxwookiex420/Habitat/raw/ax-nexus/revision-4.4-nonprod-device-integration/artifacts/habitat-ax-bridge-0.9.0-nonprod-debug.apk
- https://github.com/kushxwookiex420/Habitat/blob/ax-nexus/revision-4.4-nonprod-device-integration/artifacts/habitat-ax-bridge-0.9.0-nonprod-debug.apk.sha256

Verify before installing:

```bash
sha256sum habitat-ax-bridge-0.9.0-nonprod-debug.apk
# must print 83f78a6777156cc7cb22b74a7614f5265f24740ecf1a7d613053b99a503d92d6
```

Exact build configuration (AGP 8.7.3, Kotlin 2.0.21, JDK 17, compileSdk 35, build-tools 35.0.0,
Gradle 8.9):

```bash
export JAVA_HOME=<jdk-17>
export ANDROID_HOME=<android-sdk>
gradle :app:assembleNonproductionDebug \
  -PhabitatBaseUrl=https://ax-nexus-habitat-nonprod.onrender.com
# output: app/build/outputs/apk/nonproduction/debug/app-nonproduction-debug.apk
```

The compiled URL is a *declared* target: the service has not been created, so this host is not
proven reachable. If your deployed Render URL differs, either rebuild with the real URL or change
it in the app (see §3) — no rebuild is needed for the in-app change.

Production remains a separate, unchanged artifact:

```bash
gradle :app:assembleProductionDebug   # com.habitat.axbridge, 0.9.0, https://habitat-1-szzd.onrender.com
```

---

## 2. How a nonproduction build is kept away from production

Three independent layers, all tested:

1. **Build.** A nonproduction build fails without `-PhabitatBaseUrl`, and fails when that URL is the
   production host (`habitat-1-szzd.onrender.com` or a subdomain of it). Observed:

   ```
   The nonproduction build requires -PhabitatBaseUrl=<isolated backend https URL>. ...
   Refusing to build a nonproduction APK against the production host (habitat-1-szzd.onrender.com).
   ```

   The production flavor ignores `-PhabitatBaseUrl` entirely, so a stray property cannot repoint a
   production artifact.

2. **App.** `HabitatEndpointPolicy` validates the endpoint at bridge construction and on every
   attempt to change it. A nonproduction build refuses the production host, requires https except
   for loopback test addresses, and rejects credentials, query strings, and non-http schemes. The
   production build has no runtime endpoint override at all.

3. **Backend.** `HABITAT_RUNTIME_ENV=nonproduction` names the environment in `/health` and
   `/diagnostics`. If that process is configured with `HABITAT_D1_DATABASE_ID` equal to the
   declared `HABITAT_PRODUCTION_D1_DATABASE_ID`:
   - every device route answers `503` (no pairing, heartbeat, claim, or result write),
   - the server deletes the D1 credentials from `process.env` at startup, so task, content, secret,
     and Nexus repositories created later stay memory-only,
   - `/health` reports `isolation.productionD1Conflict: true` and `productionD1Sealed: true`.

   A production runtime (`HABITAT_RUNTIME_ENV=production`) is never sealed and is reported as
   `production`. `NODE_ENV=production` without an explicit runtime environment is treated as
   production (fail safe), never as nonproduction.

The production host string inside the APK exists only so the app can refuse it; it is never used as
a request target in a nonproduction build.

---

## 3. Pairing states

| State | Button | Meaning |
| --- | --- | --- |
| `UNPAIRED` | LINK | No credential stored, no attempt in progress. |
| `PAIRING` | PAIRING | A pairing request was sent and a one-time code was accepted for submission. Persisted before the request and shown for up to 5 minutes after process death, then honestly returns to `UNPAIRED`. |
| `PAIRED_UNVERIFIED` | VERIFY | A credential is stored but the backend has not yet authenticated this phone. **Not** "connected". |
| `LIVE` | LIVE | Only after an authenticated `GET /device/commands/next` succeeds with this phone's credential. |
| `REVOKED` | REVOKED | The backend answered 401/403; the stored credential was cleared. |

The pairing dialog survives keyboard, activity recreation, and app minimization (`configChanges`,
`adjustResize`, dialog state in `onSaveInstanceState`). A crash is recorded by
`HabitatCrashHandler` into the diagnostics panel. A rejected or failed pairing leaves the screen
open with the reason and never reports success.

In a nonproduction build the dialog shows `NONPRODUCTION BUILD • backend <url>` and an editable
backend field. Changing it clears any credential from the previous service, because a token only
means something to the service that issued it.

---

## 4. Deploying the isolated nonproduction backend (needs your approval)

**Cost:** **USD 0/month.** Revision 4.5 selects the Render **Free** plan in `render.yaml`
(0.1 CPU, 512 MB, sleeps after 15 idle minutes, ~1 minute wake, 750 instance hours/month) and
Cloudflare **D1 free** (5M row reads/day, 100k row writes/day, 5 GB). No paid resource is declared.
I have provisioned nothing and created no accounts. See
[REVISION_4.5_FREE_DEPLOYMENT.md](REVISION_4.5_FREE_DEPLOYMENT.md) for the current guide.

Steps:

1. Cloudflare dashboard → D1 → create database `habitat-nonprod`. Record its database id.
   **Do not reuse the production database id.**
2. Apply the schema to that database. Follow `docs/D1_SETUP_AND_ROLLOUT.md`, using the
   nonproduction database id. Production is not touched.
3. Create a Cloudflare API token with D1 edit access for the account (or a scoped token for that
   database).
4. Render → New → Blueprint → this repository → branch
   `ax-nexus/revision-4.4-nonprod-device-integration`. `render.yaml` defines the service
   `ax-nexus-habitat-nonprod` with `HABITAT_RUNTIME_ENV=nonproduction` and auto-deploy off.
5. Set every `sync: false` value in the Render dashboard:

   | Variable | Value |
   | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id |
   | `HABITAT_D1_DATABASE_ID` | **nonproduction** database id |
   | `HABITAT_D1_API_TOKEN` | token from step 3 |
   | `HABITAT_PRODUCTION_D1_DATABASE_ID` | production database id, used only to detect a conflict |
   | `HABITAT_AX_BRIDGE_TOKEN` | long random token; Ax uses it, the APK never holds it |
   | `HABITAT_OWNER_DEVICE_IDS` | exactly one owner device id, e.g. `owner-s26` |
   | `HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH` | optional first-run code hash (remove after pairing) |
   | `HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT` | ISO expiry for the bootstrap code |

   Leave `HABITAT_BREAK_GLASS_TOKEN`, `HOME_BRIDGE_*`, and `OPENAI_API_KEY` unset unless you need
   `/chat` or the Home Bridge; the device bridge does not require them.
6. Deploy, then verify:

   ```bash
   curl -s https://<service>/health | jq '{service, environment, isolation, deviceBridge}'
   # expected: environment "nonproduction", isolation.productionD1Conflict false,
   #           isolation.productionD1Sealed false, deviceBridge.ready true,
   #           deviceBridge.environment.productionD1Conflict false
   ```

   If `productionD1Conflict` is true, stop: the service is pointed at the production database and
   has refused durable storage on purpose.

7. Authenticated diagnostics (never contains ids or tokens):

   ```bash
   curl -s -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" https://<service>/diagnostics | jq
   # 401 without the token; 200 with it
   ```

8. If the deployed host differs from the compiled
   `https://ax-nexus-habitat-nonprod.onrender.com`, open the app's LINK dialog and set the real URL
   under "Isolated nonproduction backend URL". Production is refused there.

The Blueprint already selects **Render Free** (about a minute cold start after 15 idle minutes; the
phone's 5-second poll keeps it awake while the app is running). Do not use a free Postgres — this
service needs D1, and Render's free Postgres expires after 30 days.

---

## 5. Samsung Galaxy S26 Ultra: install, pair, verify

**Install** (either path):

```bash
adb install -r habitat-ax-bridge-0.9.0-nonprod-debug.apk
```

or copy the APK to the phone, tap it, and allow installation from that source. The launcher icon is
**Habitat NX (nonproduction)**. It does not replace or share data with a production install.

**Mint a one-time pairing code** (10-minute TTL, single use) with the owner's Ax token:

```bash
curl -s -X POST https://<service>/ax/device/pairings \
  -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"android-s26"}' | jq -r '.pairing.code'
```

**Pair**: open the app → tap **LINK** → confirm the dialog shows `NONPRODUCTION BUILD` and the
nonproduction backend → paste the code → **Pair phone**.

Expected sequence: button `PAIRING` → `VERIFY` ("Credential saved; verifying with Ax…") → within a
few seconds `LIVE` only if the backend accepted the credential. If it stays on `VERIFY`, read the
diagnostics panel: it names the HTTP status and the refusal reason without showing the token.

**Verify a real heartbeat and `device.status`**:

```bash
curl -s -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
  https://<service>/ax/device/devices | jq '.devices[] | {device_id, model, last_seen_at}'
```

`last_seen_at` within the last minute proves the phone's heartbeat reached the isolated backend.
Then queue the read-only command and read its result:

```bash
ID=$(curl -s -X POST https://<service>/ax/device/commands \
  -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"android-s26","type":"device.status"}' | jq -r '.command.id')
sleep 10
curl -s -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
  https://<service>/ax/device/commands/$ID | jq '.command | {status, result}'
```

`status: "completed"` and `result.details.model` naming the phone is the acceptance evidence.

**If pairing minimizes or closes the app**: this was the Revision 4.3 hypothesis (soft-keyboard
activity recreation dropping the dialog). The fix is in this APK, but it has not been observed on
hardware. Capture and send back:

```bash
adb logcat -b crash -d
```

plus a photo or screenshot of the diagnostics panel (it shows environment, endpoint, link state,
last confirmation time, and recent events; it contains no token).

**Revoke** when finished:

```bash
curl -s -X POST https://<service>/ax/device/android-s26/revoke \
  -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN"
```

The phone moves to `REVOKED` on its next poll and deletes the stored credential.

---

## 6. Consolidated test report

Commands were run from the repository root. Counts are from the actual result files, not estimates.

| Check | Command | Result |
| --- | --- | --- |
| Syntax check | `npm run check` | exit 0 |
| Backend suite | `npm test` | **461 pass, 0 fail, 0 skipped** |
| Acceptance + isolation | `npm run test:acceptance` | **10 pass, 0 fail** (6 isolation + 4 HTTP cycle/restart) |
| Build refusal: no URL | `gradle :app:assembleNonproductionDebug` | **fails**, exit 1, message above |
| Build refusal: production URL | `... -PhabitatBaseUrl=https://habitat-1-szzd.onrender.com` | **fails**, exit 1, message above |
| Nonproduction Android tests | `gradle :app:testNonproductionDebugUnitTest -PhabitatBaseUrl=...` | **16 pass, 0 fail, 0 skipped** |
| Production Android tests | `gradle :app:testProductionDebugUnitTest` | **13 pass, 0 fail, 0 skipped** |
| Nonproduction APK | `gradle :app:assembleNonproductionDebug -PhabitatBaseUrl=...` | BUILD SUCCESSFUL |
| Production APK | `gradle :app:assembleProductionDebug` | BUILD SUCCESSFUL |
| APK identity | `aapt2 dump badging` | `com.habitat.axbridge.nonprod`, `0.9.0-nonprod`, label `Habitat NX (nonproduction)` |

**Real in those tests:** the shipped Kotlin bridge and its HTTP code, the bridge routes and guards,
pairing/replay/heartbeat/authorization/revocation/reconnect logic, the durable queue, SQLite through
the D1 SQL shim, the environment policy, Gradle build refusal, and the compiled APK's manifest and
BuildConfig values.

**Simulated or not exercised:** a physical S26 Ultra, Android Keystore (tests inject an in-memory
credential store because Robolectric has no AndroidKeyStore), Cloudflare D1 itself, Render, the
Home Bridge, and the deployed nonproduction URL. The acceptance suite's tokens are fixed test
constants and its database is local SQLite.

The nonproduction Android suite includes four tests that only compile in that variant: the artifact
identifies itself as nonproduction and uses the `.nonprod` package, its compiled endpoint is not
production, a production endpoint is refused before any request leaves the phone, and the runtime
endpoint override accepts an isolated service while still refusing production. The production
variant has its own two tests proving it keeps its compiled endpoint and refuses repointing.

---

## 7. What still needs you

1. **Create the free nonproduction D1 database + Render Free service.** Cost is USD 0/month; no
   paid resource is needed. Nothing is deployed.
2. **Provide the nonproduction credentials** in the Render dashboard (not in chat or the repo):
   `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID` (nonproduction), `HABITAT_D1_API_TOKEN`,
   `HABITAT_PRODUCTION_D1_DATABASE_ID`, `HABITAT_AX_BRIDGE_TOKEN`, `HABITAT_OWNER_DEVICE_IDS`.
3. **Confirm the deployed URL**, or leave the compiled one and change it in-app.
4. **Install the APK on the S26 Ultra** and pair with a minted code (physical action; I cannot do
   this).
5. **Send back the diagnostics panel and `adb logcat -b crash -d`** if pairing does not reach
   `LIVE`, so the pairing-close hypothesis can be confirmed or discarded on real hardware.
6. **Run the `device.status` acceptance** in §5 and keep the JSON as the device evidence.

Until steps 1–5 happen, the honest state is: nonproduction APK built and tested off-device, isolated
backend configured but not deployed, and no phone paired.
