# Owner checklist — staging and ChatGPT connection

Phone-friendly. **Never deploy to `habitat-1-szzd`**: it is production/shared (Android app, content
publishing, live backend). The isolated staging service is **`habitat-staging-e3ie`**
(`https://habitat-staging-e3ie.onrender.com`). Do not paste secrets into ChatGPT, chat, commits or
tickets.

## Current state (verified 2026-11-24)

The staging service exists, runs commit `7a2fab8` and answers `/health`, `/system/status` and `/control`.
It fails closed, but it has **no database connection and no MCP encryption key**, so `/mcp` and
`/ax/v1/missions` answer 503. Four owner-supplied values are missing. Nothing below has been done by an
agent on your behalf.

## 1. Fill the missing environment values

Render → `habitat-staging-e3ie` → **Environment**. Add (or correct) these, then save:

| Variable | Value | Why |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the account that owns the staging D1 | currently missing |
| `HABITAT_D1_API_TOKEN` | staging token, D1 Read + Edit only | currently missing |
| `HABITAT_MCP_SECRET_KEY` | `openssl rand -base64 32` | currently missing; back it up separately |
| `HABITAT_OWNER_ATTESTATION_KEY` | `openssl rand -base64 48` | currently missing; only needed for approvals |
| `HABITAT_ENVIRONMENT` | `staging` | enables the production-database guard |

Also confirm these are present and unchanged:

```
HABITAT_D1_DATABASE_ID=0fdf1ac9-65a3-4e83-8042-f3fa52282068
HABITAT_GATEWAY_ENABLED=true
HABITAT_MCP_EVENTS_ENABLED=true
HABITAT_HEARTBEAT_ENABLED=true
HABITAT_WORKFORCE_ENABLED=false
HABITAT_MISSIONS_ENABLED=false
NEXUS_RUNTIME_ENABLED=false
```

If you prefer to create the service from `render.staging.yaml`, apply it as a **new Blueprint**. Render
may add a suffix to the service name; that is expected. The staging database id is fixed in the file.
Production `3a906029-…d502` is never present there.

## 2. Deploy the current branch

Render → `habitat-staging-e3ie` → **Manual Deploy** → deploy `staging/integration` at commit `0cc002a`
(or the then-current head). Auto-deploy is off on purpose. Wait for **Live**.

The guard fails the deploy on purpose if the service is marked `staging` and the database id is the
production one. That is correct behavior, not a Render outage.

## 3. Verify the service

```
curl -fsS https://habitat-staging-e3ie.onrender.com/health
curl -fsS https://habitat-staging-e3ie.onrender.com/system/status
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://habitat-staging-e3ie.onrender.com/mcp \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

Expect after the redeploy:

- `/health` 200 with the new commit and `nexus.configured: false`.
- `/system/status` 200 with `storage.state: ready`, `gateway.repository: true`,
  `mcpEvents.secretEncryption.configured: true`, and `heartbeat.state` a live connection value — not
  `enabled_unavailable`. If heartbeat says `enabled_unavailable` with `d1_binding_incomplete`, a D1 value
  above is still wrong.
- `/mcp` **401** without a token. 503 means a value above is still missing; 404 means the wrong build.

Then restart the service once from Render and repeat `/health` and `/system/status`. The commit must be
the same and the process must return; with D1 connected, stored subscriptions must still decrypt.

Free instances sleep when idle. Open the URL, wait for the wake, and retry; a cold start is not a
deployment failure.

## 4. Mint the ChatGPT credential

In Render → `habitat-staging-e3ie` → **Shell** (or locally with the staging environment), run:

```
node scripts/ax-gateway-client.mjs create \
  --label "ChatGPT staging" \
  --scopes mcp:events,status:read,missions:read,missions:write,events:write
```

Store the one-time `axg_…` token in your password manager. For approvals, mint a separate client with
`missions:approve`; do not give it to ChatGPT unless approvals are intended.

## 5. Register and subscribe in ChatGPT

1. Use an eligible ChatGPT **Work/Business/Enterprise** plugin or MCP registration surface. An ordinary
   conversation cannot be woken while inactive.
2. Add MCP server `https://habitat-staging-e3ie.onrender.com/mcp` with **Bearer** auth and the token.
3. Rescan. Initialization must advertise `capabilities.events`; event discovery must return the catalog.
4. Subscribe to `mission.completed` from a Work chat with an HTTPS callback; complete the challenge.

## 6. Prove one harmless mission

```
curl -fsS -X POST https://habitat-staging-e3ie.onrender.com/ax/v1/missions \
  -H "authorization: Bearer axg_…" \
  -H "idempotency-key: staging-first-mission" \
  -H "content-type: application/json" \
  -d '{"project":"habitat","objective":"Create and test a standalone hello-world app","acceptanceCriteria":["automated test passes"]}'
```

Then read the mission and status:

```
curl -fsS https://habitat-staging-e3ie.onrender.com/ax/v1/missions/<missionId> -H "authorization: Bearer axg_…"
curl -fsS https://habitat-staging-e3ie.onrender.com/system/status
```

Repeat the same POST with the same `idempotency-key`: it must return the same mission with
`"duplicate": true`, and no second mission or execution.

Send back: mission id, status transitions, verification evidence, webhook delivery id and the
`/system/status` response (redact tokens). Without those, the system is **UNVERIFIED**, not connected.

## 7. Security checks before declaring success

- Cloudflare token: D1 Read/Edit, staging-scoped; no account-wide or Workers/R2 permissions.
- The staging URL is not `habitat-1-szzd.onrender.com`.
- `/system/status` exposure contains no secret values.
- `HABITAT_MCP_SECRET_KEY` is backed up separately from D1; losing it requires recreating subscriptions.
- Workforce, missions and Nexus remain **off** until the mission test passes and you approve the next
  milestone.

## If something fails

- `/mcp` 503: check flags, D1 binding, gateway store and `HABITAT_MCP_SECRET_KEY`; logs use `AX_MCP_*`
  codes. Never disable encryption to get past it.
- `/system/status` `heartbeat.state: enabled_unavailable`: read `heartbeat.unavailableReason`. It says
  whether the D1 binding is incomplete, the migration is missing, or storage is unreachable.
- Deploy fails immediately with `STAGING_GUARD_REFUSED_START`: the service is marked staging but points
  at the production database. Fix `HABITAT_D1_DATABASE_ID`; do not remove the guard.
- Callback rejected: HTTPS only, no redirects/private addresses; the challenge must echo exactly.
- Token invalid: it is shown once; mint a new client and revoke the old one.
