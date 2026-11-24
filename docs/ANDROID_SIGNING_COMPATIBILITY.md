# Android signing compatibility

The owner's constraint: **do not ask for the working app to be uninstalled, and do not offer an APK
that cannot take its place.**

## The finding

`android-apk.yml` built a debug APK on a GitHub runner with no keystore cache. Gradle signs a debug
build with `~/.android/debug.keystore`, which the Android plugin creates on demand — so **every CI
job produced a different signing certificate**. Two builds of the same code came out at the same size
with different digests (`45291043269` and `45295570521`, both 930,401 bytes).

Consequences:

- `adb install -r` over a build from a different job fails with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` — the signatures differ.
- The only way around that is uninstalling, which erases the app's pairing state. That is exactly
  what the owner forbade, so it is not offered as a default step.

## What changed in CI

The workflow now caches one debug keystore (`android-debug-keystore-v1`) and creates it only when the
cache is cold. From the next build onward, consecutive CI debug builds share an identity, so they can
replace each other. This is additive: the release-signing step and the four `HABITAT_KEYSTORE_*`
secrets are untouched, and no certificate is regenerated for an existing install.

## Before installing anything on the S26 Ultra

1. Read the installed identity:
   ```sh
   adb shell pm path com.habitat.axbridge
   adb shell dumpsys package com.habitat.axbridge | grep -A 3 "signatures"
   ```
2. Read the APK's certificate (needs a JDK; neither `apksigner` nor `keytool` exists in the
   development workspace, so this step is the owner's):
   ```sh
   keytool -printcert -jarfile app-debug.apk | grep -E "SHA256|Owner"
   ```
3. Compare the two `SHA256` values.

## Decision tree

- **Digests match** → `adb install -r app-debug.apk`. Pairing state and app data survive.
- **Digests differ, and the installed app is a locally built debug build** → rebuild locally with the
  same `~/.android/debug.keystore` that produced the installed build, or install the CI APK under a
  different `applicationId` for testing. No uninstall.
- **Digests differ and the installed app is the one to keep** → the only correct path is a *release*
  identity: create one keystore, store it as the four `HABITAT_KEYSTORE_*` secrets, and sign every
  future build with it. The first switch from a debug build to a release build requires one
  uninstall, and that is an owner decision with the pairing loss stated in advance — it is not a step
  an agent takes on its own.
- **Never** install an APK whose digest was not compared first, and never present a CI-successful
  build as a working install.

## Status

- CI signing is now stable between builds: implemented, not yet verified on a real run.
- The APK's certificate against the phone's installed certificate: **not verified** — no device and
  no JDK here.
- Release signing: **not configured** — the four secrets do not exist.
