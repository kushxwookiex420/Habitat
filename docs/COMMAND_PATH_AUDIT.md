# Command path audit — phone ↔ Habitat ↔ Ax ↔ Nexus

Date: 2026-11-24. Target: staging `habitat-staging-e3ie.onrender.com`, serving `efcf65c`.
Production was not contacted beyond a read-only health check.

The requested round trip is two different paths with different gaps, and conflating them is what makes
"the command path is broken" unfalsifiable. They are audited separately.

```
Path 1 (phone control, no Nexus needed)
  phone ──poll──▶ GET  /device/commands/next          (per-device token, D1)
        ◀──cmd──  POST /ax/device/commands            (HABITAT_AX_BRIDGE_TOKEN)
        ──result─▶ POST /device/commands/:id/result   (per-device token)

Path 2 (Ax objective → Nexus execution)
  Ax ──▶ POST /ax/command/tasks (bridge or gateway token)
      ──▶ habitat_command_tasks (queued)
      ──▶ Nexus worker claims it (needs NEXUS_RUNTIME_ENABLED=true)
      ──▶ read-only adapter ──▶ evidence ──▶ done | failed (+ escalation message)
```

## Stage-by-stage

| Stage | Code / endpoint | Live evidence | Status |
| --- | --- | --- | --- |
| Phone holds a credential | Keystore-encrypted token, `AndroidDeviceBridge` | paired row persisted; check-ins at `05:23:38Z` and `05:39:24Z` | **verified** |
| Phone authenticates | `requireDevice` → `verifyDeviceToken` (D1) | `401` without a token; check-in timestamps advance only with one | **verified** |
| Phone stays reachable | 5 s poll in `HabitatBridgeService`, 15-min `JobScheduler` fallback | `components.device.state: paired_offline`, `lastSeenAt: 05:39:24Z` at `06:24Z` | **degraded** |
| Queue a phone command | `POST /ax/device/commands` | `401 Ax bridge authentication required.` from outside; server reports `axBridgeTokenConfigured: true` | **blocked (credential)** |
| Phone claims it | `GET /device/commands/next` (atomic `claimNext`) | never exercised: no command has been queued | **not exercised** |
| Phone executes | `device.status/screen/screenshot/tap/swipe/type/key` | code + validation only; taps and typing demand `approved: true` per command | **not exercised** |
| Result returns | `POST /device/commands/:id/result` | never exercised | **not exercised** |
| Ax submits an objective | `POST /ax/command/tasks` | `401` without a token; route mounted (`axCommand: true`) | **blocked (credential)** |
| Nexus executes it | `createNexusWorker` | `components.workers.execution: {configured:false, canExecute:false, detail:"Executor not mounted (disabled_by_config); queued command objectives will not run."}` | **blocked (config)** |
| Failure reaches Ax | new `escalate` hook → message channel | implemented and unit-tested this cycle; not yet exercised live | **implemented, not live** |

## The exact missing pieces

1. **Caller credential for the device path.** `HABITAT_AX_BRIDGE_TOKEN` is configured *on the server*
   (it is what `requireAx` compares against), but the caller must send the same value. It lives only in
   Render's environment; nothing in this workspace holds it. That single value is what separates
   "audited" from "round trip proven" for path 1.
2. **Nexus is not mounted.** `NEXUS_RUNTIME_ENABLED` is present but false, so path 2 can accept a task
   into `habitat_command_tasks` and nothing will ever claim it. This is deliberate and should stay that
   way until path 1 is proven, the approval gate is re-verified, and a rollback is documented.
3. **Free-tier sleep breaks phone reachability.** The status request at `06:2x` timed out; the next
   attempt cold-started the instance and returned `200`. A sleeping instance cannot answer a phone poll
   inside the APK's 12-second connect timeout, and the 15-minute job then defers. Any latency claim made
   on a free instance is unfounded — production needs a paid always-on instance, or an external
   keep-alive, before "live heartbeat" means anything.
4. **Battery optimisation.** Observed earlier: one background check-in at `05:39:24Z`, then none through
   `05:55:29Z`. The owner should set the Bridge app to *Unrestricted*.

## Authenticated probe results (2026-11-24T06:35Z)

Run from CI with the repository credential, so the value was never seen or printed. The script reports
only HTTP statuses.

| Surface | Credential variable it reads | Status |
| --- | --- | --- |
| `GET /ax/command/diagnostics` | `HABITAT_AX_BRIDGE_TOKEN` **or** `HABITAT_AX_COMMAND_TOKEN` | `401` |
| `GET /ax/command/tasks` | same | `401` |
| `GET /ax/device/devices` | `HABITAT_AX_BRIDGE_TOKEN` only | `401` |
| `GET /health` (unauthenticated) | — | `200` |

`HABITAT_AX_COMMAND_TOKEN` (repository secret) therefore authenticates **nothing** on staging: not the
command surface, which would also accept it, and not the device surface. Two consistent explanations
remain, and both are the owner's to settle: the stored value is production's, or staging's bridge token
was set to a different value. The code is not the variable: `device-command-bridge.mjs` reads exactly
`HABITAT_AX_BRIDGE_TOKEN`, and `command-auth.mjs` accepts that or `HABITAT_AX_COMMAND_TOKEN`.

**Minimum owner action, no secret in chat:** choose one value in Render → `habitat-staging-e3ie` →
Environment → `HABITAT_AX_BRIDGE_TOKEN`, then set GitHub → Settings → Secrets and variables → Actions →
`HABITAT_AX_COMMAND_TOKEN` to the same value. Restart the service and run the `Staging round trip`
workflow. Nothing else is required: the probe then queues `device.status` and reports the result.

## D1 credential reconciliation

Two different credentials share one name, which is why "D1 is broken" and "D1 works" were both reported:

| Consumer | Credential | Result |
| --- | --- | --- |
| Staging service (`/system/status`, device rows) | `HABITAT_D1_API_TOKEN` in Render env | working: `storage.state: ready`, durable, device check-ins persisted |
| CI audit / acceptance workflows | `HABITAT_D1_API_TOKEN` repository secret | rejected: `HTTP 401 (10000:Authentication error)` at `05:40Z`, though it worked at `04:08Z` |

The token is never printed in either place; only Cloudflare's own error code is.

**Diagnosed, not guessed (2026-11-24T06:35Z).** Cloudflare uses code `10000` for both a rejected
credential and a healthy token, so the audit now asks two questions instead of one:

| Probe | Result | Reading |
| --- | --- | --- |
| `GET /user/tokens/verify` | `401`, `1000:Invalid API Token` | the credential is invalid, not under-scoped |
| `GET /accounts/{id}/d1/database/{db}` | `401`, `10000:Authentication error` | the D1 route refuses the same credential |

The verify endpoint is decisive: an under-scoped token still verifies as `active`. This one does not
verify at all, so it was revoked or expired. The secret's last update was `2026-11-21T07:06Z`, before the
successful `04:08Z` run, so nothing in the repository changed it — the change happened on Cloudflare's
side.

**Minimum owner action:** Cloudflare dashboard → My Profile → API Tokens → create or rotate a token with
Account → D1 → Edit, scoped to the staging account; then GitHub → Settings → Secrets and variables →
Actions → `HABITAT_D1_API_TOKEN` → Update. The Render staging credential does not need to change.

## Credential presence (booleans only, from the live status payload)

| Name | Present |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | true |
| `HABITAT_D1_DATABASE_ID` | true |
| `HABITAT_D1_API_TOKEN` | true |
| `HABITAT_AX_BRIDGE_TOKEN` | true |
| `HABITAT_MCP_SECRET_KEY` | true (secret encryption active, key id `mcp-1`) |
| `HABITAT_OWNER_ATTESTATION_KEY` | true (verifier active, key id `owner-1`) |
| `HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH` | false (not needed; pairing ran through the console code) |
| `HABITAT_OWNER_DEVICE_ID` | false (only needed for owner-approved device writes) |
| Model provider keys | false |

## What proving path 1 requires

With the Ax bridge token in `$AX` and the paired device id from `/ax/device/devices`:

```bash
curl -sS -X POST -H "Authorization: Bearer $AX" -H "Content-Type: application/json" \
  -d '{"deviceId":"<id>","type":"device.status","payload":{}}' \
  https://habitat-staging-e3ie.onrender.com/ax/device/commands
# then, with the returned command id:
curl -sS -H "Authorization: Bearer $AX" \
  https://habitat-staging-e3ie.onrender.com/ax/device/commands/<id>
```

Acceptance: `status: completed`, `result.ok: true`, `result.details.model` matches the phone, inside one
claim window. On the current APK the claim can take up to 15 minutes when the app is closed, and longer if
the instance is asleep.
