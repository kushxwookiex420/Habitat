# Owner checklist — staging and ChatGPT connection

Phone-friendly. **Never deploy to `habitat-1-szzd`**: it is production/shared (Android app, content
publishing, live backend). Create the separate `habitat-staging` service. Do not paste secrets into
ChatGPT, chat, commits or tickets.

## 1. Create the isolated staging service (one Blueprint)

1. Render → **New → Blueprint** → choose this repository.
2. Blueprint file: **`render.staging.yaml`** (not a root `render.yaml`).
3. Apply. This creates `habitat-staging` on the **Free** plan, branch `staging/integration`, auto-deploy
   **off**. It does not touch the existing service.
4. Render asks for four values:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `HABITAT_D1_API_TOKEN` — staging token, D1 Read + Edit only
   - `HABITAT_MCP_SECRET_KEY` — run `openssl rand -base64 32`; save it in your password manager
   - `HABITAT_OWNER_ATTESTATION_KEY` — run `openssl rand -base64 48`; needed only for approvals
5. Click **Manual Deploy** on `habitat-staging` and wait for **Live**. Free services sleep when idle.

The staging database is fixed in the Blueprint to `0fdf1ac9-65a3-4e83-8042-f3fa52282068`, which already
has migrations 0010–0016. Production `3a906029-…d502` is never present.

## 2. Verify the service (copy the new staging URL from Render)

```
curl -fsS https://<staging-host>/health
curl -fsS https://<staging-host>/system/status
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<staging-host>/mcp \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"events/list"}'
```

Expect: `/health` 200 with the `staging/integration` commit; `/system/status` 200 showing
`mcpEvents.secretEncryption.configured: true`, gateway enabled; `/mcp` **401** without a token
(404 or 503 means the wrong build/config).

Then restart the service once from Render and repeat `/health` and `/system/status`: the commit must be
the same and the service must return.

## 3. Mint the ChatGPT credential

In Render → `habitat-staging` → **Shell** (or locally with staging env), run:

```
node scripts/ax-gateway-client.mjs create \
  --label "ChatGPT staging" \
  --scopes mcp:events,status:read,missions:read,missions:write,events:write
```

Store the one-time `axg_…` token in your password manager. For approvals, mint a separate client with
`missions:approve`; do not give it to ChatGPT unless approvals are intended.

## 4. Register and subscribe in ChatGPT

1. Use an eligible ChatGPT **Work/Business/Enterprise** plugin or MCP registration surface. An ordinary
   conversation cannot be woken while inactive.
2. Add MCP server `https://<staging-host>/mcp` with **Bearer** auth and the token.
3. Rescan. Initialization must advertise `capabilities.events`; event discovery must return the catalog.
4. Subscribe to `mission.completed` from a Work chat with an HTTPS callback; complete the challenge.

## 5. Prove one harmless mission

```
curl -fsS -X POST https://<staging-host>/ax/v1/missions \
  -H "authorization: Bearer axg_…" \
  -H "idempotency-key: staging-first-mission" \
  -H "content-type: application/json" \
  -d '{"project":"habitat","objective":"Create and test a standalone hello-world app","acceptanceCriteria":["automated test passes"]}'
```

Then read the mission and status:

```
curl -fsS https://<staging-host>/ax/v1/missions/<missionId> -H "authorization: Bearer axg_…"
curl -fsS https://<staging-host>/system/status
```

Repeat the same POST with the same `idempotency-key`: it must return the same mission with
`"duplicate": true`, and no second mission or execution.

Send back: mission id, status transitions, verification evidence, webhook delivery id and the
`/system/status` response (redact tokens). Without those, the system is **UNVERIFIED**, not connected.

## 6. Security checks before declaring success

- Cloudflare token: D1 Read/Edit, staging-scoped; no account-wide or Workers/R2 permissions.
- The staging URL is not `habitat-1-szzd.onrender.com`.
- `/system/status` exposure contains no secret values.
- `HABITAT_MCP_SECRET_KEY` is backed up separately from D1; losing it requires recreating subscriptions.
- Workforce, missions and Nexus remain **off** until the mission test passes and you approve the next
  milestone.

## If something fails

- `/mcp` 503: check flags, D1 binding, gateway store and `HABITAT_MCP_SECRET_KEY`; logs use `AX_MCP_*`
  codes. Never disable encryption to get past it.
- Callback rejected: HTTPS only, no redirects/private addresses; the challenge must echo exactly.
- Token invalid: it is shown once; mint a new client and revoke the old one.
- Free instance asleep: open the URL, wait for wake, retry; this is not a deployment failure.
