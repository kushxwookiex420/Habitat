# OpenAI MCP Events adapter

Implementation of the supported ChatGPT event-subscription contract:
<https://developers.openai.com/plugins/build/mcp-events>. This is **MCP Events webhook integration**, not
generic MCP notifications and not `subscriptions/listen`.

**Status: implemented and locally protocol-tested. Not enabled, not deployed, and no real ChatGPT
subscription has been made.** `HABITAT_MCP_EVENTS_ENABLED` is unset and `/mcp` answers 503.

## Protocol surface

| Concern | Implementation |
| --- | --- |
| Transport | `POST /mcp`, JSON-RPC 2.0 over HTTP; notifications return 202 |
| Initialization | `initialize` negotiates `2025-03-26`, `2025-06-18` or `2026-07-28` and advertises `capabilities.events: {}` |
| MCP 2.0 discovery | `server/discover` returns `resultType: complete`, `supportedVersions: ["2026-07-28"]`, `capabilities.events` |
| Catalog | `events/list`, with `nextCursor` only when the catalog exceeds one page |
| Subscribe/refresh | `events/subscribe` verifies the callback, derives a deterministic id, grants expiry, replays from a cursor |
| Unsubscribe | `events/unsubscribe`, idempotent, returns `{}` |
| Auth | `Authorization: Bearer axg_…` gateway token with the `mcp:events` scope; the same revocation/expiry rules as the gateway |
| Errors | `-32602` invalid params/filters, `-32001` unauthorized, `-32015` `CallbackEndpointError` with `data.reason`, `-32601` unknown method |

The catalog is stable: `mission.created`, `mission.started`, `mission.completed`, `mission.failed`,
`verification.completed`, `approval.required`, `approval.resolved`, `worker.unavailable`,
`recovery.required`, `deployment.status.changed`, `security.incident`,
`business.operation.changed`, `heartbeat.reconnect`. Every definition has `delivery: ["webhook"]`, an
`inputSchema` with optional `project`, `mission_id`, `system` filters, and a `payloadSchema`.

Filters are applied on the server before delivery. Unknown filters and unknown event names are refused
rather than silently ignored.

## Subscriptions

- Identity: `sha256(principal, name, canonical arguments, callback URL)` → `sub_…`; key order cannot
  create duplicates. Creation/refresh is an upsert.
- Ownership: the principal is the authenticated gateway client id. Unsubscribe from another principal
  matches nothing, so it cannot revoke someone else's subscription.
- Lifetime: default 24h, client `ttlMs` clamped to 1 minute–7 days; `ttlMs: null` grants no expiry.
  Expired subscriptions are revoked before dispatch.
- Cursor: the first subscription starts at the current head; a supplied cursor replays matching retained
  events after it. `truncated: true` is returned if the cursor predates retained history. Delivered
  events advance the cursor only after a 2xx.
- Secret rotation: a refresh with a different `whsec_` stores the old secret as `previousSecret` for a
  5-minute grace window and signs with both (`webhook-signature` space-separated).
- Signing secrets are stored because delivery must sign; no endpoint, log line, status object or audit
  record returns them. They are not encrypted at rest — see limits.

## Callback verification

On each new principal+URL (cached 10 minutes) the server POSTs `{"type":"verification","challenge":…}`
with a unique `webhook-id`, `webhook-timestamp`, `webhook-signature` and `X-MCP-Subscription-Id`, signed
with the submitted secret. It requires a 2xx whose JSON `challenge` matches in constant time, otherwise
JSON-RPC `-32015` with `data.reason` (`challenge_failed`, `timeout`, `url_*`, `secret_invalid`).

URL rules: HTTPS required (HTTP only in the injected test harness), no userinfo, no fragment, hostname
resolved and every address checked against private/loopback/link-local ranges. 10-second timeout,
redirects rejected.

## Delivery

One signed request per event, body ≤256 KiB:

```json
{ "eventId": "evt_…", "name": "mission.completed", "timestamp": "…", "data": { … }, "cursor": 12 }
```

Headers: `Content-Type: application/json`, `webhook-id` (= eventId), `webhook-timestamp` (Unix seconds),
`webhook-signature` (`v1,<base64 HMAC>` per Standard Webhooks), `X-MCP-Subscription-Id`.

- Persistent delivery rows in `habitat_ax_mcp_deliveries`; unique `(subscription, event)` prevents
  duplicate delivery.
- 2xx → `delivered`; 410/413 → `dead` with no retry; other failures → bounded retries with exponential
  backoff (`maxAttempts` 5, from 30s) retaining the event id and minting a fresh signature each attempt.
- A restart re-reads subscriptions, events and due deliveries from D1; nothing depends on process memory.
- Revoked/expired subscriptions mark their queued deliveries `dead` (`subscription_inactive`).

## Heartbeat integration

`ingestHeartbeatEvents` maps the connection monitor's events to catalog events and `emit` enqueues them
per matching subscription. `heartbeat.reconnect` carries the exact trigger **AX RECONNECT — HABITAT
HEARTBEAT.** with health, gateway/heartbeat status, active/completed/failed missions, pending tasks,
approvals, changes, delivery status and a recommended next action. Habitat keeps beating and queueing
while ChatGPT is absent.

## Configuration

```
HABITAT_MCP_EVENTS_ENABLED=true
HABITAT_GATEWAY_ENABLED=true
CLOUDFLARE_ACCOUNT_ID=…  HABITAT_D1_DATABASE_ID=…  HABITAT_D1_API_TOKEN=…
```

Migrations required: 0012 (identities/audit), 0015 (subscriptions/events/deliveries); 0013/0014 for the
heartbeat source and shared rate limiting. Mint an MCP client with:

```
node scripts/ax-gateway-client.mjs create --label "ChatGPT MCP" --scopes mcp:events
```

Then add the plugin/MCP server URL `https://<origin>/mcp` with Bearer auth. Events appear on the plugin
page after a rescan. Event subscriptions are available in Work chats (web, desktop with Cloud) and dots;
ordinary conversations cannot be woken.

## Test evidence

`tests/ax-mcp-events.test.mjs` (19 tests): initialize/discover capability advertisement, catalog and
filters, subscribe verification and persistence, idempotent refresh, challenge failure, invalid
secret/URL, unauthorized and cross-account isolation, signed delivery with filter matching, duplicate
suppression, unsubscribe, expiry, secret rotation with both signatures, restart recovery, cursor replay,
retry exhaustion, failed-callback recovery, heartbeat mapping, HTTP auth/scope enforcement, deterministic
IDs.

## Limits / security findings

- **No real ChatGPT workspace, plugin, callback or subscription has been exercised.** Acceptance below is
  blocked on a public HTTPS origin, staging D1 and ChatGPT Work access.
- DNS is validated before connect but Node `fetch` re-resolves at connection time; an egress firewall or a
  pinned connector is still required against DNS rebinding.
- Signing secrets are plaintext in D1 (necessary for signing); protect the database and prefer an
  application-level encryption key before production.
- No OAuth dynamic client registration; plugin auth is a static Bearer token with `mcp:events`.
- One delivery executor per process; multiple replicas can race on the same due row (idempotent delivery
  prevents duplicate application effects, but add a lease before scaling).
