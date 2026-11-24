# Habitat — Final Completion Checklist

Status as of Mission 21 (`39a0315`, after Mission 20 `e47f54f`). This is the stop-expanding-scope
checkpoint: finish live validation, then sell one measurable outcome. Items marked **OWNER** require
credentials, authorization, a physical device or a deployment this environment does not have.

## A. What is complete in code

- [x] Missions 17–21 implemented on `ax-nexus/revision-4.6-nexus-mainline-integration`; PR #93 remains
      open and is not merged.
- [x] Durable D1 compare-and-swap cost ledger (migration `0007_ax_cost_ledger.sql`), with a
      process-local fallback that reports `durable: false`.
- [x] Pinned-IP HTTPS research transport with hostname SNI/certificate verification and redirect
      revalidation, selected by default when web research is enabled.
- [x] Approval-gated engineering sandbox: copied workspace, independent approval verifier, path and
      byte limits, allowlisted checks, credential-free child environment, rollback/discard, audit
      categories, and verification that only zero-exit checks count as success.
- [x] Mission 21 tests: 8 focused tests; full suite 789 passing, 0 failing.
- [x] Local migrations: 24 checks passing (fresh, repeated, upgrade-preserving).
- [x] CI: six workflows successful on `39a0315` (Habitat CI, Build Test, D1 Repository Tests, release
      checks, NEXUS Sandbox Security, Product Demo Safety).
- [x] Documentation: `docs/NEXUS_MISSION_21.md` (design, evidence, limits, rollback).

## B. Live validation (in order)

1. **Apply the schema — OWNER**
   - [ ] Apply migrations `0005`, `0006` (if not already live) and `0007_ax_cost_ledger.sql` to the
         production D1 database using the normal migration process.
   - [ ] Verify `habitat_ax_cost_ledger` and `habitat_ax_cost_ledger_updated_at` exist.
   - [ ] Do not drop or rewrite existing tables; all three migrations are additive.

2. **Confirm configuration — OWNER**
   - [ ] `HABITAT_AX_COMMAND_TOKEN`, `HABITAT_AX_BRIDGE_TOKEN`, `HABITAT_OWNER_DEVICE_IDS` present.
   - [ ] `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN` present.
   - [ ] `AX_NEXUS_TOKEN` present; scheduler token only if the external trigger is used.
   - [ ] Free-only planning: `NEXUS_MODEL_PLANNING_ENABLED=true`, `NEXUS_FREE_ONLY=true`,
         `NEXUS_MODEL` is `openrouter/free` or a `:free` model, `OPENROUTER_API_KEY` present.
   - [ ] Web research stays off until wanted: `AX_WEB_RESEARCH_ENABLED` unset or `false`.
   - [ ] Engineering sandbox stays off until an authenticated owner route exists:
         `NEXUS_SANDBOX_ENABLED` unset or `false`; if enabled, `NEXUS_SANDBOX_APPROVAL_TOKEN` is set
         only in the host secret store and `AX_AGENT_LOCAL_ROOT` points at a snapshot.

3. **Deploy — OWNER**
   - [ ] Deploy the current head (or the final docs-only head after `39a0315`) through the normal
         Render flow. This workspace has not deployed anything.
   - [ ] Record the deployed commit SHA.

4. **Verify the deployment**
   - [ ] `GET /health` returns the deployed commit and a recent `startedAt`.
   - [ ] `node scripts/verify-deployment.mjs` (or the equivalent owner run) passes against the origin.
   - [ ] `GET /ax/command/agents` reports the planner mode/model and `plannerProvider`; once D1
         credentials are live, confirm the ledger reports `durable: true` in the planner status or
         through the cost status path.
   - [ ] Signed-out command routes return 401/403; a foreign Origin is refused.

5. **Prove durable budgets — OWNER**
   - [ ] Run one real mission with the free model and confirm a reservation then settlement.
   - [ ] Restart the service.
   - [ ] Confirm the day's `spentUsd` survives and the remaining daily budget is unchanged.
   - [ ] Attempt a second mission that would cross `NEXUS_DAILY_COST_LIMIT_USD`; confirm
         `daily_budget_exceeded` and that no provider call is made.

6. **Prove research safety (only when enabled) — OWNER**
   - [ ] Enable `AX_WEB_RESEARCH_ENABLED=true`; leave `AX_WEB_RESEARCH_PINNED` at its default.
   - [ ] Run one research objective and confirm each source has URL, retrieval time and confidence.
   - [ ] Confirm a private/loopback URL and a redirect to one are refused.

7. **Prove the engineering sandbox (only after its route exists) — OWNER**
   - [ ] Add an authenticated owner-only route that requires the approval token; do not expose the
         token to the model or to logs.
   - [ ] Submit a one-file change without approval; confirm refusal and an unchanged checkout.
   - [ ] Approve the same change; confirm the diff and a zero-exit check, then rollback/discard.
   - [ ] Confirm the deployed checkout was never written.

## C. Revenue path — the next objective

- [ ] Choose one paid offer with a concrete outcome and price; write it in one paragraph.
- [ ] Put a payment link in front of it (no new platform work).
- [ ] Sell it once to a real customer; deliver with the current system plus owner effort.
- [ ] Measure: time to delivery, cost per delivery, gross margin, and whether the customer asks again.
- [ ] Only then decide whether to automate that specific delivery path. Do not expand features
      without a paying signal.

## D. Known blockers and honest limitations

- No deployment, staging D1 write, live model call, or paid provider was used in Mission 21.
- Migration `0007` and the D1 ledger are proven against SQLite only; live D1 behavior and a live
  restart are unverified.
- The sandbox is not remotely reachable: no authenticated approval route exists yet, and it is
  filesystem-copy isolation, not VM/container isolation.
- Pinned fetch is verified at the request-option level, not against a live remote host.
- Android is compile-verified only; no emulator or physical S26 Ultra run was performed. The release
  gate therefore reports `releaseReady: false` when Android is skipped.
- PR #93 is a draft and must not be merged as part of this checklist.
- The daily ledger fallback is process-local when D1 credentials are missing; do not treat that mode
  as durable.

## E. Rollback

- Application: deploy `e47f54f` (Mission 20) or the previous known-good commit.
- Schema: migration `0007` only adds a table and index; leaving it after a rollback is harmless.
- Never roll back by deleting task, objective, memory, message or cost history tables.
