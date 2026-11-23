# Bridge reconciliation (P0)

Status: **designed, implemented as a read-only check, not yet run against a device.**
No installation, re-signing, version change or pairing change was performed, and none is proposed here.

## 1. Why this exists

Two Bridge builds were in circulation. `0.8.7` was published as an update build and `0.8.6` is the
command/security line. Choosing the base for the next release without checking the artifacts would
have risked shipping a build that is update-compatible but functionally a step backwards.

## 2. Audited facts

| Property | Value |
| --- | --- |
| Release | `habitat-bridge-v0.8.7-update` (prerelease) |
| Release id | `455936969` |
| Target commit | `de3fb8b32747c11d67e930c3297b436136c506cd` |
| Workflow run | `45246007484` |
| APK | `habitat-bridge-0.8.7-update.apk` |
| Size | 926,998 bytes |
| SHA-256 | `c0c5c2188d3bd9c701d9c38676f06cbbb076c0ca427d592c81ea83b9b4058dd0` |
| Package | `com.habitat.axbridge` |
| Version | `0.8.7` / code `87` |
| SDK | min 26, target 35 |
| Certificate | `CN=Android Debug`, SHA-256 `50:8C:5A:3E:…:7C` |
| Services | `DeviceBridgeJobService`, `HabitatPresenceService` only |

What that means in plain terms:

- The build is **debug-signed**. "Recovered original signing identity" means it matches the debug
  certificate already installed on the phone, not that a release key exists.
- It is **update-compatible** with the installed-key `0.8.5` build: same debug certificate, so an
  update would be accepted by the device.
- It is **not a superset of 0.8.6**. The tag narrows `SAFE_COMMANDS` to `device.status`, removes
  `command-auth.mjs`, `device-commands.mjs`, the screenshot repository, the accessibility service and
  the `system-status` command path. Installing it would remove command capability the current
  architecture depends on.
- `android:debuggable="true"` and `allowBackup="true"` are present. Both are acceptable only because
  this is a debug build on an owner-controlled device; they are not acceptable for a public release.

## 3. Decision

Base future Bridge work on the **0.8.6 command/security branch**, or on a reconciliation branch cut
from it that re-applies the 0.8.7 packaging fixes. Do **not** install 0.8.7, re-sign it, rebase onto
it, or downgrade the installed app to it.

The installed `0.8.5` build is left exactly as it is: no reinstall, no signing change, no pairing
change. Preserving working phone functionality outranks having the newest APK on disk.

## 4. Read-only verification

`scripts/bridge-identity-check.mjs` reads the installed package identity and compares it with the
audited release. It is the P0 deliverable, and it is deliberately incapable of changing anything.

```bash
# Identity of the installed app on the attached device
node scripts/bridge-identity-check.mjs

# Also verify a local APK artifact by size and SHA-256 (still no install)
node scripts/bridge-identity-check.mjs --apk path/to/habitat-bridge-0.8.7-update.apk

# Target one device when several are attached
node scripts/bridge-identity-check.mjs --device R58M12345
```

It exits non-zero unless the identity matches, and it prints JSON so the result can be archived.

### What it may run

Only three command shapes, each validated against an allowlist before execution:

- `adb devices`
- `adb -s <id> shell dumpsys package com.habitat.axbridge`
- (the check refuses anything else)

### What it refuses

Every `adb` argument that could change device state: `install`, `install-multiple`, `uninstall`,
`push`, `pull`, `reinstall`, `restore`, `backup`, `clear`, `pm`, `am`, `cmd`, `input`, `screencap`,
`screenrecord`, `uiautomator`, `settings`, `wm`, `svc`, `root`, `unroot`, `remount`, `reboot`,
`disable-verity`, `enable-verity`, `logcat`, `bugreport`, `sideload`, `sign`, and the server verbs.
A `shell` entry point is allowed only for `dumpsys` or `getprop`.

The refusal is a thrown error, not a warning, and the guard runs before every command — so an edit
that adds a mutating call fails loudly instead of quietly installing something.

### Honest outcomes

| Code | Meaning |
| --- | --- |
| `identity_matches` | Package, version, SDK levels and signer fingerprint all match |
| `identity_mismatch` | At least one field differs; `mismatches` names each one |
| `adb_unavailable` | `adb` is not installed here — nothing was read, nothing changed |
| `device_unavailable` | No authorised device attached |
| `package_unreadable` | `dumpsys` failed; the app may not be installed |
| `package_not_found` | No package record returned |

`adb_unavailable` is **not** a pass. In this environment there is no phone and no `adb`, so the
installed-device identity is **unverified**; the local APK identity is verified.

## 5. Pairing invariants

- The pairing code and device token are unchanged. Reconciliation reads state; it never re-pairs.
- A future install, if the owner ever authorises one, must reuse the existing debug keystore so the
  update is accepted and the pairing survives.
- The check never handles a token, never reads the device token store, and never prints a credential.

## 6. Remaining limitations

- The installed `0.8.5`/`0.8.7` identity on the physical phone is unverified here.
- Certificate comparison depends on `dumpsys` printing a `signatures=` block; an OEM build that
  omits it reports a `certificateSha256` mismatch rather than guessing.
- This check says nothing about runtime behaviour, only about identity.
