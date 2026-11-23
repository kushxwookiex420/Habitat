# Android bridge — Mission 14 build and device test

Android physical status: BUILD ONLY — owner-blocked
Owner action: Install `app/build/outputs/apk/debug/app-debug.apk` on the Galaxy S26 Ultra, run the 15 checks below, and record the model, Android build number, timestamps and per-check result.

**No phone and no emulator were attached to this environment.** `adb` is not installed, no device is
authorised, and no pairing, heartbeat or command execution was performed. The APK is compiled and
packaged; that is the whole claim.

---

## 1. The artifact

| Field | Value |
| --- | --- |
| Path | `app/build/outputs/apk/debug/app-debug.apk` |
| Size | 908,446 bytes |
| SHA-256 | `e20a0729e2f7a954b49b2a58e07ba5bec589d3e7fb32211700a062cde92653b4` |
| Package | `com.habitat.axbridge` |
| versionCode / versionName | 85 / 0.8.5 |
| min / target / compile SDK | 26 / 35 / 35 |
| Permissions | `INTERNET`, `ACCESS_NETWORK_STATE`, `RECEIVE_BOOT_COMPLETED`, `RECORD_AUDIO` |
| Build | `:app:assembleDebug`, `BUILD SUCCESSFUL`, JDK 17.0.21.1, Android SDK 35.0.0 |
| Signing | debug keystore (not a release artifact) |
| Physical verification | **none** |

Previous build for comparison: 0.8.4, 908,394 bytes,
`aa022d8b3f56f8cf9c45c8e5f79fdb8706e64d80cb9e8a006d7afbc61e71f950`.

## 2. What changed in source for Mission 14

The pairing lifecycle defect (entering a code minimised/closed the bridge) had already been
addressed before this mission. Mission 14 audits that work and adds the remaining IME handling:

| Area | State | Where |
| --- | --- | --- |
| Activity recreation on keyboard/orientation | prevented with `configChanges` | `AndroidManifest.xml` |
| Secondary instance from recents/notification | `launchMode="singleTop"` (new) | `AndroidManifest.xml` |
| Keyboard covering/dismissing the pairing dialog | `windowSoftInputMode="adjustResize"` (new) | `AndroidManifest.xml` |
| Dialog state across a real recreation | saved flag + restore + explanation toast | `MainActivity.kt` |
| Callback after the Activity is gone | `isFinishing`/`isDestroyed`/`isShowing` guards | `MainActivity.kt` |
| Button stuck on "Connecting…" | 20 s reset runnable | `MainActivity.kt` |
| Network work off the UI thread, exceptions contained | daemon thread + try/catch | `AndroidDeviceBridge.kt` |
| Token persistence | AES/GCM with Android Keystore | `AndroidDeviceBridge.kt` |

All of this is **compile-verified only**. Whether the dialog truly survives a physical keyboard,
process death and a real pairing round trip is exactly what the sheet below decides.

## 3. Install

```sh
# Owner machine, with platform-tools on PATH and USB debugging authorised.
adb devices                                   # expect the S26 Ultra serial, state "device"
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell dumpsys package com.habitat.axbridge | grep versionName   # expect 0.8.5
```

## 4. The 15-check sheet

Record the outcome of each check. A check that was not run is `NOT RUN`, never `PASS`.

| # | Check | How | Pass condition |
| --- | --- | --- | --- |
| 1 | Cold launch | tap the icon | bridge opens, no crash |
| 2 | Open pairing dialog | tap the AX/LINK control | dialog stays up, device ID visible |
| 3 | Focus the code field | tap it | keyboard opens; dialog still visible and scrollable |
| 4 | Type 20+ characters | paste a real code | text appears; no minimise, no close |
| 5 | Rotate the phone | rotate while the keyboard is open | dialog survives, input preserved or clearly restored |
| 6 | Background and return | Home, then recents | dialog state handled; if recreated, the restore toast appears and the sheet can be reopened |
| 7 | Invalid short code | submit `abc` | inline error, dialog stays open |
| 8 | Expired/invalid code | submit a stale code | server error shown in the dialog, button re-enabled |
| 9 | Valid pairing | submit a fresh code | "Phone paired successfully", dialog closes, control shows AX SET |
| 10 | Heartbeat | wait 60 s | server `/device/status` shows the device as recently seen |
| 11 | Token persistence | force-stop, relaunch | still paired; no re-pair needed |
| 12 | Reboot persistence | reboot the phone | job service scheduled; bridge reconnects |
| 13 | Command receipt | queue `device.status` from the control center | the phone reports a receipt; state is not invented |
| 14 | Disconnect | open dialog → Disconnect | credential removed, control shows LINK, no crash |
| 15 | Keystore failure path | revoke the key (or reinstall over a changed keystore) | pairing fails with a visible message, never a silent success |

Redaction: never include the pairing code or device token in the recorded evidence. Record the
device model, Android build number, app version and timestamps only.

## 5. Why this is not "fixed" yet

The code path is coherent and compiles, but three physical behaviours cannot be proven without the
phone: the IME interaction, process death while the dialog is open, and a real pairing exchange
against a deployed service. Until the sheet is run, the accurate statement is:

> The pairing lifecycle is corrected in source and the APK is rebuilt; physical pairing is
> unverified.
