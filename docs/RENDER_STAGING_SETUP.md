# Render staging isolation and setup

## Isolation finding: the existing service is production/shared

`habitat-1-szzd.onrender.com` **must not be used as staging**. Evidence in this repository:

- `AX_CONTINUITY.md` calls it the **Live backend** and records live deployments against it.
- The Android app hard-codes it as `BASE_URL`, chat, task, worker and device-heartbeat endpoint.
- Content workflows create jobs and approve/publish against it.
- `/health` reports commit `0d5eb6e` (version `0.5.0`), while this branch is `staging/integration`.
- `/system/status` is 404 there; the current integration contract is absent.
- Its database (`3a906029-…d502`) is the production id used as the isolation guard by CI.

No deployment, environment change or migration was made against it. Staging migrations were applied
only to `0fdf1ac9-…82068`, which is a different database.

## Create the separate staging service

Use `render.staging.yaml` at the repository root as a **new Blueprint** (Render → New → Blueprint).
Do not apply it to the existing service.

- Service: `habitat-staging`, Docker, **Free** plan.
- Branch: `staging/integration`; `autoDeploy: false` so deploys are deliberate.
- Health check: `/health`.
- Database id is fixed to the staging D1. Production id is never present.
- Flags: gateway, heartbeat and MCP on; workforce, missions and Nexus off.

Render prompts for the four secrets (`sync: false`):

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the account that owns the staging D1 |
| `HABITAT_D1_API_TOKEN` | staging token, D1 Read + Edit only |
| `HABITAT_MCP_SECRET_KEY` | `openssl rand -base64 32`; back up separately |
| `HABITAT_OWNER_ATTESTATION_KEY` | `openssl rand -base64 48`; only needed for approvals |

Paste secrets directly into Render's environment fields, never into ChatGPT, a chat, a commit or a
ticket.

## Token permissions

In Cloudflare → My Profile → API Tokens, the token should be:

- **D1 Read** and **D1 Edit**, restricted to the staging account/database where the UI allows it;
- no Workers Scripts, R2, account-wide or user administration permissions;
- rotated if it was ever exposed; the value is not readable from this workspace.

If the dashboard cannot scope to one database, use a dedicated staging account/token and rotate it.

## Encryption-key recovery

- Back up `HABITAT_MCP_SECRET_KEY` in a password manager **separate from D1 backups**.
- The real-D1 acceptance already proved that restarting with the same key decrypts queued subscriptions
  and that a wrong key marks deliveries `dead` rather than sending unsigned data.
- Losing the key is not recoverable from D1; subscriptions must be recreated. Do not disable encryption
  to work around a lost key.
- During rotation, keep the old key as `retired` until every subscription has been re-saved.

## After the first deploy

```
curl -fsS https://<staging-host>/health
curl -fsS https://<staging-host>/system/status
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<staging-host>/mcp \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"events/list"}'
```

Expected: health 200 with the staging commit; `/system/status` 200 with MCP encryption configured and
gateway enabled; `/mcp` 401 without a token (not 404/503). Then follow
`docs/STAGING_OWNER_CHECKLIST.md` for the token, ChatGPT registration and mission test.

Free instances sleep after idle. Wake the service before the first probe; sleeping is not a failure.
