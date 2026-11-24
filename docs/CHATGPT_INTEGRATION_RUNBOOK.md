# ChatGPT ↔ Habitat integration runbook

This is the operator checklist for the first real integration. **Nothing in it has been executed:** no
public origin, no staging D1 credentials and no ChatGPT workspace are available in the development
environment. The gateway is implemented and locally integration-tested; ChatGPT communication is **not
operational** until every acceptance step below has evidence from the real origin.

## 0. Preconditions

| Requirement | Where it comes from | Verified here? |
| --- | --- | --- |
| Staging D1 database id (not production) | owner/Cloudflare dashboard | no |
| `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN` | secret store | no |
| Public HTTPS origin with a valid certificate | hosting decision, owner approval required | no |
| ChatGPT plan/workspace that supports Actions or an MCP plugin | owner account | no |
| Owner attestation key (for approvals) | secret store, >=32 chars | no |

Production stays untouched. No paid infrastructure is created by this runbook; if the chosen HTTPS
option is paid, stop and get explicit approval first.

## 1. Owner attestation configuration (Priority 1)

Single key (simplest):

```
HABITAT_OWNER_ATTESTATION_KEY=<32+ random chars>
```

Keyring for rotation (exactly one `active`; retired keys still verify old data):

```
HABITAT_OWNER_ATTESTATION_KEYS=[{"keyId":"owner-1","secret":"<32+ chars>","status":"retired"},{"keyId":"owner-2","secret":"<32+ chars>","status":"active"}]
HABITAT_OWNER_ATTESTATION_REVOKED=owner-0
HABITAT_OWNER_ATTESTATION_ENFORCE=true
```

- Install the key, exercise signed writes and approvals in staging, **then** set `ENFORCE=true`.
- Until enforcement, supplied attestations are still verified; unsigned route-authenticated owner
  writes remain allowed and are reported as `policy: optional`.
- `/system/status` reports `ownerAuthentication: {state, verifierConfigured, enforce, activeKeyId}` and
  never the key.
- Revoking a key id makes old attestations and backup MACs signed by it fail with
  `owner_attestation_key_revoked` / `backup_mac_key_revoked`. Re-sign affected data first.
- Rotate by adding a new active key and demoting the old one to `retired`; never delete a key that
  still protects restorable backups.

Security tests already cover: unsigned/forged/expired/replayed attestations, retired-key verification,
revoked-key refusal, backup MAC/expiry/keyring, and restore into a separate database.

## 2. Staging migrations (Priority 2)

Confirm identifiers first and record them in the evidence file:

```
npx wrangler d1 info <STAGING_DB_NAME>         # read-only
npm run staging:preflight                       # read-only; expects the staging env vars
```

Order and expected objects:

| Migration | Objects | Post-check |
| --- | --- | --- |
| 0010 | workforce tables | `PRAGMA table_info`/`sqlite_master`; constraints and indexes present |
| 0011 | `habitat_ax_missions`, `habitat_ax_mission_events` | id primary key, status index, event seq index |
| 0012 | gateway clients/nonces/audit | unique token index, nonce composite key |
| 0013 | heartbeat state/events/deliveries | unique dedupe key, pending index |
| 0014 | gateway rate limits | composite primary key |

Procedure for each migration:

1. Record a D1 Time Travel bookmark or export a backup; store the identifier outside the repo.
2. Apply to staging only (wrangler `d1 execute --remote --file=migrations/00NN_*.sql`).
3. Re-run the read-only preflight and inspect `sqlite_master`.
4. Run `SELECT COUNT(*)` smoke reads on each new table (no writes from the check).
5. Restart the isolated staging service; verify `/system/status` shows schema present and all runtimes
   still disabled.
6. Apply 0014 last so rate limiting is shared if the service runs more than one instance.

Feasibility of rollback is checked locally by `npm run migrations:rollback` (26 checks). A production
rollback is not authorized.

## 3. Public HTTPS origin (Priority 3)

The gateway must be reachable over HTTPS with a certificate ChatGPT trusts. Acceptable options:

- an existing staging host that already terminates TLS (preferred; no new cost);
- a named Cloudflare Tunnel to the isolated staging service (no inbound port; domain required);
- a managed host (may be paid — **owner approval required before creation**).

Never expose the service over plain HTTP, never put the token in a URL, and keep `/admin` and control
routes unauthenticated only where they already are and carry no data.

Health check from outside:

```
curl -sS -o /dev/null -w '%{http_code}\n' https://<origin>/health
curl -sS https://<origin>/system/status | jq '.components.gateway, .components.heartbeat'
```

## 4. OpenAPI and ChatGPT integration (Priority 4)

1. Export the spec with the public origin baked in:
   `HABITAT_PUBLIC_BASE_URL=https://<origin> npm run openapi:export`
2. Verify it is current and contains no credential: `npm run openapi:check`.
3. In ChatGPT, create a GPT/Action (or MCP plugin) and import `openapi/ax-gateway.json` or point it at
   `https://<origin>/ax/v1/openapi.json`. Set authentication to **API key / Bearer**.
4. Paste the token only into the ChatGPT secret field. Never into a prompt, repo file, screenshot or the
   Android app.
5. Ask ChatGPT to call `getStatus`. A 503 `gateway_disabled` means the flag is off; 401 means the token
   is wrong/expired/revoked; 403 names the missing scope.

The spec is OpenAPI 3.1 with per-operation responses, nonce/timestamp parameters on every POST, and a
bearer security scheme. The export script performs structural validation; it is not a full third-party
schema validator, so ChatGPT's own import is the real validation step.

## 5. Credentials and revocation (Priority 5)

```
node scripts/ax-gateway-client.mjs create --label "ChatGPT" \
  --scopes status:read,missions:read,missions:write,events:write

node scripts/ax-gateway-client.mjs list
node scripts/ax-gateway-client.mjs revoke --id gw-... --reason "rotation"
```

- Tokens are shown once and stored only as SHA-256 hashes.
- Give `missions:approve` and `recovery:write` only to a separate, deliberate client; approvals still
  need an owner attestation.
- Rotate on any suspicion: mint a new client, update ChatGPT, verify, revoke the old one. Revocation is
  immediate on the next request.
- There is no HTTP route that mints credentials: compromise of a token cannot create peers.

## 6. Acceptance test (Priority 6) — the only proof that counts

Run the same sequence from ChatGPT and from the runner, with the real origin:

```
AX_GATEWAY_BASE_URL=https://<origin> AX_GATEWAY_TOKEN=<token> npm run gateway:smoke
```

The runner performs: status → submit mission (Idempotency-Key) → read accepted mission → recover →
poll detail → submit follow-up → fetch heartbeat trigger → acknowledge queued events. A local pass with
an ephemeral server is in `tests/ax-gateway.test.mjs`; it proves the HTTP path, not ChatGPT.

From ChatGPT, ask in this order and capture the raw responses:

1. "Call getStatus and summarise Habitat's components."
2. "Submit a harmless mission: objective …, acceptance criterion …."
3. "Read mission `<id>` back; report status and whether it is verified."
4. "Run bounded recovery, then read the mission again."
5. "Submit a follow-up mission that references `<id>`."
6. "Call getHeartbeat; confirm the trigger and list queued events."

Evidence to store: request ids, mission ids, timestamps, HTTP statuses, the `delivery` object for each
step, and the trigger string. A screenshot of a ChatGPT answer alone is not evidence; the audit table
(`GET /ax/v1/audit`) and mission record are.

## 7. Disconnection, queue and recovery (Priority 7)

With the heartbeat enabled (`HABITAT_HEARTBEAT_ENABLED=true`):

1. Stop calling the gateway past `staleAfterMs`; `/system/status` must report `stale`, then
   `disconnected` after missed beats — not `connected`.
2. Trigger a mission change while disconnected; confirm the queue grows and nothing is marked delivered.
3. Reconnect via `getHeartbeat`; confirm the trigger, queued events and changes since last seen.
4. Acknowledge the same ids twice; second response must be `duplicate: true` with zero acknowledged.
5. Point `AX_NOTIFY_WEBHOOK_URL` at a controlled receiver, force a delivery failure, confirm bounded
   retries then `dead`, then restore and confirm a new event delivers.
6. Restart the service and confirm state and queue survive (D1).

## 8. AX RECONNECT delivery (Priority 8)

Researched 2026-11-24:

- **GPT Actions are pull-only**; an ordinary API call cannot wake an inactive conversation.
- **Scheduled tasks** poll; Habitat cannot inject into a run.
- **MCP Events** is the supported push mechanism: ChatGPT subscribes through an MCP server
  (`events/list`, `events/subscribe`, `events/unsubscribe`) and receives signed webhooks (Standard
  Webhooks, webhook-only, one event per request, ≤256 KiB, 10s timeout, callback challenge). Work chats
  on web/desktop with Cloud.
- Built today: durable queue + exact trigger + signed webhook notifier (`AX_NOTIFY_WEBHOOK_URL`,
  `AX_NOTIFY_WEBHOOK_SECRET`) for a relay. **An MCP Events server is not implemented**, so automatic
  wake of ChatGPT remains unverified. The guaranteed path is `GET /ax/v1/heartbeat` during a turn.

Next engineering step for push: add `events/list|subscribe|unsubscribe` plus callback challenge and
per-subscription signing on top of `habitat_ax_heartbeat_events`.

## 9. Shared rate limiting (Priority 9)

With migration 0014 and one D1 database, any number of gateway instances share one fixed window per
client (`habitat_ax_gateway_rate_limits`). Without 0014 the gateway logs
`AX_GATEWAY_RATE_LIMIT_SCHEMA_MISSING` and falls back to a per-process window. Limits are a safety valve,
not billing; D1 round trips add latency to every authenticated request, which is acceptable at current
volume and measurable later.

## 10. Evidence file template

```
Starting commit:
Gateway origin:
Staging DB id (staging only):
Migrations applied + bookmarks:
Owner auth state (configured/enforced):
Client id + scopes (never the token):
Smoke runner output:
ChatGPT request ids / mission ids:
Audit sample:
Heartbeat state before/after disconnect:
Webhook delivery (if any):
CI run:
Known limitations:
```

## 11. Findings and blockers (as of this commit)

- Owner keyring/enforcement is implemented; no key is configured in any environment.
- Gateway rate limiting can now be shared, but 0014 is unapplied.
- OpenAPI is exported and structurally validated; ChatGPT import is untested.
- No public origin, no staging credentials, no ChatGPT access: acceptance is blocked on owner action.
- MCP Events push is the correct mechanism for the trigger and is not built.
- Automatic wake must not be claimed; only the pull trigger is verified (locally).
