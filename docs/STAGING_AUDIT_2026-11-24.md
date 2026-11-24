# Habitat staging audit — 2026-11-24

Scope: `staging/integration` on `kushxwookiex420/Habitat`, the live staging service
`habitat-staging-e3ie.onrender.com`, and the paired Bridge APK on the owner's Galaxy S26 Ultra.
Production (`habitat-1-szzd.onrender.com`) was only read, never written.

Everything below is from an observed response, a CI run, or a database query. Where evidence could not
be collected the item is marked **UNVERIFIED** or **BLOCKED**, not "working".

## 1. Live staging service

| Item | Observed | Evidence |
| --- | --- | --- |
| Commit serving traffic | `efcf65c03acd1a429adde637891bb86c0098d168` | `GET /health` |
| Started / warm | `2026-11-24T05:12:44Z`, process answered continuously | `/health`, `/system/status` |
| Backend | `healthy` | `/system/status` |
| Storage | `ready`, adapter `cloudflare-d1`, `durable: true` | `/system/status` |
| Device bridge | `ready: true`, `durable: true`, `perDeviceTokens: true`, `axTokenConfigured: true` | `/health` |
| Gateway | `enabled`, `repository: true` | `/system/status` |
| MCP events | `enabled`, `configured`, `secretEncryption.configured: true` (`mcp-1`) | `/system/status` |
| Owner attestation | `configured_optional`, verifier `owner-1` | `/system/status` |
| Nexus executor | **off** — `nexus.configured: false`, `disabled_by_config` | `/health`, `/system/status` |
| Missions / workforce | **off** by flag, nothing read from D1 | `/system/status` |
| Model providers | all `false`; brain reported `missing_api_key` | `/system/status`, `/health` |
| Secrets exposed in status | `secretsExposed: false`; device ids and task text excluded | `/system/status` |

Production was read-only checked at the same time: `/health` 200 (commit `0d5eb6e4`, brain `ready`),
`/system/status` 404. Nothing was sent to it.

## 2. Phone pairing persistence — VERIFIED

The phone's credential survived the app being closed. The paired row's `last_seen_at` advanced from
`05:23:38.069Z` to `05:39:24.444Z` while no app screen was open — a 15 m 46 s gap that lines up with the
15-minute `JobScheduler` fallback, not the 5-second foreground poll.

That is direct evidence for three things at once:

1. the encrypted token in Android Keystore decrypts after the process was gone;
2. the phone authenticates to the **staging service** with per-device tokens against a durable D1;
3. background check-ins reach the service without the app in the foreground.

Which database the live service actually reads is **not observable from outside**: `/system/status`
reports the adapter and durability but never the database id, and the staging guard only refuses
production when `HABITAT_ENVIRONMENT=staging` is present — a flag the status payload does not confirm.
This audit therefore reports the phone link as verified against the service, not as proof that staging
is isolated from production data. A new `environment` component (committed in `system-status.mjs`) makes
that explicit on the next deploy: name, whether the guard is active, and whether production was refused.

What it also proves: **the 5-second live link is not running when the app is closed.** Commands
therefore wait for the periodic job, so remote-command latency is up to ~15 minutes, and a phone that
has been idle longer than the 45-minute presence TTL is reported offline even though it is paired.

## 3. Defect found and fixed: closing the app disconnected the phone

`MainActivity.onPause()` called `deviceBridge.stop()`. In the Activity's bridge instance that method also
stopped `HabitatBridgeService`, the foreground service that owns the 5-second poll. Every time the owner
left the app the live link was torn down, and only the 15-minute job remained — exactly the behaviour
measured in §2.

Fix (commit `e8afe65`):

- the Activity bridge is constructed with `startForegroundService = false`, so it can release its own
  poll loop without owning the connection;
- `onResume`, `onCreate` and the pairing-success path explicitly start `HabitatBridgeService`;
- `clearCredentials()` (explicit disconnect, or a 401 from the server) now stops the service too, so a
  revoked credential cannot leave an orphaned foreground connection behind.

The periodic job and the boot receiver are unchanged, so the fallback path still works if Android caps
the dataSync foreground service (Android 14+ enforces a time limit).

## 4. Defect found and fixed: no reproducible staging build

All phone sources in the repository hardcoded `https://habitat-1-szzd.onrender.com` — production — in
`AndroidDeviceBridge.kt`, `HabitatNetwork.kt` and five `BrainAdapter.kt` endpoints. The installed APK
demonstrably talks to staging (§2), which means it was produced by editing source by hand. Any rebuild
from the repository would silently point the phone back at production.

Fix (commit `e8afe65`): `BuildConfig.HABITAT_BASE_URL` with production as the default and a build-time
override.

```bash
gradle -PhabitatBaseUrl=https://habitat-staging-e3ie.onrender.com :app:assembleDebug
```

`AndroidDeviceBridge` and `HabitatNetwork` (including its DNS fallback) now derive from that value.
`BrainAdapter` still targets its own production chat endpoints and was deliberately left alone: changing
the chat path is not needed to verify the bridge and would widen the blast radius. It is listed as
remaining work in §7.

Verification: CI run `45334248577` — `Build debug APK` success, signing identity check success, artifact
`habitat-apk` (930,869 bytes). The APK is signed by the repository debug key, so it installs over the
current build instead of failing with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

## 5. Authentication and failure behaviour — VERIFIED (fail-closed)

| Probe | Result |
| --- | --- |
| `GET /ax/device/devices` without a token | `401 Ax bridge authentication required.` |
| `GET /device/commands/next` without a token | `401 Paired device authentication required.` |
| `POST /device/pair` with an unissued code | `401 pairing_unknown` — the error explains the next step and does not leak the code |
| `GET /ax/command/diagnostics` | `401 invalid_token` |
| `POST /mcp` | `401 gateway_token_required` |

No endpoint answered without a credential, and the unauthenticated `pair` probe proves the handler
reaches D1 (it distinguishes "unknown code" from a storage failure) without exposing anything.

## 6. Observability gap: "integration never seen" while the phone is connected

`components.heartbeat.state` is `never_connected` with `queue` all zero while `components.device` is
`online` with a fresh `last_seen_at`. Both are correct: the heartbeat tracks the *Ax/ChatGPT integration*
handshake, and no integration has ever acknowledged a beat. Read side by side, though, the status page
tells an owner "never connected" about a phone that is actively checking in. The two components need
labels that distinguish "phone link" from "integration heartbeat". Documented, not changed: the wording
is shared with production and the owner should choose the split.

## 7. Remaining work

1. **Command round trip — BLOCKED.** Queueing a command requires the `HABITAT_AX_BRIDGE_TOKEN` that
   authenticates `/ax/device/commands`, and minting a gateway token needs D1 write access. Neither
   credential is available in this workspace, and no command has ever been queued on staging
   (`components.device` shows a check-in, not a command). This is the one item of the requested
   verification that has no evidence yet.
2. **CI D1 credential — BLOCKED.** The read-only device audit (`.github/workflows/staging-device-audit.yml`,
   run `45334986154`) failed with `HTTP 401 (10000:Authentication error)` from Cloudflare, although the
   same repository secret succeeded at `2026-11-24T04:08Z` (run `45324211881`, 21/21). The staging
   service itself still reads D1 normally, so this is the CI secret, not the database. `HABITAT_D1_API_TOKEN`
   needs regenerating in repository secrets. Until then neither this audit nor the staging acceptance
   suite can produce fresh database evidence.
3. **APK rollout.** The lifecycle fix only takes effect in a newly installed build. The current APK keeps
   the 15-minute behaviour.
4. **Provider keys.** No model provider is configured on staging, so every model-backed worker reports
   `unavailable`. Intentional for a free-only staging run, but it means no inference was exercised.
5. **`BrainAdapter` endpoints** still hardcode production (§4).
6. **Nexus, missions and workforce** stay disabled until the command path is proven.
