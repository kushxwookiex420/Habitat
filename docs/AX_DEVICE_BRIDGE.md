# AX Device Bridge — Phase 1

## Purpose

Create a secure, phone-initiated command channel so Habitat can receive a small set of approved tasks from an authenticated Ax client and return results. The phone polls outbound over HTTPS; no inbound phone port, public tunnel, root access, or unrestricted shell is required.

## Current phase

This branch adds a D1-backed command queue, one-time device pairing, per-device revocable credentials, and an Android foreground polling agent. Ax creates a high-entropy pairing code that expires after 10 minutes and can be used once. The phone exchanges it for a per-device bearer token; D1 stores only the token hash, and Android encrypts the raw token with an Android Keystore AES-GCM key. The Android agent supports only the read-only `device.status` command and polls outbound over HTTPS every 20 seconds only while Habitat is foregrounded. This remains a development integration: backend secrets/configuration, an Ax/MCP connector, and a real Galaxy round trip are still outstanding.

## Security model

- `HABITAT_AX_BRIDGE_TOKEN` authenticates the trusted Ax/MCP caller and remains server-side.
- Each paired Android device receives its own random 256-bit bearer token. D1 stores only its SHA-256 digest; Android stores the raw token encrypted with Android Keystore.
- Pairing codes are high-entropy, single-use, expire after 10 minutes, and are stored only as SHA-256 digests.
- Device revocation invalidates the device token and any outstanding pairing codes for that device.
- HTTPS only. Phone polls outbound; no open port on Android.
- Commands are allowlisted. Arbitrary shell, file access, app interaction, accessibility gestures, purchases, messages, and publishing are excluded.
- Every command is scoped to one registered device, expires after five minutes, and records a structured result.
- D1 is mandatory for command storage. If D1 is unavailable, the bridge fails closed instead of silently using process memory.
- Public publishing, purchases, destructive changes, and permission changes remain user-approval gated.

## API

Ax/MCP side (Ax bearer token):
- `POST /ax/device/pairings` with `deviceId` — issue a one-time pairing code.
- `POST /ax/device/commands` — enqueue an allowlisted command for a paired device.
- `GET /ax/device/commands/:id` — read its status and result.
- `POST /ax/device/:deviceId/revoke` — revoke one device credential and outstanding pairing codes.

Android side:
- `POST /device/pair` with `deviceId` and one-time `code` — exchange pairing code for a per-device token.
- `GET /device/commands/next?deviceId=...` with the device bearer token — claim one pending command.
- `POST /device/commands/:id/result` with the device bearer token — return a bounded structured result.

## Remaining integration steps

1. Configure the Ax bridge secret in the intended Render service without exposing it in chat; verify the existing D1 credentials and runtime deployment.
2. Implement or connect a supported authenticated Ax/MCP connector that can create pairing codes, queue commands, and poll results. This ChatGPT conversation cannot call an arbitrary private phone URL directly.
3. Add rate limiting and operational audit visibility for pairing and command routes.
4. Expand read-only diagnostics beyond model/OS identification, then add separately permission-gated and user-approved phone actions.
5. Run backend tests for pairing replay, expiry, token hashing, device scoping, revocation, command expiry, duplicate claims and result ownership; then verify a real round trip on the Galaxy S26 Ultra.

## Verification

Run `npm test` and `npm run check`; then deploy to a staging service first. Test unauthorized requests, command allowlisting, device scoping, expiry, duplicate claims, and result ownership before production rollout.
