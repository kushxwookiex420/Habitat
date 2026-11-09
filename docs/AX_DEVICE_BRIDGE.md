# AX Device Bridge — Phase 1

## Purpose

Create a secure, phone-initiated command channel so Habitat can receive a small set of approved tasks from an authenticated Ax client and return results. The phone polls outbound over HTTPS; no inbound phone port, public tunnel, root access, or unrestricted shell is required.

## Current phase

This branch adds the server-side durable queue and API boundary plus an Android foreground polling agent. The Android agent supports only the read-only `device.status` command and stores the configured device bearer token encrypted with an Android Keystore AES-GCM key. It polls outbound over HTTPS every 20 seconds only while Habitat is foregrounded. This is a development integration, not a verified end-to-end connection: the backend secret still needs configuration, the Ax/MCP connector is not implemented, and a real Galaxy round trip has not been tested.

## Security model

- Separate server-side credentials: `HABITAT_AX_BRIDGE_TOKEN` for the trusted Ax/MCP caller and `HABITAT_DEVICE_BRIDGE_TOKEN` for the paired Android app.
- Credentials are environment secrets only; never commit them, print them, or embed them in the APK.
- HTTPS only. Phone polls outbound; no open port on Android.
- Commands are allowlisted. Arbitrary shell, file access, app interaction, accessibility gestures, purchases, messages, and publishing are excluded.
- Every command is scoped to one registered device, expires after five minutes, and records a structured result.
- D1 is mandatory for command storage. If D1 is unavailable, the bridge fails closed instead of silently using process memory.
- Public publishing, purchases, destructive changes, and permission changes remain user-approval gated.

## API

Ax/MCP side (Ax bearer token):
- `POST /ax/device/commands` — enqueue an allowlisted command for a device.
- `GET /ax/device/commands/:id` — read its status and result.

Android side (device bearer token):
- `GET /device/commands/next?deviceId=...` — atomically claim one pending command.
- `POST /device/commands/:id/result` — return a bounded structured result.

## Remaining integration steps

1. Configure two independent high-entropy Render secrets; never reuse the AI provider key.
2. Replace the initial manually configured shared device token with one-time pairing and per-device token revocation; the current Android UI encrypts the token at rest but does not itself issue or exchange pairing codes.
3. Add read-only diagnostics beyond basic model/OS identification, then explicit user-approved app launching and accessibility actions as separate permission-gated capabilities.
4. Expose the Ax-side API through a private authenticated MCP connector. This ChatGPT conversation cannot call an arbitrary private phone URL directly; a supported connector must be connected before ChatGPT can issue bridge commands.
5. Configure backend secrets, test unauthorized requests, expiry, duplicate claims and result ownership, then verify the complete round trip on the user's Galaxy S26 Ultra before describing the feature as working.

## Verification

Run `npm test` and `npm run check`; then deploy to a staging service first. Test unauthorized requests, command allowlisting, device scoping, expiry, duplicate claims, and result ownership before production rollout.
