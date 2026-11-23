# Habitat Android — build, signing, permissions and device procedure

PR #111. **Nothing here was executed in the coding workspace** (no JDK); this is the reproducible procedure the owner runs.

---

## 1. Toolchain and reproducibility

| Item | Value |
|---|---|
| JDK | Temurin **17** (`JAVA_HOME` set) |
| Gradle | **8.10.2** (repo has no wrapper jar; CI pins this version) |
| Android Gradle Plugin | 8.7.3 (root `build.gradle.kts`) |
| Kotlin | 2.0.21 |
| `compileSdk` / `targetSdk` | **35** |
| `minSdk` | **26** (Android 8.0) |
| Build tools | 34.0.0 |
| Application id | `com.habitat.axbridge` |
| Version | 0.8.6 / code 86 |

```bash
export JAVA_HOME=/path/to/temurin-17
export ANDROID_SDK_ROOT=/path/to/android-sdk     # needs platforms;android-35, build-tools;34.0.0
./scripts/build-android-apk.sh debug             # installable with the debug key
./scripts/build-android-apk.sh release           # requires owner signing variables
```

The script refuses to continue without the SDK, without platform 35, or — for `release` — without all four signing variables. It prints the artifact path and SHA-256 and writes a `.sha256` beside it. Debug and release builds of the same commit use pinned plugin versions; no dependency is fetched at runtime.

CI: `.github/workflows/android-apk.yml` builds the debug APK on every `app/**` change and builds a signed release **only** when all four repository secrets exist (`HABITAT_KEYSTORE_BASE64`, `HABITAT_KEYSTORE_PASSWORD`, `HABITAT_KEY_ALIAS`, `HABITAT_KEY_PASSWORD`). Artifacts are retained 30 days. No secret is written to the repo or logs.

## 2. Signing

Release signing is read from the environment at build time (`app/build.gradle.kts` → `signingConfigs.owner`):

| Variable | Meaning |
|---|---|
| `HABITAT_KEYSTORE_FILE` | absolute path to the owner `.jks` |
| `HABITAT_KEYSTORE_PASSWORD` | keystore password |
| `HABITAT_KEY_ALIAS` | key alias |
| `HABITAT_KEY_PASSWORD` | key password |

- The keystore and passwords are **never committed** and never printed.
- With no variables the release build still compiles but is **unsigned**; the build script refuses to hand it over.
- Verify before installing:

```bash
$ANDROID_SDK_ROOT/build-tools/34.0.0/apksigner verify --print-certs dist/habitat-0.8.6-release.apk
```

- The signing key is the update identity: losing it means future updates cannot install over the existing app. Back it up offline (this is also an owner-recovery item).
- Debug builds use the machine's debug keystore; they are **not** update-compatible with a release install.

## 3. Permissions and why each exists

| Permission / component | Purpose | Owner-visible? |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | poll the durable command queue, upload results | install-time |
| `POST_NOTIFICATIONS` | required for the foreground bridge notification (Android 13+) | runtime prompt |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | keep the 5 s poll alive off-screen | install-time |
| `RECEIVE_BOOT_COMPLETED` + `HabitatBootReceiver` | restart the bridge after reboot | install-time |
| `HabitatAccessibilityService` (`BIND_ACCESSIBILITY_SERVICE`) | screen snapshot, gesture tap/swipe, non-password typing, navigation, accessibility screenshots | **Settings → Accessibility**, revocable any time |
| `DeviceBridgeJobService` | 15-minute fallback poll | install-time |

No `QUERY_ALL_PACKAGES`, no `READ_SMS`, no `MANAGE_EXTERNAL_STORAGE`, no `SYSTEM_ALERT_WINDOW`, no `REQUEST_INSTALL_PACKAGES`. The agent has no shell, file, messaging or call path.

## 4. API compatibility and known platform limits

| Feature | Requirement | Behaviour below it |
|---|---|---|
| App install | API 26+ | not supported |
| Accessibility snapshot/gestures/typing | API 26+ (gesture dispatch 24+) | — |
| `device.screenshot` via `AccessibilityService.takeScreenshot` | **API 30+** | returns `Screenshots require Android 11 or newer` |
| Foreground `dataSync` service | API 29+ type API; 34+ permission declared | older versions use plain `startForeground` |
| Foreground service runtime cap | Android 15+ limits `dataSync` to roughly 6 h/day | job fallback continues at 15 min |
| Notification permission | API 33+ runtime prompt | below 33 granted at install |
| Background exactness | Doze/App Standby can defer the job | no FCM yet; latency is best-effort |

The target device (Galaxy S26 Ultra, Android 16-class) satisfies every requirement; the API 30 gates exist for older devices.

## 5. Password-field and safety protections

- `device.type` first checks the focused node: **`isPassword` → refused**, `isEditable == false` → refused. The text is never read back.
- The accessibility snapshot marks password nodes as `password: true` but writes **empty** `text` and `description`.
- Taps/swipes/typing/keys are refused by the **server** unless the enqueue request carries `approved: true`; approval is audited as `command.sensitive` without coordinates or text.
- The accessibility connection never dismisses system consent dialogs and cannot grant permissions.
- Screenshots show whatever is on screen, including any visible personal data. Capture only when the owner asks; they are retained 24 h, capped at 1.5 MB, served only with the Ax credential or an operator session, and `Cache-Control: no-store`.

## 6. Emergency stop

1. **Revoke the device** — `POST /ax/device/:deviceId/revoke` (Ax token). This cancels queued commands, invalidates the token, and the phone clears its Keystore credential on the next 401.
2. **Turn off Accessibility** — Settings → Accessibility → Habitat AX Bridge → off. All gesture/typing/screenshot capability stops immediately.
3. **Force stop / uninstall** — kills the foreground service and the scheduled job.
4. **Stop the bridge in-app** — Disconnect removes the local credential and cancels the job.

There is no server-side "stop everything" button yet; the console control for revoke is a follow-up. Until then revoke is an Ax-API action.

## 7. Screenshot handling

- Capture: accessibility `takeScreenshot`, downscaled to **1080 px wide**, JPEG quality 72.
- Upload: `POST /device/screenshots` with the device bearer token; ≤ 1.5 MB after base64 decode; mime restricted to `image/jpeg` or `image/png`; ISO `capturedAt` required.
- Storage: D1 table `habitat_device_screenshots`, pruned best-effort to 24 h on each upload.
- Read: `GET /ax/device/screenshots/:id` (Ax token) or `GET /bridge/console/screenshots/:id` (operator session); `no-store`.
- A receipt carries only the server-side `shot_…` id, never the bytes.
- Not implemented yet: a console image viewer and deletion button.

## 8. Phone test procedure (owner)

Prerequisites: the phone keeps its existing pairing; the server is on a build that includes the device command contract (PR #110) and worker detail (PR #112) for the full flow.

| # | Step | Expected |
|---|---|---|
| 1 | Install APK over the existing app (same signing key) | `versionName 0.8.6`, no re-pair |
| 2 | Open Habitat, keep foreground 60 s | notification "Phone bridge connected"; `/device/status` → PASS |
| 3 | Settings → Accessibility → Habitat AX Bridge → enable | toggle on; no crash |
| 4 | Queue `device.status` | receipt completed with model/SDK |
| 5 | Queue `device.screen` | bounded node list, no password text |
| 6 | Focus a normal text field, queue approved `device.type` | text appears |
| 7 | Focus a password field, queue approved `device.type` | refused: "No editable, non-password field is focused" |
| 8 | Queue approved `device.tap` on a harmless target | one tap; receipt ok |
| 9 | Queue `device.key back` / `home` | navigation happens |
| 10 | Queue `device.screenshot` | receipt `screenshotId`; authenticated GET returns JPEG |
| 11 | Background the app 2 min | foreground notification persists; receipt still fast |
| 12 | Revoke via Ax | phone shows revoked, credential cleared, later polls 401 |
| 13 | Reboot without opening the app | bridge restarts; presence returns |
| 14 | Disable Accessibility | action commands fail with "Accessibility is not enabled", no crash |

Record device model, Android build, app version and timestamps. Never record the pairing code, token, or a screenshot containing personal data.

## 9. What is still unverified

- The APK has **not been compiled** in this workspace (no JDK) and not installed. Steps 1–14 are the first real verification.
- `ACTION_IME_ENTER` and accessibility `takeScreenshot` are the two APIs to watch on first build/run.
- Reproducibility is pinned but not byte-for-byte attested; compare SHA-256 across two clean builds before treating it as reproducible.
