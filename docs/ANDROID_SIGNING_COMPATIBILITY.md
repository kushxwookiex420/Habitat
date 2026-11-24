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

## Measured, 2026-11-24 (no device required)

The APK Signing Block was parsed directly (`scripts/apk-cert-fingerprint.mjs`, no JDK), giving each
build's certificate SHA-256:

| Build | Certificate SHA-256 | Meaning |
| --- | --- | --- |
| `45295570521` (pre-change) | `fc31bcc259f77a7c116cecd2eb72e75f66ac68309946a311dc141c93d2c79917` | one throwaway key |
| `45296639342` (first with the cache) | `dc0c9c853f7d1192201f91e5c7278a82137b1732af78ec0487ee2dcac268fd3d` | a different throwaway key |
| `45298386950` (second with the cache) | `ac30fae8718bbb31e38e2ee5f0771f53eef76876dbb63f5ab458a956219dcc91` | **also different** |

So the `actions/cache` step did **not** give the builds one identity: the cache was not restored and
every job fell through to generating a keystore.

### Resolved: the repository owns the identity

The cache is gone. `debug-key.p12` is committed (a debug key with the public `android` password,
referenced **only** by the debug build type) and `app/build.gradle.kts` pins the debug build to it.
`EXPECTED_DEBUG_CERT_SHA256` records the certificate fingerprint, and the workflow fails the build if
the APK does not carry it.

Proof, not intent:

| Check | Value |
| --- | --- |
| Keystore subject / validity | `CN=Android Debug, O=Android, C=US`, to 2056-11-16 |
| Expected fingerprint | `791eacbc33fbfcdb770a4299342cb1ad8fc6d959325df75091a03004726eb258` |
| CI run `45300974210` | `Verify the signing identity is the repository's` → **success** |
| APK from that run | 930,401 bytes, fingerprint `791eacbc…eb258` — identical |

Any future build from any machine now replaces the previous one.

What this means for installing:

- Consecutive CI builds still cannot replace each other, and none of them can replace an installed
  build from a different signer.
- Comparing `ac30fae8…` (or any build's own fingerprint) with the certificate of the installed
  **0.8.7** app is the only way to know whether `adb install -r` can work. That comparison needs the
  phone: `adb shell dumpsys package com.habitat.axbridge | grep -A3 signatures`.
- The repository declares `versionName` **0.8.6**, while the installed app reports **0.8.7**, so the
  installed build did not come from this tree's current state. Do not assume any APK here matches it.

Still outstanding is the comparison that decides whether an APK can replace the **installed 0.8.7**.
That is a property of the phone, not of the build, and needs the two reads below on the device. Until
it matches, no APK here is offered as an upgrade — the installed app stays untouched.

## Status

- CI signing is stable between builds: **false, measured** — see the table above.
- The APK's certificate against the phone's installed certificate: **not verified** — no device and
  no JDK here.
- Release signing: **not configured** — the four secrets do not exist.
