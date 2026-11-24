# Habitat staging deployment package

Everything needed to stand up an isolated staging service for the first real ChatGPT integration.
Production is untouched, no paid resource is created, and all runtimes remain disabled until explicitly
enabled. Migrations 0010–0016 **have** been applied to staging and real-D1 acceptance passed; see
`docs/STAGING_EVIDENCE.md`. The application deployment and real ChatGPT registration are still pending —
follow `docs/STAGING_OWNER_CHECKLIST.md`.

## 1. Environment variables

### Required for the gateway + MCP path

| Name | Kind | Notes |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | config | account that owns the staging D1 database |
| `HABITAT_D1_DATABASE_ID` | config | **staging** database id; must differ from production |
| `HABITAT_D1_API_TOKEN` | secret | D1 edit token, staging only; server-side only |
| `HABITAT_GATEWAY_ENABLED=true` | flag | off by default |
| `HABITAT_MCP_EVENTS_ENABLED=true` | flag | off by default; also needs the gateway identity store |
| `HABITAT_MCP_SECRET_KEY` **or** `HABITAT_MCP_SECRET_KEYS` | secret | 32-byte key(s) for AES-256-GCM; see §3 |
| `HABITAT_HEARTBEAT_ENABLED=true` | flag | feeds mission events to MCP; optional but recommended |

### Owner attestation (approvals/deletions)

| Name | Kind | Notes |
| --- | --- | --- |
| `HABITAT_OWNER_ATTESTATION_KEY` | secret | one key ≥32 chars, or use the keyring below |
| `HABITAT_OWNER_ATTESTATION_KEYS` | secret | JSON `[{keyId,secret,status}]`, exactly one active |
| `HABITAT_OWNER_ATTESTATION_REVOKED` | config | comma-separated key ids that must never verify |
| `HABITAT_OWNER_ATTESTATION_ENFORCE` | flag | `true` only after staging proof |

### Optional

`HABITAT_WORKFORCE_ENABLED`, `HABITAT_MISSIONS_ENABLED`, `NEXUS_RUNTIME_ENABLED` remain **false** for
the first integration test. `AX_MCP_DELIVERY_OWNER` names the delivery worker; `AX_NOTIFY_WEBHOOK_URL` /
`AX_NOTIFY_WEBHOOK_SECRET` are only for the legacy relay notifier. `HABITAT_PUBLIC_BASE_URL` is used when
exporting the OpenAPI document.

## 2. D1 permissions

The token needs **D1 Read + D1 Edit** on the staging account only, scoped to the staging database if the
provider allows it. It must not have Workers Scripts, account-wide, R2 or production access. The server
reads and writes tables; it never applies DDL. Migration commands are run by the operator.

## 3. Key generation and rotation

Generate 32-byte keys as base64 (never commit them, never paste into chat):

```
openssl rand -base64 32        # key material for HABITAT_MCP_SECRET_KEY
openssl rand -base64 32        # owner attestation secret (used as a UTF-8 string)
```

Single MCP key:

```
HABITAT_MCP_SECRET_KEY=<base64 32 bytes>
```

Rotating keyring (exactly one `active`; keep the old key `retired` so existing subscriptions still
decrypt):

```
HABITAT_MCP_SECRET_KEYS=[{"keyId":"mcp-1","key":"<old base64>","status":"retired"},{"keyId":"mcp-2","key":"<new base64>","status":"active"}]
```

Procedure: add the new key as `active`, demote the old to `retired`, restart, verify deliveries, then
remove the old key **only after** all subscriptions have been re-saved or are known to be rotatable.
Revoking a key id (`status: "revoked"` or a revoked list) makes ciphertext encrypted with it undecryptable
and the corresponding delivery `dead` (`signing_secret_unreadable`). The server refuses to start MCP if
configuration is missing, weak, malformed, or has zero/multiple active keys.

**Backup requirement:** signing secrets are only recoverable with the encryption key. Back up the key
material in the owner's secret manager **separately** from the D1 backup. Losing the key means
subscriptions must be recreated; the event queue remains but cannot be signed. Rotate before a planned
key-manager change and keep at least one retired key while old subscriptions exist.

## 4. Migrations (staging only)

| Migration | Purpose | Required for |
| --- | --- | --- |
| 0010 | durable workforce | mission execution |
| 0011 | mission aggregate/events | mission engine |
| 0012 | gateway identities, nonces, audit | gateway + MCP auth |
| 0013 | heartbeat state/events/deliveries | reconnection |
| 0014 | shared gateway rate limits | multi-instance |
| 0015 | MCP subscriptions, verifications, events, deliveries | MCP Events |
| 0016 | MCP delivery leases | multi-instance delivery |

Before applying: confirm the staging database id, run `npm run staging:preflight` (read-only), record a
Time Travel bookmark or export, then apply in order with `wrangler d1 execute --remote --file=...`.
After each: check `sqlite_master`, run `npm run migrations:check` locally against a copy if available, and
restart the isolated service to confirm schema detection. 0016 must follow 0015. Do not apply any of
these to production.

## 5. Gateway and MCP credentials

```
node scripts/ax-gateway-client.mjs create --label "ChatGPT MCP" --scopes mcp:events,status:read,missions:read,missions:write,events:write
```

- The token is shown once and stored as a SHA-256 hash.
- `missions:approve` / `recovery:write` need a separate client and still require owner attestation.
- Rotate: create a new client, update ChatGPT, verify, revoke the old: `... revoke --id gw-...`.
- Revocation is immediate for both REST and `/mcp`.

## 6. MCP registration

1. Export and check the OpenAPI document: `HABITAT_PUBLIC_BASE_URL=https://<origin> npm run openapi:export && npm run openapi:check`.
2. Register `https://<origin>/mcp` as the plugin/MCP server with **Bearer** authentication.
3. A successful `initialize` advertises `capabilities.events`; `events/list` must show the catalog.
4. Subscribe from a Work chat (web/desktop Cloud) or a dot; ordinary inactive conversations cannot be
   woken.
5. Callback URLs must be public HTTPS. Habitat rejects redirects, credentials in URLs, fragments and
   private/loopback/link-local/reserved addresses, and pins the validated address for the connection.

## 7. HTTPS and health checks

Use an existing TLS terminator, a named Cloudflare Tunnel, or an approved host. Free options: existing
host/TLS, Cloudflare Tunnel with an owned domain (no paid plan required for a named tunnel at low use).
Paid options (require explicit owner approval): managed app platforms, paid tunnel plans, dedicated
compute. Do not expose plain HTTP.

```
curl -fsS https://<origin>/health
curl -fsS https://<origin>/system/status | jq '.components | {gateway, heartbeat, mcpEvents, ownerAuthentication}'
curl -fsS -X POST https://<origin>/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"events/list"}'
```

Expect the last call to be 401 without a token, 503 if MCP is disabled, and a catalog with a valid
`mcp:events` token.

## 8. Backup and restore

- D1 Time Travel bookmark before migrations; export logical backup after.
- Memory data: `exportMemory` with a signing key; keep the key outside the backup.
- Restore into a **separate** database first, re-export and compare digests, restart a process against it
  and verify `/system/status`, subscriptions and pending deliveries.
- MCP signing secrets are ciphertext in D1; restoring without `HABITAT_MCP_SECRET_*` leaves deliveries
  `dead` rather than sending unsigned data. Never disable encryption to make a restore pass.
- Owner attestation keys and MCP keys live in the secret manager, not in the database backup.

## 9. Rollback and disaster recovery

- Schema rollback is drop-only and discards data; the supported recovery is restore-from-backup or
  forward-fix. `npm run migrations:rollback` proves the drop statements locally.
- Disable flags first (`HABITAT_MCP_EVENTS_ENABLED=false`, `HABITAT_GATEWAY_ENABLED=false`) to stop new
  deliveries and requests; the queue is durable and can resume.
- Revoke the ChatGPT client, then investigate. Delivery leases expire, so a crashed worker does not
  block the queue.
- If a secret key is lost, recreate subscriptions; queued events are retained but unusable until a new
  subscription exists.

## 10. Costs

| Item | Cost |
| --- | --- |
| Existing staging host / TLS | $0 if already owned |
| Cloudflare Tunnel (named, low volume) | $0 on the free plan for the tunnel itself; domain may be paid |
| D1 staging storage/reads | within free tier at test volume; check current D1 limits |
| Managed PaaS / dedicated compute | paid — **not authorized** |
| ChatGPT Work/MCP Events | requires an eligible account/workspace; no Habitat cost |

No paid resource, purchase or deployment is performed by this package.
