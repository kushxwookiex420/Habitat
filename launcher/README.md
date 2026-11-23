# Habitat AX Launcher

An independent Android HOME launcher (`com.habitat.launcher`) that turns the phone into a
multi-page command environment. It is a separate app: it does not replace, modify or depend on the
existing Habitat bridge app (`com.habitat.axbridge`) and never writes to the backend.

## Pages

1. **AX Home** — 3D neural brain, live Habitat status, text and voice command entry, task list.
2. **Applications** — installed apps, search, categories, favorites, recents, folders, drag order.
3. **Computer** — Termux, files, remote-desktop shortcuts, browser and Codespaces.
4. **Habitat** — presence, workers with real blockers, task queue/receipts, diagnostics.
5. **Intelligence** — AX command entry, research links, AI tools, project collections.
6. **Gaming** — installed games, Winlator, cloud libraries, display/memory performance.
7. **Device Control** — battery, storage, memory, connectivity and settings shortcuts.

Swipe horizontally or tap the page dots. Page order, dock, gesture search and the Habitat endpoint
are configurable from the settings sheet.

## What it deliberately does not do

- No Ax token is stored, so the launcher cannot run owner-approved device actions, screenshots,
  taps or shell commands.
- AX commands are local: open a page, open an installed app, open a browser search. Anything else
  reports "not available" instead of pretending it worked.
- No Accessibility service, no overlay permission, no background service.
- No Android AppWidget hosting or floating windows in 1.0.0. Panels are fixed glass cards and the
  dock is a launch bar.
- No fake success: network actions show the server's real answer or the real error.

## Permissions

| Permission | Why |
|---|---|
| `INTERNET` | Read public Habitat status endpoints. |
| `ACCESS_NETWORK_STATE` | Show whether the phone is online. |
| `<queries>` MAIN/LAUNCHER | List launchable apps; no `QUERY_ALL_PACKAGES`. |

The HOME role is requested from settings and One UI remains selectable in Android settings.

## Build

```bash
gradle :launcher:testDebugUnitTest
gradle :launcher:assembleDebug
```

CI: `.github/workflows/launcher-apk.yml` builds `habitat-launcher-apk` with Gradle 8.10.2, AGP
8.7.3, Kotlin 2.0.21 and compile/target SDK 35, verifies the APK signature and publishes SHA-256.

## Install without a PC

1. Download the APK artifact on the phone (or transfer it).
2. Allow installs from that source when Android asks.
3. Open **Habitat AX → settings → Use Habitat AX as default home**, or Settings → Apps → Default
   apps → Home app.
4. To return to One UI, choose Samsung One UI Home in the same screen. The launcher never disables
   the system launcher.

Release builds are debug-signed unless an owner keystore is supplied at build time. Debug and release
signatures are not interchangeable; uninstall before switching.

## Habitat endpoint

Default: `https://habitat-1-szzd.onrender.com`. Only read-only endpoints are used: `/workers`,
`/device/status`, `/tasks` and `/health` in a browser. Change it in launcher settings; malformed URLs
are rejected and shown as unreachable rather than silently accepted.

## Tests

`launcher/src/test` covers page-order normalization, app search/category/favorites filtering,
command routing (including "no fake success") and tolerant parsing of worker/presence/task JSON,
including Android's literal `"null"` case.
