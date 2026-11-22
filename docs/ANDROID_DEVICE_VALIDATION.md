# Android device validation — Galaxy S26 Ultra

Mission 10 changed the pairing dialog so it survives activity recreation. That change is
compile-verified on this branch; it has **not** been run on a physical phone from this environment.
This document separates the three levels of evidence so they cannot be confused.

## Evidence levels

| Level | What it proves | Current status |
| --- | --- | --- |
| Compile | Kotlin and resources build; manifest merge succeeds | `:app:compileDebugKotlin` and `:app:assembleDebug` pass locally |
| Emulator | The app installs, launches and survives lifecycle events on an emulator image | Not run: no emulator in this environment |
| Physical | The Galaxy S26 Ultra pairs and executes a harmless command | Not run: no device attached |

The server must never report a device as authenticated, connected, reachable or operational from an
installed app, an old pairing record or a successful handshake alone. Connection state comes from a
recent proof; receipts come from a completed command.

## Build the APK

```bash
export JAVA_HOME="$PWD/../toolchain/jdk-17.0.21.1+2"
export ANDROID_HOME="$PWD/../toolchain/android-sdk"
../toolchain/gradle-8.9/bin/gradle --offline --console=plain :app:assembleDebug
```

Artifact: `app/build/outputs/apk/debug/app-debug.apk`.

## Install on the phone

1. Enable developer options and USB debugging on the Galaxy S26 Ultra.
2. `adb install -r app/build/outputs/apk/debug/app-debug.apk`
3. Open Habitat and keep the pairing dialog visible.

Use a staging or local bridge with an owner test device id. Do not use production credentials for a
validation run, and never paste a pairing code into chat, logs or a report.

## Required checks (record pass/fail for each)

Lifecycle and layout:

1. Rotate portrait → landscape → portrait while the pairing dialog is open. The typed code must
   survive and the dialog must not duplicate.
2. Open and close the software keyboard while the dialog is open. Layout must remain scrollable.
3. Change display size or font scale in system settings; reopen the app; the dialog remains usable.
4. Background the app with the dialog open, then return. State is preserved or safely reset, never
   submitted twice.
5. Kill and relaunch the app. No stale "paired" state is shown without a new proof.

Pairing and failure paths:

6. Submit an expired pairing code; the server returns an expiry error and the UI keeps the dialog
   usable.
7. Submit the same valid code twice; the second submission is rejected, not silently accepted.
8. Disable network, submit; a timeout is shown and the code is not marked used.
9. Interrupt network mid-request, restore it, retry; no duplicate device registration.
10. Pair successfully once; confirm the server records a device with a bounded proof, not a
    permanent "authenticated" flag.

Connection, revocation and receipts:

11. Close the app; server connection state becomes stale/unknown, not connected.
12. Revoke the device on the server; the next command is refused and the app reflects the refusal.
13. Reconnect and send one harmless allowlisted command (for example a status read).
14. Send a second identical command with the same idempotency key; exactly one execution occurs.
15. Confirm the acknowledgement and the execution receipt match the command id.
16. Send a destructive or unapproved command; it must be refused and recorded as a denied security
    event.

## Recording evidence

For each check record: timestamp, app version/commit, build type, device model, Android version,
action, expected result, observed result, screenshot or logcat excerpt (redact tokens). Store the
record outside the repository or in a private validation note; never include pairing codes or tokens.

## Reporting rule

Until checks 1–16 have run on the physical phone, describe the pairing fix as "compile-verified,
awaiting physical validation". A successful install is not a successful pairing test.
