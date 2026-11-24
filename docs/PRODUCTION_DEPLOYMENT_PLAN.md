# Production deployment plan — Habitat / Ax

Status: proposal. Production `Habitat-1` (`0d5eb6e4`) stays untouched until every gate below is signed
off. Staging is the only place these steps are rehearsed.

## Principle

Production is promoted *to*, never edited. Staging proves a behaviour first; the same commit is then
deployed to production with the production database and production secrets, and the same checks are run
again against the production URL. A step that has not been proved on staging is not eligible for
production.

## Gates (all must pass before promotion)

| Gate | Where it is proved | Current state |
| --- | --- | --- |
| G1 Build and tests | `npm run check`, `npm test`, `migrations:check`, `openapi:check` | Passed locally: 1,210/1,210 tests, 45/45 migrations |
| G2 Service health | `/health`, `/system/status` on staging | Passed (`efcf65c`) |
| G3 Fail-closed auth | unauth probes on every private route | Passed (§5 of the audit) |
| G4 Phone pairing persistence | check-ins across an app restart | Passed (§2 of the audit) |
| G5 Command round trip | queue → claim → result, twice, idempotent | **BLOCKED** — needs the Ax bridge token |
| G6 Real-D1 acceptance | `staging-acceptance` workflow | Last green at `04:08Z`; CI token now rejected (HTTP 401) |
| G7 Kill switch | `NEXUS_RUNTIME_ENABLED=false` keeps executor unmounted | Passed |
| G8 No unplanned spend | provider booleans, cost ledger | Passed (no provider configured) |

Promotion is blocked by G5 and G6. Both are credential actions for the owner, not code changes.

## Phase 1 — Close the staging gaps (owner, minutes)

1. Regenerate the `HABITAT_D1_API_TOKEN` repository secret (Cloudflare → My Profile → API Tokens →
   staging-scoped D1 Read/Edit). This unblocks G6 and the device audit.
2. Provide the Ax bridge credential to the operator running the verification (Render → staging service →
   Environment → `HABITAT_AX_BRIDGE_TOKEN`). It must not be pasted into chat, a commit or a log.
3. Install the APK from CI run `45334248577` (artifact `habitat-apk`) so the foreground-service fix is
   live on the phone.

## Phase 2 — Prove the command path (staging only)

Run against `https://habitat-staging-e3ie.onrender.com` with the Ax bridge token in `$AX`:

```bash
# 1. what devices does staging know about?
curl -sS -H "Authorization: Bearer $AX" \
  https://habitat-staging-e3ie.onrender.com/ax/device/devices

# 2. a read-only command needs no owner approval
curl -sS -X POST -H "Authorization: Bearer $AX" -H "Content-Type: application/json" \
  -d '{"deviceId":"<paired device id>","type":"device.status","payload":{}}' \
  https://habitat-staging-e3ie.onrender.com/ax/device/commands

# 3. read the result back with the id from step 2
curl -sS -H "Authorization: Bearer $AX" \
  https://habitat-staging-e3ie.onrender.com/ax/device/commands/<id>
```

Acceptance for G5: the command reaches `completed`, `result.ok` is `true`, and `result.details.model`
matches the phone. With the current APK the claim can take up to 15 minutes when the app is closed; with
the fixed APK it should be seconds while the app is open and prompt while it is closed. That difference
is itself the regression test for the lifecycle fix.

Then repeat with an explicit `approved: true` on `device.tap` to confirm the owner-approval gate, and once
without it to confirm `400 owner_approval_required`.

## Phase 3 — Production promotion

Preconditions: G1–G8 green, Phase 2 evidence attached, owner approval recorded.

1. **Freeze** production changes: open the production service, confirm the deploy hook is the only writer
   and note the current commit (`0d5eb6e4`).
2. **Back up** the production D1 database (`wrangler d1 export` or the Cloudflare dashboard export) and
   store it outside the repository.
3. **Deploy the staging-proven commit** to production with production env values. Do not add
   `HABITAT_ENVIRONMENT=staging` to production: that flag only exists to refuse a production database.
4. **Verify immediately:** `/health` reports the new commit, brain and device bridge ready; `/system/status`
   reports storage `ready`, gateway `enabled`, MCP events `configured`; unauth probes still 401.
5. **Re-pair only if necessary.** The production paired-device table is separate; a phone paired to
   staging holds a token that production will reject. Expect to issue one fresh pairing code.
6. **Rollback:** redeploy the previous commit in Render (or re-enable the prior instance). The D1 export
   from step 2 is the data rollback. The kill switch is `NEXUS_RUNTIME_ENABLED=false` plus
   `HABITAT_MISSIONS_ENABLED=false` and `HABITAT_WORKFORCE_ENABLED=false`, which can be set without a
   redeploy of code.

## Phase 4 — Only after production is stable

Enable, one at a time, each with its own verification and rollback:

1. `HABITAT_MISSIONS_ENABLED=true` — create one harmless mission, verify transitions and idempotency.
2. `HABITAT_WORKFORCE_ENABLED=true` — one assignment, verify it is recoverable after a restart.
3. `NEXUS_RUNTIME_ENABLED=true` — executor claims tasks; confirm the free-only cost governor stays
   engaged and the cost ledger records every call.
4. A model provider key — only then do model-backed workers leave `unavailable`.

Each flag change is its own deploy window with its own evidence. High-impact actions stay behind owner
approval; nothing in this plan removes that gate.

## Rollback contract

- Code: Render keeps the previous deploy; one click restores it.
- Data: the D1 export taken in Phase 3 step 2.
- Behaviour: the three feature flags above can be turned off without touching code.
- Credentials: revoking a phone is `POST /ax/device/:deviceId/revoke`; revoking an integration is a
  gateway token deletion. Both are server-side, not app-side.
