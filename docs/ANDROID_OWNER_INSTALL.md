# Owner-device APK install and authentication test pack

This is the hand-off for putting the current Bridge build on the S26 Ultra. It cannot be completed
from the development workspace: there is no `adb`, no USB device and no owner keystore here.

## The build to install

| Field | Value |
| --- | --- |
| Artifact | `habitat-apk/debug/app-debug.apk` from the **Android APK** workflow |
| Build run | `45295570521` (`workflow_dispatch`, branch `staging/integration`, commit `50e9c74`) |
| Size | 930,401 bytes |
| SHA-256 | `c39463da90a073e001855bb6ab54e83648bd5afca49ecdf3490f8e84f0135113` |
| Package | `com.habitat.axbridge`, `versionName` 0.8.6, `minSdk` 26, `targetSdk` 35 (S26 Ultra on API 36 is in range) |
| Earlier run | `45291043269`, same size, SHA-256 `aed01978…ac6ff` — the two builds are **not** byte-identical |
| Signing | **debug key only** — not the production identity |
| Contents verified | `AndroidManifest.xml`, `classes.dex`, `classes2.dex`, `classes3.dex`, `res/xml/habitat_accessibility_service.xml` |

Download it from the run's artifacts, then verify before installing:

```sh
sha256sum app-debug.apk
# run 45295570521 must print c39463da90a073e001855bb6ab54e83648bd5afca49ecdf3490f8e84f0135113
```

Two debug builds of the same commit produce the same size but different digests (run `45291043269`
and `45295570521` both report 930,401 bytes with different hashes), so a debug APK is not
byte-reproducible. Verify the digest **of the run you downloaded**; do not treat a stored digest as
an identity check across builds. A reproducible identity needs the release signing step below.

A debug-signed APK is installed by sideload and is **not** upgrade-compatible with a release-signed
build. If the phone already has a release build, uninstalling it first is required, which also clears
its stored pairing. Decide that before installing.

## Install

```sh
adb devices                                  # the phone must appear as "device", not "unauthorized"
adb install -r app-debug.apk                 # -r replaces an existing debug build
adb shell dumpsys package com.habitat | grep -E "versionName|signatures" | head -5
```

Record the printed `versionName` and signature digest; that is the identity evidence for
`docs/OWNER_DEVICE_AND_ORIGIN_TESTS.md` row 1.1. `adb_unavailable` is **not** a pass.

If `adb` is missing on the owner machine, the same three commands run from any machine with
platform-tools; nothing else is required.

## Pair and authenticate

1. Open the app, start pairing, and complete it against `HABITAT_BASE_URL`.
2. Record the device id the app presents and confirm it is stable across a force-stop and relaunch
   (row 1.2). A new id per launch means pairing is not persisted.
3. Confirm the owner credential is device-bound (row 1.3): present a valid owner token with a
   different `x-owner-device-id` and expect `401 owner_invalid`.
4. Confirm the accessibility service is enabled: `adb shell settings get secure
   enabled_accessibility_services` must list the Habitat service before any action that needs it.

## Then run the server-side rows

With the phone paired and the service reachable, run `docs/OWNER_DEVICE_AND_ORIGIN_TESTS.md` §2–§3
against the origin configured in the app:

- approval: request as agent, decide as owner, replay the decision (`409 already_decided`), let one
  expire (`approval_expired`);
- treasury: record `available` and a refund with `externalId`, replay the refund (`409
  duplicate_refund`), post a payout observation;
- rate limit and scheduler tick rows once the deployment is a staging service.

## What is still missing for production use

- **Release signing.** The workflow signs a release only when `HABITAT_KEYSTORE_BASE64`,
  `HABITAT_KEYSTORE_PASSWORD`, `HABITAT_KEY_ALIAS` and `HABITAT_KEY_PASSWORD` exist as repository
  secrets. They do not. Until then every build is debug-signed and cannot be distributed as an
  update to a release install.
- **A reachable origin running this code.** The live origin currently answers `/health` but returns
  `404` for `/ax/command/network/*`, so pairing against it tests older code.
