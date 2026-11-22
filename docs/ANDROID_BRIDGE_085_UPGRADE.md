# Android Bridge 0.8.2 → 0.8.5 upgrade and re-pair plan

**Status: PLAN ONLY.** Nothing in this document has been executed on a device. The current
installation must be treated as the source of truth until the owner explicitly approves a
replacement.

## 1. Verified facts

| Fact | Value | How verified |
|---|---|---|
| Artifact | `Habitat-0.8.5-ax-debug.apk` | CI run `45058300087`, 908,446 bytes |
| SHA-256 | `fa3abd32a158e5e9cd418682eed2312e8f4af2bd01ecbb99474654256bd20307` | `sha256sum` matches the published `.sha256` sidecar, re-checked 2026-11-22 |
| Package | `com.habitat.axbridge` | `app/build.gradle.kts` on the release branch |
| versionCode / versionName | `85` / `0.8.5` | same |
| Signature | APK Signature Scheme v2, self-signed **CN=Android Debug, O=Android, C=US** | v2 certificate extracted from the APK (debug certificate) |
| Installed app | **0.8.2** per the owner's report | **not independently verified** — no adb/device in this environment |

The installed version matters because release 0.8.5 contains the pairing-lifecycle fix:
`configChanges`/`singleTop`/`adjustResize`, saved `pairingDialogOpen` state, a pairing-button
timeout, and callback guards. 0.8.2 predates those changes, which matches the reported
"pairing screen closes" symptom.

## 2. Why an in-place update may fail

Android refuses to update a package unless the new APK is signed with the **same certificate** as
the installed one (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). A CI-built debug APK is signed with that
CI run's debug keystore; two CI runs do not share one unless a keystore is persisted. There is no
evidence that the installed 0.8.2 build shares a certificate with this 0.8.5 artifact.

Therefore the plan is **verify first, decide after** — never uninstall to "make the update work".

## 3. Gate 0 — preserve the current installation

Until the owner approves a replacement:

- Do not uninstall `com.habitat.axbridge`.
- Do not clear app data.
- Do not install over it "to see what happens" without recording the error.
- Do not change `HABITAT_OWNER_DEVICE_ID(S)` in production.

## 4. Preflight (read-only, safe now)

1. **Verify the artifact** before it reaches a device:

   ```
   node scripts/verify-apk-sha256.mjs Habitat-0.8.5-ax-debug.apk \
     fa3abd32a158e5e9cd418682eed2312e8f4af2bd01ecbb99474654256bd20307
   ```

   Must print `RESULT: PASS`. Any other result: stop.

2. **Record the installed identity** (requires the owner's device / adb):

   ```
   adb shell dumpsys package com.habitat.axbridge | grep -E "versionCode|versionName|signatures"
   adb shell pm path com.habitat.axbridge
   adb pull <path-from-previous-command> installed-0.8.2.apk
   ```

3. **Compare certificates** between the installed APK and the new artifact:

   ```
   apksigner verify --print-certs installed-0.8.2.apk
   apksigner verify --print-certs Habitat-0.8.5-ax-debug.apk
   ```

   The `Signer #1 certificate SHA-256 digest` values must be identical. If they differ, an in-place
   update **cannot** succeed.

4. **Capture the current device ID** so the owner allowlist can be restored if a reinstall is
   approved. In the app: AX → pairing dialog shows `This phone's device ID`. Record it (not a
   secret, but do not publish it).

## 5. Decision tree

### A. Certificates match

```
adb install -r Habitat-0.8.5-ax-debug.apk
```

`-r` keeps app data. The stored pairing token survives, the bridge starts on next launch, and the
existing pairing should continue. Verify: open the app, the bridge button reads `LIVE` only after an
authenticated poll, and the Control Center shows a recent check-in. If the token is rejected (401),
the app clears it and a re-pair is required — then follow section 6.

### B. Certificates differ (expected)

Two options, **both requiring explicit owner approval**:

**B1 — preferred: rebuild 0.8.5 with the installed signing key.** Requires the owner's keystore and
its passwords. Not available in this workspace, and never to be pasted into chat.

**B2 — approved replacement:** uninstall + install + re-pair.

Consequences the owner must accept before B2:

- App data is deleted: the device ID, the encrypted pairing token, and the Keystore key.
- The app generates a **new** device ID (`android-<uuid>`) on first launch.
- **Owner rights depend on the server allowlist.** `HABITAT_OWNER_DEVICE_ID` /
  `HABITAT_OWNER_DEVICE_IDS` reference the old device ID, so the freshly installed phone will pair
  but will **not be able to approve or cancel tasks** until the new ID is set in the Render
  environment (a production change requiring approval).
- Tasks and results live server-side and are unaffected; only phone-side credentials are lost.
- There is no reliable downgrade path either: reinstalling 0.8.2 is the same signature problem.

## 6. Re-pair after replacement (approved path)

1. Open the Control Center on the phone browser and sign in with the operator token
   (PR #97 adds **PHONE → PAIR A PHONE**; until #97 is deployed, mint the code through the existing
   Ax credential path).
2. Create a single-use code (10 minutes). It is displayed once and never stored in the page.
3. In the Bridge app, open `LINK` / `AX SET`, enter the code, submit.
4. Expect `Phone credential saved. Starting secure check-in…`, then `LIVE` only after an
   authenticated poll. A failure keeps the dialog open with the server's reason.
5. Owner-side check: the Control Center phone panel shows the new device ID and a recent check-in.
6. If the new device ID must approve tasks, update the Render owner allowlist (separate approval),
   then verify one approval end-to-end.

## 7. Verification matrix (must all hold)

| Check | Pass condition | Evidence |
|---|---|---|
| Artifact integrity | SHA-256 matches published value | `verify-apk-sha256` PASS |
| Version | `dumpsys` reports versionCode 85 / 0.8.5 | device output |
| Certificate | install succeeded with `-r`, or approved replacement completed | adb output |
| Credential | bridge reports `LIVE` only after authenticated poll | app + Control Center |
| Pairing lifecycle | rotating/keyboard/app-switch does not lose the pairing screen | manual observation |
| Owner rights | an approval succeeds from the phone (if owner ID updated) | task state + audit entry |
| Audit | approval/denial produce a security event | `/health`-independent audit endpoint or D1 read |

## 8. Rollback

- **Before replacement:** nothing to roll back; current app untouched.
- **After B2:** rolling back means uninstalling 0.8.5 and installing 0.8.2, which requires the
  0.8.2 APK and the same signing-identity problem; the pairing token is lost either way.
- Keep `installed-0.8.2.apk` pulled during preflight and its SHA-256 recorded so a rollback is at
  least technically possible.

## 9. What this plan does not claim

- No device was available; the installed version, certificate match and lifecycle behaviour are
  **unverified**.
- The 0.8.5 APK was not rebuilt in this session; its hash and certificate are the CI artifact's.
- This document performs no install, uninstall, data clear or environment change.
