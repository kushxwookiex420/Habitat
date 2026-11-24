# Staging evidence — 2026-11-24

This records what was actually executed against the isolated staging service and the staging database.
Production was never deployed to or reconfigured. No token, encryption key or signing material is
reproduced here; only variable names and booleans appear.

## Verified live target

| Item | Value |
| --- | --- |
| Service | `habitat-staging-e3ie` (free plan; no purchase) |
| URL | `https://habitat-staging-e3ie.onrender.com` |
| Branch | `staging/integration` |
| Deployed commit at probe time | `7a2fab8380c315c87ce086eac2edd0c6ba98c592` (from `/health`) |
| Probe window | 2026-11-24T04:03Z – 04:07Z |
| Staging database | suffix `282068` (`0fdf1ac9-…-f3fa52282068`), proven distinct from production |
| Production | `habitat-1-szzd.onrender.com` untouched: `/health` 200 with commit `0d5eb6e4…`, `/system/status` 404 |

The first request after the free instance had been idle timed out at 25s (cold start). Every probe below
was taken against the warm process. Sleeping is not a deployment failure.

## Live probes (warm)

| Request | Result | Meaning |
| --- | --- | --- |
| `GET /health` | 200, commit `7a2fab8`, `nexus.configured: false` | process and route are live; executor is not mounted |
| `GET /system/status` | 200, `secretsExposed: false` | redacted status works on the new build |
| `POST /mcp` | 503 `mcp_events_not_configured` | fails closed; MCP was enabled but its binding/encryption was absent |
| `GET /ax/v1/missions` | 503 `gateway_not_configured` | fails closed |
| `POST /ax/v1/missions` | 503 `gateway_not_configured` | no unauthenticated mission is accepted |
| `GET /ax/command/diagnostics` | 503 `command_auth_unconfigured` | names the missing variable, prints no value |
| `GET /control` | 200 | public shell page only; data requires a token entered in the browser |

## Readiness verdict for commit `7a2fab8`

- Process, `/health`, `/system/status` and route registration are live and correct.
- Durable storage is **not initialized** (`storage.state: degraded`, adapter `process-local`).
- Gateway is **enabled but unconfigured** (`repository: false`); every request is refused.
- MCP Events is **enabled but unconfigured**; encryption key missing, so `/mcp` refuses.
- Owner attestation is **not configured**; approval-protected actions would be refused.
- Missions, workforce and Nexus are **disabled**; `/health` reports `nexus.configured: false` and
  `/ax/command/diagnostics` refuses, so the kill switch is effective live.
- No AI-provider key is set (`brain: missing_api_key`), so no paid inference can occur.

**Conclusion: the service is deployed and fails closed, but it is NOT ready for a ChatGPT mission** until
the owner supplies the four values below and redeploys.

## Environment variables actually read by the code (names only)

Verified against `server.mjs`, `ax-gateway.mjs`, `ax-mcp-events.mjs`, `ax-heartbeat.mjs`,
`ax-secret-box.mjs`, `ax-owner-attestation.mjs`, `system-status.mjs` and `staging-guard.mjs`.

| Name | Needed for | At commit `7a2fab8` |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | all D1 access | **MISSING** |
| `HABITAT_D1_DATABASE_ID` | all D1 access (must be the staging id) | present, value fixed by the blueprint |
| `HABITAT_D1_API_TOKEN` | all D1 access | **MISSING** |
| `HABITAT_GATEWAY_ENABLED` | `/ax/v1/*` | present, `true` |
| `HABITAT_MCP_EVENTS_ENABLED` | `/mcp` | present, `true` |
| `HABITAT_MCP_SECRET_KEY` (or `…_KEYS`) | AES-256-GCM for callback secrets | **MISSING** (`secretEncryption.configured: false`) |
| `HABITAT_HEARTBEAT_ENABLED` | heartbeat loop | **unverified on `7a2fab8`**: the old status could not distinguish an off flag from a missing binding |
| `HABITAT_OWNER_ATTESTATION_KEY` | approvals / owner-attested writes | **MISSING** (`ownerAuthentication.state: not_configured`) |
| `HABITAT_ENVIRONMENT=staging` | production-database guard | **not present on `7a2fab8`**; added to `render.staging.yaml` in `0cc002a` |
| `HABITAT_MISSIONS_ENABLED` | mission store | intended `false`; presence not distinguishable from the disabled report |
| `HABITAT_WORKFORCE_ENABLED` | workforce | intended `false`; same limitation |
| `NEXUS_RUNTIME_ENABLED` | command executor | present, `false` (verified via `requiredConfiguration`) |
| `NEXUS_FREE_ONLY` | executor adapter policy | missing, correct while Nexus is off |

Optional and intentionally absent: `HABITAT_AX_COMMAND_TOKEN` / `HABITAT_AX_BRIDGE_TOKEN` (legacy
`/ax/command/*` and device bridge only; the ChatGPT gateway uses revocable `axg_` tokens in D1),
`AX_NOTIFY_WEBHOOK_URL` / `AX_NOTIFY_WEBHOOK_SECRET` (legacy notifier), `AX_MCP_DELIVERY_OWNER`,
`AX_HEARTBEAT_INTERVAL_MS`, `AX_MCP_DISPATCH_INTERVAL_MS`, `HABITAT_OWNER_ATTESTATION_ENFORCE`.

Must stay absent for zero spend: `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`,
`CEREBRAS_API_KEY`, `CLOUDFLARE_API_TOKEN`, `OPENROUTER_*` alternates and
`HABITAT_ALLOW_PAID_PROVIDERS=true`.

Do not copy the production environment block: `AX_NEXUS_TOKEN` has no runtime reader in this codebase,
and production `NEXUS_*` values are not staging values. The name `AX_NEXUS_TOKEN` in an old operator
file is obsolete, not an alias.

## Code changes in this run

Commit `0cc002a` on `staging/integration`:

| File | Change |
| --- | --- |
| `staging-guard.mjs` | new: refuses the production D1 id when `HABITAT_ENVIRONMENT=staging` |
| `server.mjs` | fail-fast guard before serving; records why the heartbeat monitor could not start |
| `system-status.mjs` | heartbeat reports `enabled_unavailable` with `d1_binding_incomplete`, `schema_missing` or `storage_unavailable` instead of claiming the flag is off |
| `render.staging.yaml` | adds `HABITAT_ENVIRONMENT=staging` |
| `scripts/staging-acceptance.mjs` | adds the guard checks to the real-D1 acceptance |
| `tests/system-status.test.mjs`, `tests/staging-guard.test.mjs`, `package.json` | regressions and syntax-gate entries |

## Tests performed

| Check | Command | Result |
| --- | --- | --- |
| Syntax gate used by production startup | `npm run check` | pass, exit 0 |
| Full regression suite | `npm test` | **1,210 / 1,210 pass**, 0 fail, 0 skipped |
| Migration SQL checks | `npm run migrations:check` | **45 / 45 pass**, 0 fail (node:sqlite, D1-compatible SQL) |
| Rollback checks | `npm run migrations:rollback` | pass |
| OpenAPI contract | `npm run openapi:check` | pass |
| Local boot with staging flags and no D1 | `node server.mjs` | `/health` 200; `/system/status` reported `heartbeat.state: enabled_unavailable`, `unavailableReason: d1_binding_incomplete`; `/mcp` 503; diagnostics 503; startup log names codes only, no values |
| Staging guard process test | `node --test tests/staging-guard.test.mjs` | server exits 1 with `STAGING_GUARD_REFUSED_START` before listening; the database id is not printed |

A local boot is not proof of Render/Workers behavior, but it exercises the same `server.mjs` startup path
and configuration checks the service runs.

## Real-D1 acceptance (staging database only)

Workflow **Staging acceptance (real D1)**, run **`45324211881`**, conclusion **success**, job 1m6s.
Artifact `staging-acceptance-evidence`.

- `ok: true`, `failed: []`, `databaseIdSuffix: 282068`, `productionIdDiffers: true`.
- **21 / 21 checks passed**, 04:08:37Z – 04:08:51Z:

1. staging guard accepts the staging database
2. staging guard refuses the production database
3. gateway token issued
4. valid token resolves
5. invalid token rejected
6. missing scope rejected
7. MCP initialize advertises Events
8. Events discovery returns the catalog
9. subscription created
10. callback challenge verified
11. signed event delivered
12. delivery acknowledged
13. Standard Webhooks signature verified
14. duplicate event not requeued
15. restart recovers queued delivery
16. two concurrent dispatchers produce one callback
17. live lease blocks a second claimant, expired lease reclaimed
18. duplicate mission idempotency key creates exactly one record
19. unreadable encrypted secret fails closed (`dead`, nothing unsigned sent)
20. private callback address rejected
21. redirect rejected

Rows created by the run were cleaned up; encryption keys were generated inside the job.

## Security checks

- Unauthenticated `/mcp`, `/ax/v1/missions` and `/ax/command/*` fail closed with 503 on the live service;
  no route silently degraded to unauthenticated access.
- `/system/status` returned booleans and key names only; `secretsExposed: false`. The status tests assert
  that environment values and private task/device data never appear.
- Startup diagnostics print reason codes (`AX_MCP_SECRET_ENCRYPTION_INVALID {reason}`) without key material.
- The kill switch is verified live: `NEXUS_RUNTIME_ENABLED=false` gives `nexus.configured: false`,
  missions/workforce disabled, and the command API refuses execution.
- The production database id appears only in the isolation guard, tests and documentation — never as a
  configured staging value. The guard makes an accidental copy fail at process start.
- Production was only read (`/health`, `/system/status`); its commit and 404 status are unchanged.

## Still not proven / blockers

- **Live staging cannot reach D1 or MCP yet**: `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_API_TOKEN`,
  `HABITAT_MCP_SECRET_KEY` and `HABITAT_OWNER_ATTESTATION_KEY` are absent. Owner action required.
- Commit `0cc002a` is pushed but **not deployed**: `autoDeploy: false`, and this run has no Render
  credential or deploy hook. The live service stays at `7a2fab8` until the owner deploys manually.
- Restart persistence on the live service is **NOT TESTED**, because it has no durable storage.
- Cloudflare token permissions cannot be inspected from here; the owner must confirm D1 Read/Edit,
  staging-scoped.
- No ChatGPT MCP registration, no ChatGPT-originated subscription and no real end-to-end mission.
  Those remain **BLOCKED** on owner access and are not claimed.
