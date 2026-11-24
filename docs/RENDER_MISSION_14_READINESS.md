# Render readiness — Mission 14

**Evidence level: repository inspection only.** No Render dashboard, API, deployment, environment
change or health probe was performed in this mission. Nothing below is a claim that the service is
currently running this code.

Service referred to as `Habitat-1` (`https://habitat-1-szzd.onrender.com`), from the owner's earlier
mission record. Its live settings were not readable here.

## 1. What the repository guarantees

| Requirement | Repository fact |
| --- | --- |
| Runtime | `Dockerfile` → `node:22-bookworm-slim`; `engines.node >= 22.13` |
| Build | `npm install --omit=dev` in the image; `npm run check` runs before the process starts |
| Start | `npm start` = `npm run check && node server.mjs` |
| Port | `EXPOSE 8080`; the server must bind `process.env.PORT` |
| Health | `GET /health` — never asserts subsystem health; reports `deviceBridge` and `nexus` mount state |
| Readiness | `nexus.configured` / `nexus.started` are reported separately, so a sleeping worker does not make health fail |
| Storage | One D1 database named by `HABITAT_D1_DATABASE_ID`; every store uses the same endpoint builder |
| Migrations | 0001–0006 are additive and idempotent; repositories create their own tables on boot |
| Scheduler | Trigger-agnostic: an external cron, a GitHub Action or an authenticated call can tick it |

## 2. Environment variables

Required for the runtime:

| Name | Purpose | Secret |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | D1 account | no |
| `HABITAT_D1_DATABASE_ID` | the one database | no |
| `HABITAT_D1_API_TOKEN` | D1 API token (D1 Edit) | **yes** |
| `HABITAT_AX_COMMAND_TOKEN` | Ax command credential | **yes** |
| `HABITAT_AX_BRIDGE_TOKEN` | device-capable Ax credential | **yes** |
| `AX_NEXUS_TOKEN` | NEXUS surface credential (Mission 14) | **yes** |
| `HABITAT_OWNER_DEVICE_IDS` | comma-separated owner device ids | no |
| `OPENAI_API_KEY` | planner provider (only if Ax runs) | **yes** |

Optional: `AX_SCHEDULER_TOKEN` (external tick without an Ax token), `HABITAT_PUBLIC_ORIGIN`
(canonical origin in the OpenAPI document), `AX_AGENT_LOCAL_ROOT` + `AX_AGENT_LOCAL_TESTS` (local
research/engineering transports), `NEXUS_RUNTIME_ENABLED=true` (in-process worker while awake),
`AX_RUN_BUDGET_USD`, `AX_MODEL`, `AX_PROVIDER`, `AX_PROVIDER_FALLBACKS`.

Never set `STAGING_*` on the production service.

## 3. Execution topology

| Component | How it runs | Consequence |
| --- | --- | --- |
| Web service | always (Free sleeps after ~15 idle minutes) | HTTP API, control center, message channel |
| NEXUS worker | `NEXUS_RUNTIME_ENABLED=true` **or** an external cron tick | tasks execute only while awake or when ticked |
| Scheduler tick | `POST /ax/command/scheduler/tick` with `AX_SCHEDULER_TOKEN` or an Ax token | recovery + message drain + objective autonomy |
| Cron executor | **not created** | a Free web service must not be described as continuously autonomous |

A sleeping service is not autonomous. With `NEXUS_RUNTIME_ENABLED=true` alone, work is only picked
up while the instance is awake; the durable queue makes that safe, not continuous.

## 4. Deployment procedure (owner)

```sh
# 1. Pre-flight on the exact commit
npm ci
npm run check
npm test
npm run migrations:check
npm run release:gate -- --check

# 2. Build the image locally against the platform runtime
docker build -t habitat-m14 .

# 3. On Render: set the variables in §2, then deploy the commit.
#    Do not change the D1 database id to a staging value.
```

Post-deploy verification (record the JSON, do not paraphrase it):

```sh
BASE=https://<service-origin>
curl -sS "$BASE/health"
curl -sS "$BASE/ax/command/presence" -H "Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN"
curl -sS "$BASE/ax/nexus/channel"  -H "x-nexus-token: $AX_NEXUS_TOKEN"
curl -sS -X POST "$BASE/ax/command/scheduler/tick" \
  -H "Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN" \
  -H 'content-type: application/json' -d '{"trigger":"post-deploy"}'
```

Expect: `/health` `habitat: online`; presence `reachable: true` with an executor state you can
explain; channel `200` with `allowedAdapters: ["repo.inspect","task.inspect","runtime.health"]`;
tick `200` with `autonomy` present.

## 5. Rollback

1. Redeploy the previous commit. Migrations 0001–0006 are additive; no rollback migration is needed
   for the application to keep running.
2. If the new channel must be removed, stop calling its routes; the table can stay without effect.
3. Never “roll back” by dropping task, objective, memory or message tables — that deletes history.
4. Rotate `AX_NEXUS_TOKEN` independently of device pairing if it is suspected.

## 6. What remains unverified

- The live service settings, the actual Render plan, and whether a cron job exists.
- Whether the deployed commit is this one.
- Cold-start latency against the channel's rate window and any client timeout.
- D1 parity for migration 0006 (SQLite proves syntax and idempotence only).
