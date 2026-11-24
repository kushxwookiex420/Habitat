# Staging evidence — 2026-11-24

This records what was actually executed, not what is merely implemented. Production was never
contacted. The D1 token, encryption keys and restore bookmark are not reproduced here; they live only in
the GitHub Actions artifact/secrets.

## Render isolation finding

`habitat-1-szzd.onrender.com` is **production/shared**, not staging: `AX_CONTINUITY.md` labels it the
live backend, the Android app hard-codes it for chat/tasks/device heartbeat, content workflows publish
through it, its health reports commit `0d5eb6e` (not this branch), `/system/status` is 404 there, and its
D1 id is the production id used as CI's isolation guard. It was not deployed to or reconfigured.
A separate free `habitat-staging` Blueprint is prepared in `render.staging.yaml`.

## Target

| Item | Value |
| --- | --- |
| Branch | `staging/integration` |
| Repository | `kushxwookiex420/Habitat` |
| Staging database | `0fdf1ac9-65a3-4e83-8042-f3fa52282068` (suffix `282068`), distinct from production `3a906029-…d502` |
| Migration commit | `1301321` |
| Real-D1 acceptance commit | `6bde9bf` |

## Migrations applied

Workflow **Staging migration 0010-0016**, run `45316742674`, conclusion **success**.

- Guard: staging differs from production.
- Recoverable snapshot: D1 Time Travel bookmark taken **before** any write; value kept in the workflow
  artifact `staging-migration-evidence`.
- Applied in order: `0010_ax_workforce.sql`, `0011_ax_missions.sql`, `0012_ax_gateway.sql`,
  `0013_ax_heartbeat.sql`, `0014_ax_gateway_rate_limits.sql`, `0015_ax_mcp_events.sql`,
  `0016_ax_mcp_delivery_leases.sql`.
- Verified: `ok: true`, 0 missing tables, 0 missing indexes. Schema grew from 48 objects / 8 P1 tables to
  39 tables / 44 indexes.
- Restore path: `POST /accounts/{account_id}/d1/database/{database_id}/time_travel/restore?bookmark=…`
  using the bookmark in artifact `staging-migration-evidence` (retention 30 days).
- No migrations were applied to production.

## Real-D1 acceptance

Workflow **Staging acceptance (real D1)**, latest run `45319317670`, conclusion **success**. Start
`2026-11-24T03:25:41.249Z`, end `03:25:52.047Z`. Ephemeral encryption keys were generated in the job and
never stored. Rows created by the test were cleaned up. The earlier run `45317678889` passed 16 checks;
the latest run adds live-D1 concurrency and lease checks.

All **18** checks passed:

1. gateway token issued
2. valid token resolves
3. invalid token rejected (`gateway_token_invalid`)
4. missing scope rejected (403)
5. MCP initialize advertises Events
6. Events discovery returns the catalog
7. subscription created and callback challenge verified
8. signed event delivered
9. delivery acknowledged (D1 row `delivered`)
10. Standard Webhooks signature verified
11. duplicate event not requeued
12. restart recovers queued delivery
13. two workers dispatching concurrently against live D1 produce exactly one callback and one delivery
14. a live lease blocks a second claimant; after expiry a new claimant recovers it
15. unreadable encrypted secret fails closed (`dead`, no unsigned send)
16. private callback address rejected
17. redirect rejected
18. gateway authentication uses only stored hashes

Artifact: `staging-acceptance-evidence` (retention 30 days).

## Defect found and fixed by real-D1 execution

The D1 HTTP adapter returns `result: [{ results: [...] }]`. Gateway, MCP, heartbeat and mission
repositories were reading `rows[0]` as a row, so against real D1 a freshly minted token resolved as
invalid and schema checks saw no tables. Commit `6bde9bf` adds `createD1RowQuery`, switches those four
repositories to it, and adds `tests/d1-row-query.test.mjs`. Task/scheduler repositories intentionally
keep the raw D1 shape. The same mismatch existed in mission/workforce runtime schema checks and the D1
workforce repository; commit `99dde39` fixes those too, so missions can start against real D1.

## Mission-level idempotency

`tests/ax-gateway.test.mjs` now executes a mission, submits the same `Idempotency-Key` again, recovers
again and asserts one mission, one task set, all tasks still completed. Live D1 lease contention is
covered by the staging acceptance workflow: two workers dispatch concurrently (one callback), and a live
lease blocks a second claimant while an expired lease is reclaimed.

## Still not proven

- The Render staging URL currently serves commit `0d5eb6e` (version 2026-10-09), not `staging/integration`;
  `/system/status` is 404 there. No Render credential or deploy hook is available to this run.
- Migration 0010–0016 is applied, but the application binary using it is not deployed.
- No ChatGPT plugin registration, no ChatGPT-originated subscribe, no real callback and no real
  end-to-end mission. Those remain **BLOCKED** on owner access.
