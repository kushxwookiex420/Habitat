# Render staging plan

Status: **not created**. There is no Render credential in the development workspace, and creating a
service is an owner account action. Everything below is prepared so the service can be created in one
sitting; nothing here is deployed.

## What exists today

- Production service `habitat-1-szzd` serves `https://habitat-1-szzd.onrender.com`.
- Its `/health` reports commit `0d5eb6e`, `version` 0.5.0, `deviceBridge.durable=true`,
  `axTokenConfigured=true`, `nexus.configured=false`.
- `origin/main` is `4d1f2e5` and **does not contain** `0d5eb6e`, so the production service tracks a
  branch other than `main`. That value must be read from the dashboard before staging is created.

## Access still required (exact)

Either of these, and nothing more:

1. **Dashboard access** — the owner adds the operating account as a collaborator on the Render team
   with permission to create services in the workspace, or performs the two dashboard steps below.
2. **API key** — a Render API key stored as the repository secret `RENDER_API_KEY` (name only; never
   pasted in chat, never written to a file) plus the workspace id as the variable
   `RENDER_WORKSPACE_ID`, and the existing service id as `RENDER_PRODUCTION_SERVICE_ID`.

Without one of them, no staging service can be created by an agent, and the remaining deliverables
(acceptance tests against a running staging origin) stay blocked.

## Service specification

| Field | Value |
| --- | --- |
| Name | `habitat-staging` |
| Branch | `staging/integration` |
| Auto-deploy | **off** — deploy on an explicit action |
| Build | `npm ci --omit=dev` |
| Start | `node server.mjs` (not `npm start`: that script runs the syntax check on every boot) |
| Health check | `/health` |
| Plan | `starter`. Render's free instances sleep when idle, which breaks scheduler and heartbeat tests; the published starter price should be confirmed at signup. This is a **paid** service and needs owner approval. |
| Region | same as production, to keep latency comparable |

Blueprint: `deploy/render.staging.yaml`. It is deliberately not at the repository root so Render
cannot auto-apply it and it cannot redefine production.

## Environment variables (names only)

Set in the Render dashboard, never in the repository:

`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (scoped to D1), `HABITAT_AX_BRIDGE_TOKEN`,
`HABITAT_OWNER_DEVICE_ID` (optional), `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`CEREBRAS_API_KEY`.

Fixed in the blueprint: `HABITAT_ENV=staging`, `NEXUS_RUNTIME_ENABLED=false`,
`HABITAT_D1_DATABASE_ID=0fdf1ac9-65a3-4e83-8042-f3fa52282068` (the adopted staging database).

Production's database id must never appear in the staging service. The preflight refuses a staging
target equal to `HABITAT_D1_DATABASE_ID`, so a copy-paste error fails closed.

## Acceptance run, once the service exists

Run in this order and record the response bodies (no secrets in them):

1. `GET /health` → 200, `deviceBridge.ready=true`, `nexus.configured=false`.
2. `GET /system/status` → 200, `secretsExposed=false`, `redaction.policyVersion=2`, real worker
   counts, `requiredConfiguration.keys` all `configured: true` for what was set.
3. `GET /workers` → 200 with `counts` and per-worker `state`, `lastRunAt`, `capabilities`.
4. `POST /ax/command/...` with no credential → `401`, and with a wrong credential → `401`
   (`owner_invalid`), proving the gate is on.
5. One authenticated command with the staging bridge token → `202`, task id returned, replay of the
   same idempotency key returns the same task.
6. Approval: request as agent → owner decision → replay of the decision → `409 already_decided`.
7. Scheduler: one tick recorded, `approvalExpiry` provider present, no second scheduler registered.
8. D1: read back the task and the audit event through the service; confirm the staging database grew
   by one row, not the production database.
9. Recovery: restart the service, confirm the task and its audit trail survive.

## Rollback

Render keeps prior deploys: "Rollback" to the previous successful deploy, then re-run steps 1–2. No
data migration is reversed by a rollback, so a migration that ran must be recorded in
`docs/D1_STAGING_VERIFICATION.md` before the rollback.
