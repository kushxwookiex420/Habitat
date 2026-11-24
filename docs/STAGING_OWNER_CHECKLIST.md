# Owner checklist — finish staging and connect ChatGPT

Phone-friendly. Do these only on the **staging** service, never production. Do not paste secrets into
chat, commits, issues or logs.

## 1. Deploy the staging commit (Render)

1. Open Render → the `habitat-1-szzd` service → **Settings → Build & Deploy**.
2. Set the deployed branch to `staging/integration` (or deploy commit `staging/integration` head).
3. Add these environment variables (staging only):
   - `HABITAT_D1_DATABASE_ID` = `0fdf1ac9-65a3-4e83-8042-f3fa52282068`
   - `CLOUDFLARE_ACCOUNT_ID` = your account id
   - `HABITAT_D1_API_TOKEN` = staging D1 token (secret)
   - `HABITAT_GATEWAY_ENABLED` = `true`
   - `HABITAT_MCP_EVENTS_ENABLED` = `true`
   - `HABITAT_HEARTBEAT_ENABLED` = `true`
   - `HABITAT_MCP_SECRET_KEY` = output of `openssl rand -base64 32` (secret; back it up separately)
   - `HABITAT_OWNER_ATTESTATION_KEY` = output of `openssl rand -base64 48` (only if approvals are needed)
4. Leave `HABITAT_WORKFORCE_ENABLED`, `HABITAT_MISSIONS_ENABLED` and `NEXUS_RUNTIME_ENABLED` off unless
   you intend to run missions.
5. Deploy and wait for **Live**.

## 2. Verify the deployed staging service

```
curl -fsS https://habitat-1-szzd.onrender.com/health
curl -fsS https://habitat-1-szzd.onrender.com/system/status
```

Expected: health 200; `/system/status` 200; `mcpEvents.state` is not `disabled`; `gateway` enabled;
`secretEncryption.configured` true; no secret values in the response. The health `commit` must be the
staging commit, not `0d5eb6e`.

## 3. Mint the integration token

Run this where the staging D1 variables are available (Render shell or your machine). The token is shown
once — store it in a password manager, not a file in the repo.

```
node scripts/ax-gateway-client.mjs create \
  --label "ChatGPT staging" \
  --scopes mcp:events,status:read,missions:read,missions:write,events:write
```

Save the printed `axg_…` token. For approvals, mint a separate client with `missions:approve` and keep it
owner-only.

## 4. Register the MCP server in ChatGPT

1. Confirm the plugin/MCP registration UI is available on your ChatGPT plan/workspace.
2. Add MCP server URL `https://habitat-1-szzd.onrender.com/mcp` with **Bearer** auth and the token above.
3. Rescan. Initialization must advertise `capabilities.events`; event discovery must return the catalog.
4. Open a **Work** chat (background events do not wake ordinary inactive chats).
5. Subscribe to `mission.completed` (or another event) with an HTTPS callback; complete the challenge.

## 5. Prove one harmless end-to-end mission

Submit through the authenticated connection:

```
curl -fsS -X POST https://habitat-1-szzd.onrender.com/ax/v1/missions \
  -H "authorization: Bearer axg_…" -H "content-type: application/json" \
  -d '{"project":"habitat","objective":"Create and test a standalone hello-world app","acceptanceCriteria":["automated test passes"]}'
```

Then check status/detail and the audit trail:

```
curl -fsS https://habitat-1-szzd.onrender.com/ax/v1/missions/<id> -H "authorization: Bearer axg_…"
curl -fsS https://habitat-1-szzd.onrender.com/system/status
```

Send back: mission id, status transitions, the verification evidence, the webhook delivery id, and the
`/system/status` response (redact tokens). Without those, the connection stays **UNVERIFIED**.

## 6. After it works

- Add the real callback URL's domain to any egress allowlist if you use one.
- Keep the old encryption key as `retired` during rotation; never delete it until all subscriptions are
  re-created.
- Record the deployed commit and D1 bookmark in the runbook.
- Only then start the autonomy milestone (`docs/AUTONOMY_MILESTONE.md`); high-impact actions stay behind
  owner approval.

## If something fails

- `/mcp` 503: a flag, D1 binding, gateway store or encryption key is missing. Check `/system/status` and
  Render logs for `AX_MCP_*` codes; never disable encryption to work around it.
- Migrations missing: the staging DB is `0fdf…82068`; production is `3a90…d502`. Never point staging at
  production.
- Callback rejected: HTTPS only, no redirects/private addresses; the challenge must echo `challenge`.
- Token invalid: the token is shown once; mint a new client and revoke the old one.
