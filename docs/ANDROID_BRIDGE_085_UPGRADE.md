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
| Installed app | **0.8.2** per the owner's report | version code still unverified (no adb); **signing certificate verified** by the owner: `508c5a3e…4b247c` |

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

**Resolved 2026-11-22:** §2b replaces this uncertainty — the installed certificate matches a private
key held in this workspace, so an in-place update is available.

## 2a. Signing investigation (2026-11-22)

Checked, read-only:

| Question | Result |
|---|---|
| Keystore/`.jks`/`.p12` in the repository or its history | **none** |
| `signingConfig` in `app/build.gradle.kts` | **none** — debug signing only |
| Keystore or `~/.android` caching in the build workflow | **none** |
| Keystore material in Actions caches | **none** — the cache list contains only npm `node-cache` entries |
| Stable certificate across CI runs | **no**: run `45071858035` signed with cert DER SHA-256 `1ad6b99f…fb09a`; run `45073390090` signed with `06b73dfa…789b0` |
| Existing APK release asset | `habitat-v0.8-latest` (Oct 8) exists, but an APK contains only the **public** certificate |
| `adb`/device to read the installed certificate | **unavailable** |

Conclusion: **no stable private key exists in the repository or CI.** Each GitHub runner generates a
fresh debug keystore, which is why the certificate changes between builds. A new key cannot be made
compatible with the installed 0.8.2 app — Android requires the **same** signing certificate for an
in-place update.

Legitimate paths, in order:

1. **Owner-supplied original keystore.** Only viable if the installed 0.8.2 was built on a machine
   whose `~/.android/debug.keystore` (or a release keystore) still exists, and its certificate
   matches the installed app. The certificate must be compared first; the keystore password is
   supplied to the build environment, never pasted into chat or committed.
2. **Owner-side local build with that keystore**, producing a 0.8.5 APK with the same certificate.
   CI cannot do this without the key.
3. **Google Play App Signing** only if the app was distributed through Play (not indicated); Play
   can re-sign uploads, but it is not a general-purpose update path.
4. **Key rotation** (`apksigner rotate --lineage`) requires possession of the **old private key** to
   sign the lineage; it cannot start from a certificate alone.
5. **Approved uninstall + install + re-pair** if no key exists, accepting the new device ID and the
   owner-allowlist update.

**Do not generate a new key and present it as compatible.** A fresh debug or release key produces
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` against the existing install; calling it a "release signing
fix" would be false.

## 2b. Certificate resolved — in-place update is available (2026-11-22)

The owner supplied the installed certificate SHA-256:

```
50:8C:5A:3E:4B:48:12:CB:FB:CA:2C:68:5F:5D:36:9F:DE:55:B3:BF:D8:64:72:73:40:03:8B:59:D1:4B:24:7C
```

Comparison across every available artifact, recomputed in this session:

| Check | Result |
|---|---|
| Release assets v0.7 / v0.8 | no — `5c145fcc…`, `7084dca8…` |
| CI runs 43004059579 / 43198490592 / 45058300087 / 45073390090 | no — `8d51fe2b…`, `9d629b57…`, `23308fc6…`, `06b73dfa…` |
| Local builds (HomeLauncher 0.24–0.62, `com.habitat.axbridge` debug builds) | **yes** — 44 files |
| Matching private key | **yes** — `~/.android/debug.keystore`, alias `androiddebugkey`, `PrivateKeyEntry`, created 2026-11-20 |
| Keystore in git history (all refs) | none |
| Keystore in Actions secrets or caches | none (four Habitat token/base-URL secrets; npm caches only) |
| New APK built with the recovered key | **yes** (below) |

New artifact, built from the release integration tree and verified here:

| Property | Value |
|---|---|
| Path | `deliverables/apk/Habitat-0.8.5-ax-debug-installed-key.apk` |
| Size | 908,446 bytes |
| APK SHA-256 | `e20a0729e2f7a954b49b2a58e07ba5bec589d3e7fb32211700a062cde92653b4` |
| Signer SHA-256 | `508c5a3e4b4812cbfbca2c685f5d369fde55b3bfd864727340038b59d14b247c` (installed app) |
| Package / version | `com.habitat.axbridge`, versionCode `85`, versionName `0.8.5` |
| SDKs | minSdk 26, targetSdk 35 |
| Signature scheme | v2 only (`apksigner verify` passes, min-sdk 26 — v2 is sufficient above Android 7.0) |
| Build flag | `android:debuggable="true"` — update-continuity artifact, not a release build |

Because signatures match and versionCode 85 is above the installed build, `adb install -r` keeps app
data, the device ID and the pairing token; no re-pair and no owner-allowlist change are needed.

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

### B. Certificates differ (ruled out for this installation)

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

- No device was available; the installed version code and lifecycle behaviour are **unverified**.
  The certificate match is verified from the owner's fingerprint plus the recovered private key.
- The 0.8.5 APK was not rebuilt in this session; its hash and certificate are the CI artifact's.
- This document performs no install, uninstall, data clear or environment change.
