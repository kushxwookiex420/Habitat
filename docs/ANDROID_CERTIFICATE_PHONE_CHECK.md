# Read the installed Habitat Bridge signing certificate from the phone

Goal: obtain the **SHA-256 signing-certificate fingerprint** of the installed
`com.habitat.axbridge` (0.8.2) on the Samsung S26 Ultra **without a computer, without uninstalling
the app, and without touching any credential**.

A signing certificate is public information. Reading it cannot expose the pairing token, the device
ID or the app's private data. Do **not** use a site or app that asks for your Habitat token, account
login or Accessibility access.

## Recommended: KeyStoreViewer (open source, F-Droid)

`KeyStoreViewer: App Signatures` (`com.seiko.keystoreviewer`, GPLv3) reads the signing information
Android exposes through `PackageManager`; it needs no root and no special permissions.

1. Open **F-Droid** (the official client, installed from f-droid.org). If it is not installed,
   install it from `https://f-droid.org/F-Droid.apk` in the phone browser.
2. Search for **KeyStoreViewer: App Signatures**, confirm the package id is
   `com.seiko.keystoreviewer`, and install it.
3. Open the app and search for **Habitat** (or `com.habitat.axbridge`).
4. Open the app entry → **Signatures**. It shows MD5, SHA-1 and **SHA-256** fingerprints.
5. Copy the **SHA-256** value (or screenshot it). Colons, spaces and letter case do not matter.
6. Leave Habitat Bridge installed. Installing a viewer does not modify Habitat or its data.

### Alternative: App Manager

`App Manager` (`io.github.muntashirakon.AppManager`, GPLv3, F-Droid) → find **Habitat** → app details
→ **Signatures** tab → SHA-256.

## What to send back

Only the SHA-256 fingerprint, for example:

```
AB:CD:...:EF
```

This is safe to share. It is **not** the APK checksum and **not** a secret. Do not send the device ID
or the pairing code unless a separate step explicitly asks for them.

## Comparison rule

Normalise before comparing: remove `:`, spaces and newlines, lowercase. Then compare all 64 hex
characters. A prefix match is not a match.

## Historical artifacts and their certificates

All values were computed directly from the APK files in this session. They are **public certificate
fingerprints**, not private keys.

| Artifact | Source | Bytes | APK SHA-256 | Certificate SHA-256 |
|---|---|---|---|---|
| `Habitat-v0.7-Ax-debug.apk` | release `habitat-v0.7-latest` | 884,318 | `53176ed9…d480ea` | `5c145fcc58f3ec10db613a9114124fff508d475280b588f617ea37c2fd4e95df` |
| `Habitat-v0.8-Ax-debug.apk` | release `habitat-v0.8-latest` | 907,034 | `0aa68c4f…0384dfc` | `7084dca89e059f9eb5bb1d5a98af6c5c5a5c2adc90a6995e8db50ad7b4a7eea2` |
| `Habitat-Regular-v0.8-Ax-debug.apk` | run `43004059579` (`3325b9f`) | 905,698 | `cd72a546…3ec2dc0` | `8d51fe2ba6e7a37233970420781e8ab838c891965e188c7fc362d04eb33d951d` |
| `Habitat-v0.8-Ax-debug.apk` | run `43004059579` (`3325b9f`) | 905,722 | `281b9478…ef2c58d` | `8d51fe2ba6e7a37233970420781e8ab838c891965e188c7fc362d04eb33d951d` |
| `Habitat-Regular-v0.8-Ax-debug.apk` | run `43198490592` (`2c719e2`) | 907,338 | `ffce2688…613434a` | `9d629b57d75c8f2750c09d74ff676f8e4bb03bf4dc26cf49d863cae97e8466ba` |
| `Habitat-v0.8-Ax-debug.apk` | run `43198490592` (`2c719e2`) | 907,338 | `7b3db49d…8d0505` | `9d629b57d75c8f2750c09d74ff676f8e4bb03bf4dc26cf49d863cae97e8466ba` |
| `Habitat-v0.8-Ax-debug.apk` | run `45058300087` (`57a5123`, 0.8.5) | 908,446 | `fa3abd32…bd20307` | `23308fc63dec0f2fa6b50ad7d4a58606b00cc8adac7a24b899f4906d5eb4361d` |
| `Habitat-v0.8-Ax-debug.apk` | run `45073390090` (`30334fa`, single-flight) | 911,006 | `3211d709…8021bdd` | `06b73dfabce6d48b4773f90e47056943d8eef078b611a470aa8132f7131789b0` |

Pattern: two APKs produced by the same build share a certificate; **different builds do not**. Each
GitHub runner generates a fresh debug keystore.

## Interpreting the result

- If the installed fingerprint **matches one row**, the installed build came from that artifact and
  the same private key signed it. That key is not in the repository or its caches; unless the owner
  still has the machine that built it, it is still unrecoverable.
- If it **matches no row**, the installed 0.8.2 was built elsewhere (for example Android Studio's
  `~/.android/debug.keystore` on the owner's computer). That machine is then the only possible
  source of a compatible key.
- Either way, **do not uninstall**. The fingerprint decides which path applies; see
  `ANDROID_BRIDGE_085_UPGRADE.md` and `ANDROID_SIGNING_SETUP.md`.

## What this does not do

It does not prove the app is unmodified, does not reveal the private key, and does not make a new
key compatible. It only identifies the certificate the phone already trusts.
