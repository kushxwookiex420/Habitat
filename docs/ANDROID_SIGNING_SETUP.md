# Stable, owner-controlled Android signing

Two different problems are often confused:

| Goal | Requirement |
|---|---|
| Update the **installed 0.8.2 in place** | The APK must be signed with the **same private key** that signed 0.8.2. Nothing else works. |
| Create a **stable identity for future installs** | A new, owner-held release key, used consistently from then on. It cannot update the current install. |

This document covers both, and never asks for a key or password in chat or in the repository.

## A. In-place update of the installed app

1. Read the installed certificate fingerprint with the phone-only procedure in
   `ANDROID_CERTIFICATE_PHONE_CHECK.md`.
2. Find the machine that built 0.8.2. The most likely location is Android Studio's default debug
   keystore:
   - macOS/Linux: `~/.android/debug.keystore`
   - Windows: `%USERPROFILE%\.android\debug.keystore`
   - default alias `androiddebugkey`, default store/key password `android`
3. Check it **locally**, without uploading it:
   `keytool -list -v -keystore debug.keystore -alias androiddebugkey`
   Compare its SHA-256 with the phone fingerprint. A prefix is not a match.
4. If it matches, that file is the signing identity. Treat it as a secret from now on: back it up
   encrypted, never commit it, never paste it or its password into chat.
5. Supply it to the build through CI secrets (section C), build 0.8.5 with `versionCode 85`, verify
   the certificate equals the phone fingerprint, then install with `adb install -r` when a device
   session is available.

If no machine or backup has that key, **there is no in-place update**. The only remaining path is an
owner-approved uninstall + install + re-pair, which changes the device ID and needs the owner
allowlist updated.

## B. New stable release key (fresh installs only)

Generate it on an offline or trusted machine with a JDK:

```
keytool -genkeypair -v \
  -keystore habitat-release.jks \
  -alias habitat-release \
  -keyalg RSA -keysize 4096 -validity 10000
```

- Use a strong, unique password stored in a password manager.
- Make **two encrypted offline backups** (separate physical locations). Losing this file permanently
  loses the ability to update apps signed with it.
- Add `*.jks`, `*.keystore` and `keystore.properties` to `.gitignore`.
- A new key **cannot** update the installed 0.8.2; it is for a fresh install / re-pair path.

## C. GitHub Actions without exposing the key

Store four repository secrets (Settings → Secrets and variables → Actions). Never put values in a
workflow file, a commit, an issue or chat.

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 habitat-release.jks` (macOS: `base64 -i habitat-release.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `habitat-release` (or `androiddebugkey` for the imported debug key) |
| `ANDROID_KEY_PASSWORD` | key password |

Workflow shape (illustrative; adapt to this repo's `build.gradle.kts`):

```yaml
- name: Decode signing key
  env:
    KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
  run: |
    set -euo pipefail
    umask 077
    printf '%s' "$KEYSTORE_BASE64" | base64 -d > "$RUNNER_TEMP/habitat.jks"
- name: Build signed release
  env:
    KEYSTORE_PATH: ${{ runner.temp }}/habitat.jks
    KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
    KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
    KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
  run: gradle :app:assembleRelease --no-daemon
- name: Verify certificate
  run: |
    apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk \
      | tee "$RUNNER_TEMP/cert.txt"
    # Fail unless the expected fingerprint is present (keep this value in the repo, it is public).
    grep -qi "<EXPECTED_SHA256>" "$RUNNER_TEMP/cert.txt"
```

Rules:

- Decode only into `$RUNNER_TEMP`, with `umask 077`, and let the runner discard it.
- Do not use `set -x` around secret steps; do not `echo` passwords.
- Publish the **certificate fingerprint** and APK SHA-256 in release notes, never the key.
- Pin the expected certificate SHA-256 in a repository doc or script so a signing-config regression
  fails the build instead of shipping a differently signed APK.
- Keep `signingConfig` values in environment variables / Gradle properties read from env; never in
  `gradle.properties` or `build.gradle.kts`.

## D. Rotation and distribution

- `apksigner rotate --old-signer … --new-signer … --out lineage` requires the **old private key**.
  Without it there is no lineage and no in-place update.
- Google Play App Signing can re-sign uploads, but only applies if the app is distributed through
  Play. This app is not.
- A debug-signed APK is for private sideload/testing only. Do not present it as a release build.

## E. Owner checklist

1. Run the phone certificate check; record the SHA-256.
2. Search the build machine for the matching keystore; verify locally with `keytool`.
3. If found: add it as CI secrets (section C), build 0.8.5, verify cert equality, then a device
   session installs with `-r`.
4. If not found: choose between an approved uninstall + re-pair (and owner-ID update) or staying on
   0.8.2 until a device session can re-pair.
5. Regardless: create a stable release key for the future (section B) and store it off-repo.
6. Never send the keystore, its base64, or any password through chat.
