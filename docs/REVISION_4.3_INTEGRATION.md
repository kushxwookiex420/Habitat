# Revision 4.3 — Android + Nonproduction Integration

This runbook covers the Android client, the isolated nonproduction backend, and the acceptance
evidence gathered for Revision 4.3. It authorizes **no production** deployment, merge, D1 access,
secret change, or physical-phone action. See `REVISION_4.2_READINESS.md` for the ownership
migration and rollback procedure, which is unchanged by this revision.

## Branch baseline

- Base: Revision 4.2, `7a0d3899cf59f24411b2afe0d6607d147b45efec`
- Work branch: `ax-nexus/revision-4.3-integration`
- Previous revision branches are untouched.

## 1. What changed

### Android client

| Change | Why |
| --- | --- |
| Backend base URL is a build field (`BuildConfig.HABITAT_BASE_URL`), defaulting to production | A nonproduction APK can target an isolated service without editing source, and no build silently changes the default |
| `AndroidDeviceBridge` exposes `UNPAIRED`, `PAIRED_UNVERIFIED`, `LIVE`, `REVOKED` | A stored credential is not proof of authentication; `LIVE` is only set after an authenticated poll, and `REVOKED` only after the backend rejects the credential |
| `CredentialStore` interface with `KeystoreCredentialStore` | The Keystore implementation is unchanged (AES-GCM, non-exportable Android Keystore key); the boundary makes the bridge testable on a JVM and isolates storage failures |
| HTTP failures carry a status code (`HttpStatusException`) | The previous `message.contains("401")` could match an unrelated code and wiped credentials on the wrong error |
| `BridgeDiagnostics` + `HabitatCrashHandler` | The pairing failure that sent the app home could not be reproduced without the device, so the app now records the pairing/poll/lifecycle/crash trail |
| Pairing dialog survives activity recreation and stays open until Ax confirms | An IME-triggered recreation dropped the dialog and flashed the launcher, which looks exactly like the app closing |
| `android:configChanges="keyboard|keyboardHidden|navigation|screenSize|smallestScreenSize"`, `windowSoftInputMode="adjustResize"` | Stops the soft keyboard from recreating the activity mid-pairing |
| `HabitatNetwork` returns `HttpURLConnection` and only applies the DNS/SNI fallback to the production HTTPS host | The old cast to `HttpsURLConnection` crashed on any `http://` nonproduction endpoint |
| Task status text no longer claims `VERIFIED` from an HTTP 200 | `VERIFIED` now requires the backend's canonical machine-check output |

The Android app still accepts only the read-only `device.status` command. No shell, file,
messaging, publishing, or UI-automation surface was added.

### Backend

| Change | Why |
| --- | --- |
| Nonproduction process whose `HABITAT_D1_DATABASE_ID` equals `HABITAT_PRODUCTION_D1_DATABASE_ID` mounts **no** durable device store | Previously only the Nexus worker was blocked; pairing, heartbeats, and command results could still write to production data |
| `status().environment` and `/health` expose `{ runtime, productionD1Conflict, nexusEnabled }` | The separation state is visible without reading logs |
| `render.yaml` targets this branch and declares the production-D1 id, owner allowlist, and bootstrap variables | The nonproduction service can be created without hand-editing configuration |

## 2. Android build

Verified toolchain (no root required):

| Component | Version |
| --- | --- |
| JDK | Temurin 17.0.21.1+2 |
| Gradle | 8.9 |
| Android Gradle Plugin | 8.7.3 |
| Kotlin | 2.0.21 |
| compileSdk / targetSdk | 35 |
| Build tools | 35.0.0 |
| minSdk | 26 |

The repository has no Gradle wrapper, so use an installed Gradle 8.9 and point
`local.properties` (git-ignored) at the SDK:

```bash
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > local.properties
gradle :app:assembleDebug
```

Production build (default endpoint, HTTPS only, no cleartext):

```bash
gradle :app:assembleDebug
```

Nonproduction build against an isolated service:

```bash
gradle :app:assembleDebug -PhabitatBaseUrl=https://habitat-nonprod.example.com
```

Debug builds allow cleartext HTTP so a loopback nonproduction listener can be reached. Release
builds keep `usesCleartextTraffic="false"`.

Unit and integration tests:

```bash
gradle :app:testDebugUnitTest
```

### Artifact

- APK: `artifacts/habitat-ax-bridge-0.8.5-debug.apk`
- SHA-256: `3ddf8abaab190887c22b4702e7afce379cd098e33f8658d14c60a9c0945c5e8a`
- Package: `com.habitat.axbridge`, versionCode 85, versionName 0.8.5, compileSdk 35

This is a **debug** APK signed with the local debug key. It installs with `adb install -r` for
testing. It is not a Play-release build; a release build needs an owner-provided upload keystore:

```bash
gradle :app:assembleRelease   # unsigned until signingConfig is added
```

Do not install it on the owner's phone without explicit authorization.

## 3. Isolated nonproduction backend

`render.yaml` describes one service, `ax-nexus-habitat-nonprod`, on branch
`ax-nexus/revision-4.3-integration`. It is not production and must not be merged into it.

### Required configuration

Secrets are set in the Render dashboard; none are committed.

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the **nonproduction** D1 database |
| `HABITAT_D1_DATABASE_ID` | Nonproduction D1 database id; must differ from the production id |
| `HABITAT_D1_API_TOKEN` | D1 token scoped to the nonproduction database |
| `HABITAT_PRODUCTION_D1_DATABASE_ID` | Production database id, declared only so the backend can detect a misconfiguration and fail closed |
| `HABITAT_AX_BRIDGE_TOKEN` | Ax bridge credential for task and pairing routes |
| `HABITAT_OWNER_DEVICE_IDS` | Exactly one owner device id (comma-separated list is accepted; only a sole owner may mint codes) |
| `HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH` | Optional first-run bootstrap: SHA-256 hex of a one-time owner code |
| `HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT` | Expiry for that bootstrap code |
| `HABITAT_BREAK_GLASS_TOKEN` | Optional recovery credential |
| `HOME_BRIDGE_URL`, `HOME_BRIDGE_AX_TOKEN`, `HOME_BRIDGE_BUFF_TOKEN` | Relay credentials for phone actions |
| `HABITAT_RUNTIME_ENV` | Set to `nonproduction` |
| `NEXUS_RUNTIME_ENABLED` | Set to `true` for the nonproduction worker |

### Database separation

1. Create a dedicated nonproduction database (do not reuse production):

   ```bash
   npx wrangler d1 create habitat-nonprod
   ```

2. Record its `database_id` and set it as `HABITAT_D1_DATABASE_ID` on the nonproduction service.
3. Set `HABITAT_PRODUCTION_D1_DATABASE_ID` to the production id. It is only compared, never used.
4. Confirm the guard: if the two ids match, the process logs
   `DEVICE_COMMAND_BRIDGE_ENVIRONMENT_CONFLICT`, `/health` reports
   `deviceBridge.environment.productionD1Conflict: true`, and every device route answers `503`.
   `npm run test:acceptance` includes this case.

The schema is additive and created by the bridge on first initialization; ownership rows are
managed with `scripts/backfill-device-ownership.mjs` exactly as documented in
`REVISION_4.2_READINESS.md`. That backfill is dry-run by default and requires an explicit
`--apply --confirm APPLY_DEVICE_OWNERSHIP_BACKFILL`.

### Health check

`GET /health` must return HTTP 200. The relevant fields:

```json
{
  "habitat": "online",
  "deviceBridge": {
    "ready": true,
    "durable": true,
    "perDeviceTokens": true,
    "environment": { "runtime": "nonproduction", "productionD1Conflict": false, "nexusEnabled": true }
  }
}
```

Render health checking deliberately does not depend on the optional worker; a degraded Nexus
worker must not take the service down.

### Deployment status

**Not deployed.** No nonproduction Render service, D1 database, or Cloudflare credential was
available in this environment, and none was created or modified. The configuration above is
prepared and unexecuted; do not read it as a deployment.

## 4. Acceptance results

Four categories are reported separately:

- **Robolectric**: the shipped Kotlin `AndroidDeviceBridge` running on a JVM against a real
  loopback HTTP listener. No emulator, no phone, Android Keystore replaced by an in-memory store.
- **HTTP/SQLite**: the real bridge routes, universal engine, Nexus worker, adapters, and D1
  repository SQL over real sockets, with `node:sqlite` standing in for Cloudflare D1.
- **Simulated**: existing in-process suites with fakes.
- **Physical device**: none. No phone was touched.

| # | Check | Evidence | Category | Result |
| --- | --- | --- | --- | --- |
| 1 | Android app starts without crashing | APK builds and installs; startup crash recorder added in 4.3 | not executed | **unverified** |
| 2 | Pairing code accepted once, replay rejected | `nonprod-http-acceptance` checks 1–3; Robolectric `aConsumedPairingCodeCannotPairASecondPhone` | HTTP + Robolectric | pass |
| 3 | Paired identity persists after restart | HTTP restart test re-authenticates the same token; Robolectric builds a second bridge on the same credential store | HTTP + Robolectric | pass |
| 4 | Authenticated heartbeat updates the correct device | HTTP heartbeat asserts the target row's `last_seen_at` and owner; wrong token gets 401 | HTTP/SQLite | pass |
| 5 | Ax receives an authenticated command | `POST /ax/command/tasks` with the Ax token; anonymous request gets 401 | HTTP | pass |
| 6 | Ax creates a persistent task | Task id returned; duplicate idempotency key returns the same task | HTTP/SQLite | pass |
| 7 | An authorized worker claims and executes it | `worker.tick()` runs the real engine and `runtime.health` adapter | HTTP/SQLite | pass |
| 8 | Results return to Ax and the Android client | Task read back with evidence; phone claims `device.status`, posts its result, command reads `completed` | HTTP + Robolectric | pass |
| 9 | `device.status` is a harmless read-only command | Only allowlisted type; result contains device identity, no mutation | HTTP + Robolectric | pass |
| 10 | Offline / reconnect | Unreachable backend: no throw, no `LIVE`, diagnostic recorded; restart with the same database re-authenticates | Robolectric + HTTP | partial (no mid-session phone reconnect) |
| 11 | Revocation blocks subsequent requests | Poll and heartbeat return 401 after revoke; Android clears the credential and reports `REVOKED` | HTTP + Robolectric | pass |
| 12 | Restart does not lose tasks or misreport completion | File-backed SQLite, process-equivalent restart, task still `done`, no re-execution | HTTP/SQLite | pass |

### Commands run

```bash
npm run check                                      # exit 0
npm test                                           # 455 tests, 455 pass, 0 fail
npm run test:acceptance                            # 4 suites covering checks 2-12 over HTTP
./toolchain/run-android-acceptance.sh              # Robolectric: 5 tests, 0 skipped, 0 failed
gradle :app:assembleDebug :app:testDebugUnitTest   # BUILD SUCCESSFUL
```

The Android integration suite is skipped (not reported as passing) unless
`scripts/nonprod-acceptance-server.mjs` is running and its environment variables are exported.

## 5. The pairing "app closes to the home screen" report

**Not reproduced.** There is no emulator or physical device in this environment, so no claim is
made that this is fixed on the S26 Ultra.

Findings and changes that target plausible causes:

1. **IME-triggered activity recreation.** Opening the keyboard can deliver a `keyboardHidden`
   configuration change. Without `configChanges`, the activity is recreated, the `AlertDialog` is
   lost, and the launcher becomes visible — indistinguishable from the app closing. The activity
   now handles those changes and re-opens the pairing dialog after recreation.
2. **No crash trail.** A crash in the pairing worker, the Keystore, or the poll timer left nothing
   behind. `HabitatCrashHandler` and `BridgeDiagnostics` now persist the last 40 events
   (pairing attempt, HTTP status, lifecycle, crash class and top frames) and the pairing dialog
   displays them.
3. **Premature success.** The old flow dismissed the dialog and showed "paired successfully" as
   soon as the token was written locally, before any authenticated request. The dialog now stays
   open until the first authenticated poll confirms the link.

Diagnostic procedure on the real device (harmless, read-only):

1. Open `LINK` and read the endpoint, link state, and the last events at the bottom of the panel.
2. Enter a fresh code. If the screen closes, reopen the app and read the diagnostics: a `CRASH`
   entry identifies the exception; a `paused while the pairing dialog was open` entry means the
   system moved the activity away rather than an app crash.
3. Capture `adb logcat -b crash` alongside the diagnostics panel.
4. Run the harmless read-only check from the owner AX session:
   `POST /device/habitat/phone` with `{"action":"status","arg":"acceptance"}`, then confirm the
   command reaches `completed`.

## 6. Security review

Fixed in this revision:

- **Medium — nonproduction could write to production D1.** Only the Nexus worker was blocked; the
  device queue was not. Durable device storage is now refused on any environment conflict and
  every device route answers `503`.
- **Medium — false `LIVE`/`VERIFIED` states.** A stored token or an HTTP 200 was presented as
  authenticated/verified. `LIVE` now requires an authenticated poll; `VERIFIED` requires the
  backend's canonical machine checks.
- **Low — nonproduction HTTP endpoints crashed the client.** `HttpsURLConnection` cast removed;
  the production DNS/SNI fallback remains scoped to the production host.
- **Low — pairing UI could be lost on recreation**, which also removed the user's only visible
  error context.

Reviewed and unchanged (existing tests still pass): owner authorization and cross-owner isolation,
pairing expiry/single use/bounded recovery, revocation, per-device token storage, device-scoped
command completion (a different paired device cannot complete another device's command), task
idempotency, approval gates, console sessions.

Open, not changed here:

- Public `/chat` remains unauthenticated and can consume model credits. It is not a new issue and
  fixing it requires a product decision (rate limiting or requiring a device identity).
- An unissued pairing code answers `401 pairing_unknown` while a consumed code for another device
  answers `409`. Codes are 128-bit random, so this is not a practical oracle, but the statuses are
  inconsistent.

## 7. Remaining blockers and the next action

Blocked in this environment:

- No Android emulator (no KVM) and no physical phone: startup, real Keystore storage, real
  lifecycle behavior, and the pairing close bug remain unverified on hardware.
- No nonproduction Cloudflare or Render credentials: nothing was deployed and the D1 guard was
  exercised only against SQLite.

To finish the milestone on real hardware, the owner must:

1. Authorize installation on the S26 Ultra, then install
   `artifacts/habitat-ax-bridge-0.8.5-debug.apk` (`adb install -r`).
2. Provide nonproduction infrastructure: a D1 database id and token, the Cloudflare account id, an
   Ax bridge token, and one owner device id. With those, deploy `render.yaml` to a **new**
   nonproduction Render service whose `HABITAT_PRODUCTION_D1_DATABASE_ID` is the production id.
3. Pair the phone with an owner-minted code and report the diagnostics panel if the screen closes.
4. Run the read-only `device.status` acceptance action and confirm the command completes.
