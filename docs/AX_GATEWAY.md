# Ax ↔ Habitat gateway

An authenticated HTTP interface so ChatGPT (or any scoped integration) can read Habitat and submit
missions. It is not a chat screen and not a second orchestrator: reads are projections of the running
runtime, writes call the existing mission runtime, and approvals still require an owner attestation.

**Status: implemented and locally integration-tested. Not enabled anywhere, and no real ChatGPT
connection has been exercised.** `HABITAT_GATEWAY_ENABLED` is unset, so every route answers 503.

## Endpoints

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| GET | `/ax/v1/status` | `status:read` | identity, workforce, missions, storage, execution |
| GET | `/ax/v1/missions` | `status:read` | mission summaries (`status`, `limit`) |
| GET | `/ax/v1/missions/:id` | `missions:read` | full mission: tasks, evidence, approvals |
| POST | `/ax/v1/missions` | `missions:write` | submit a mission (202; received ≠ executed) |
| POST | `/ax/v1/missions/:id/decision` | `missions:approve` | approve/reject with owner attestation |
| POST | `/ax/v1/recover` | `recovery:write` | bounded mission recovery |
| GET | `/ax/v1/audit` | `status:read` | recent gateway requests |
| GET | `/ax/v1/heartbeat` | `status:read` | reconnect trigger + current context + queued events |
| POST | `/ax/v1/heartbeat/ack` | `events:write` | acknowledge delivered events (idempotent) |
| GET | `/ax/v1/openapi.json` | none | OpenAPI 3.1 document for ChatGPT Actions |

Every response carries `requestId` and, where relevant, `delivery: {received, executed, verified}` so a
caller cannot mistake acceptance for completion.

## Authentication

- Token format `axg_<clientId>_<secret>`; only a SHA-256 hash is stored (`habitat_ax_gateway_clients`).
- Per-client scopes, expiry and revocation, all checked on every request.
- POST requests require `x-ax-timestamp` (epoch ms, ±5 min) and `x-ax-nonce`; the nonce is inserted into
  `habitat_ax_gateway_nonces` and a duplicate is refused 409. This is a database-level replay guard, not
  a memory cache.
- `Idempotency-Key` on mission submission is passed to the mission engine, which derives the mission id
  from it; a replay returns 202 with `duplicate: true` and the original mission id.
- Rate limiting is per client and shared through D1 once migration 0014 is applied
  (`habitat_ax_gateway_rate_limits`), so replicas enforce one combined window. Without 0014 it falls back
  to an in-memory window and logs the missing schema; the limit is a safety valve, not billing.
- No anonymous fallback, no IP trust, no credential in any response.

## Permission matrix

| Scope | Read status | Read missions | Submit | Approve | Recover |
| --- | --- | --- | --- | --- | --- |
| `status:read` | ✓ | ✓ (summaries) | | | |
| `missions:read` | | ✓ (detail) | | | |
| `missions:write` | | | ✓ | | |
| `missions:approve` | | | | ✓ (owner attestation still required) | |
| `recovery:write` | | | | | ✓ |

`events:write` only permits acknowledging heartbeat events; it grants no mission, approval or recovery
ability. Heartbeat reads use `status:read`.

A typical ChatGPT client gets `status:read`, `missions:read`, `missions:write`. Approval and recovery
are separate grants and should not be given to the same conversational identity.

## Setup (including from a phone)

1. **Apply migration `0012_ax_gateway.sql` to staging only** (see the staging procedure in
   `docs/MISSION_ENGINE.md` and `docs/WORKFORCE_D1_STAGING_MIGRATION.md` for the preflight/backup steps).
2. Set the D1 variables for the staging service and `HABITAT_GATEWAY_ENABLED=true`. A missing 0012
   schema leaves the gateway refusing requests (503) rather than half-working.
3. Mint one token (prints once; never stored in plaintext):
   `node scripts/ax-gateway-client.mjs create --label "ChatGPT" --scopes status:read,missions:read,missions:write`
4. In ChatGPT, create an Action/GPT with the OpenAPI URL `https://<host>/ax/v1/openapi.json` and
   authentication "API key / Bearer". Paste the token only into ChatGPT's secret field — never into a
   prompt, a repository file or the Android app.
5. Health check: `GET /ax/v1/status`. A 503 `gateway_disabled` means the flag is off; 401 means the
   token is wrong, expired or revoked; 403 names the missing scope.
6. Revoke with `node scripts/ax-gateway-client.mjs revoke --id gw-…`; the next request fails immediately.

There is no OAuth authorization-code flow yet. ChatGPT Actions with a Bearer secret is the supported
path today; an OAuth connector is a later step. The gateway must be reachable over HTTPS at a public
origin for ChatGPT to call it; nothing here should be exposed before that is deliberate.

## Failure and recovery behaviour

| Failure | Behaviour |
| --- | --- |
| flag off / storage missing / schema missing | 503, no token check, no partial write |
| invalid/expired/revoked token | 401 with a reason code, audited |
| missing scope | 403 with `required` and `granted` scopes, audited |
| stale timestamp or replayed nonce | 400 / 409, no mission created |
| mission runtime disabled | 503 `missions_disabled` on mission routes; status stays readable |
| approval without attestation | 403; mission remains `approval_required` |
| handler throws | 500 `gateway_handler_failed`, audited, no claim of success | Heartbeat not attached | 503 `heartbeat_not_attached` on the heartbeat routes; status is unaffected |
| Gateway availability does not gate Habitat: the scheduler, workforce and missions run without any
gateway client. An unavailable gateway means no new instructions arrive, not that operations stop.

## Evidence

`tests/ax-gateway.test.mjs` (12 tests, real HTTP over an ephemeral port): disabled default, missing and
invalid tokens, least-privilege denial, credential-free status, the full submit → acknowledge → recover
→ verified-result flow, duplicate submission, replayed nonce, stale timestamp, expired and revoked
clients, per-client rate limiting, signed approval vs self-issued approval, and the OpenAPI document.

## Not verified / limitations

- No live ChatGPT request has been made from this environment; there is no public staging origin and no
  ChatGPT account access here. That end-to-end step remains open.
- No OAuth, no per-user sign-in; one token per integration client.
- Rate limiting is shared only when 0014 is applied; otherwise per process.
- No real ChatGPT import or request has been made; see `docs/CHATGPT_INTEGRATION_RUNBOOK.md`.
- The gateway can submit and inspect missions, but mission execution still needs an enabled mission
  runtime with a workforce and an executor; none is activated.
