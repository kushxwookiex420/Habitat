# Android Mission 13 — Galaxy S26 Ultra device test

Android physical status: BUILD ONLY — owner-blocked
Owner action: install the APK on the physical Galaxy S26 Ultra, create a fresh one-time pairing code in the authenticated Control Center, and execute tests 1–15 below on the phone; record the model, Android build, app version, timestamps and pass/fail for each. Do not perform settings changes, messages, calls, deletions or publishing during the test.

## Build evidence

| Field | Value |
| --- | --- |
| Source commit used for this APK | The final Mission 13 commit is recorded in `release/manifest.json` after the gate; the Android source tree is unchanged from baseline `5f2175d` |
| Build command | `:app:assembleDebug` with Gradle 8.9, JDK 17, local Android SDK, `--offline` |
| Build result | `BUILD SUCCESSFUL` (33 tasks; instrumentation, packaging and debug signing completed) |
| APK | `app/build/outputs/apk/debug/app-debug.apk` |
| Size | 908,394 bytes |
| SHA-256 | `aa022d8b3f56f8cf9c45c8e5f79fdb8706e64d80cb9e8a006d7afbc61e71f950` |
| Application id | `com.habitat.axbridge` |
| Version name | `0.8.4` |
| Permissions declared | `INTERNET`, `ACCESS_NETWORK_STATE`, `RECEIVE_BOOT_COMPLETED`, `RECORD_AUDIO` |

The APK was assembled, not installed. No emulator, debug bridge or physical device was available in this environment (`adb` absent, no attached device). The checksum identifies the artifact; it is not a signature or a device result.

## What the source shows (static, build-only evidence)

- Pairing screen is an `AlertDialog` kept inside a stable dialog across activity recreation; it is not a separate activity that can minimize the app.
- A pairing code must be 20–128 characters. The dialog states a 10-minute expiry and single use.
- The phone posts `{deviceId, code}` to `/device/pair` without a bearer token. A successful response must contain `ok: true` and a token of at least 40 characters.
- The token is encrypted with an Android Keystore AES/GCM key and stored in preferences; the plaintext token is not written to preferences or logs.
- Authenticated polling calls `/device/commands/next?deviceId=...`, then sends a heartbeat with model, SDK, release, app version, battery percentage/charging and interactive state.
- A `401` clears the stored credential and stops polling; the UI reports that the link was revoked. Other errors report a temporary bridge failure without clearing the token.
- Only `device.status` is handled by the Android agent; every other command returns an explicit unsupported-command result. No settings, message, call or deletion command is implemented here.
- The app requests no runtime permission beyond what its declared permissions imply; `RECORD_AUDIO` is declared but this test sheet does not exercise recording.

These facts are source inspection. They do not prove layout, lifecycle, Keystore, network or revocation behavior on a real S26 Ultra.

## Evidence levels

| Level | Result |
| --- | --- |
| Build-only | **PASS** — APK assembled, package and checksum recorded |
| Emulator tested | **NOT RUN** — no emulator installed |
| Physical S26 Ultra tested | **NOT RUN** — no device or `adb` present |

## Test sheet — all 15 must be executed on the physical phone

Status for every item below: **NOT EXECUTED**. Do not mark an item passed from source inspection.

| # | Test | Expected result | Actual | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Install and launch the APK | App opens to the bridge screen; no crash | — | — |
| 2 | Open Bridge pairing | Pairing dialog opens over the app | — | — |
| 3 | Generate a fresh pairing code in the authenticated Control Center | One-time code displayed once, expiry ~10 minutes | — | — |
| 4 | Enter the code and submit | Progress shown; success only with a 40+ character token | — | — |
| 5 | Confirm app does not minimize or close | Dialog remains until result; no activity destruction | — | — |
| 6 | Reopen app and inspect pairing state | Paired state persists; no token displayed | — | — |
| 7 | Verify pairing and device identity | Server lists this device; heartbeat shows the S26 Ultra model | — | — |
| 8 | Expired-code rejection | Rejected with `pairing_expired`; no token stored | — | — |
| 9 | Invalid-code rejection | Rejected with unknown/invalid code; no token stored | — | — |
| 10 | Revoked-token rejection | Next poll receives 401; credential cleared; revoke message | — | — |
| 11 | Reconnect after app restart | Polling resumes with the stored credential | — | — |
| 12 | Authenticated harmless device-status request | Queued `device.status` returns model/SDK evidence | — | — |
| 13 | Command authorization and approval boundaries | Unapproved or unsupported command is refused; no consequential action | — | — |
| 14 | Logs do not expose codes or secrets | Logcat contains neither the pairing code nor the token | — | — |
| 15 | Battery/background behavior and permissions | Polling continues per scheduler policy without unexpected permission prompts; Doze behavior recorded | — | — |

For tests 8–10, use separate fresh codes or a disposable device; do not revoke the owner's only paired device before capturing evidence. For test 13, use a read-only `device.status` command only.

## Numbered instructions for the owner on the S26 Ultra

1. On the phone, enable developer options and USB debugging only if you intend to capture logcat; otherwise skip USB and use the app UI.
2. Install the APK matching the SHA-256 above. Confirm the installed app version is `0.8.4` and package `com.habitat.axbridge`.
3. Launch Habitat and open the Bridge pairing screen.
4. In the authenticated Control Center, generate one fresh pairing code. Do not paste it into chat, a ticket or a screenshot.
5. Enter the code in the app and submit. Watch whether the dialog survives and whether the app minimizes.
6. Wait for the paired state, then close and reopen the app. Confirm it remains paired and does not show the token.
7. In the Control Center, confirm the device appears with the expected S26 Ultra model and a recent heartbeat.
8. Generate a second code, wait more than 10 minutes, and try it. Record the rejection text.
9. Generate a third code and deliberately alter one character. Record the rejection.
10. From the authenticated Control Center, revoke the test device. Confirm the phone reports revocation and clears its state on the next poll.
11. Pair again with a fresh code, then force-stop and relaunch the app. Confirm polling resumes.
12. Queue only `device.status`; confirm the returned model/SDK evidence and that no consequential action occurred.
13. Capture logcat for the pairing window if USB debugging is enabled. Search for the code and token; both must be absent. Do not save the raw log with secrets.
14. Record battery level, charging state and whether polling continued after screen-off/Doze. Note any permission dialog.
15. Record each test's pass/fail, timestamp, phone model, Android build and app version in the table above.

## What is still not fixed or proven

- Pairing is **not** claimed fixed. Only compilation and source behavior are verified.
- No S26 Ultra-specific layout, Keystore, battery, Doze or lifecycle result exists.
- No APK was signed for release; this is a debug build.
- `RECORD_AUDIO` is declared although this test sheet does not exercise audio. Confirm whether it is required before a production release.

Do not merge on the basis of this document. It records a build, not a working phone integration.
