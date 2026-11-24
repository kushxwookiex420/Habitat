# Render integration readiness — `Habitat-1`

Status: **Repository-inspected only. No Render dashboard, API or staging service was accessed.**
No production environment variable, deployment or database was changed.

## What was inspected

- `Dockerfile`: `node:22-bookworm-slim`, installs ffmpeg and fonts, `npm install --omit=dev`, copies the repository, exposes `8080`, starts `npm run check && exec node server.mjs`.
- `server.mjs`: `PORT` defaults to `8080`; `/health` reports `habitat`, `brain`, `backend`, device-bridge readiness, NEXUS configuration and public pointers. It does not probe every subsystem and does not claim a configured provider is healthy.
- `docs/CHATGPT_INTEGRATION.md`: the existing service origin is documented as `https://habitat-1-szzd.onrender.com`; Render Free sleeps after 15 minutes idle and can cold-start beyond a 45-second action timeout.
- `docs/NEXUS_CRON_DEPLOYMENT.md`: the scheduler is specified as a **separate** Render Cron Job (`node scripts/nexus-tick.mjs`, `*/5 * * * *`, $1/month minimum), not an in-process timer on the free web service.
- `command-routes.mjs`, `device-command-bridge.mjs`, `ax-scheduler.mjs`: route authentication and scheduler lease behavior.

The service name `Habitat-1` is taken from the repository documentation. Its current Render settings, health-check path, instance type, region and deployed commit were **not** read from Render and are not confirmed.

## Readiness matrix

| Area | Repository evidence | Live status |
| --- | --- | --- |
| Startup | Docker `CMD` runs syntax/repository checks, then the server; a check failure stops startup | Not deployed/verified |
| Port | `PORT` or `8080`; server binds to all interfaces | Not verified on Render |
| Health check | `/health` returns 200 with `habitat: online`, `backend: ready`; optional subsystems may be unconfigured | Not probed live |
| Readiness semantics | `/health` deliberately does not claim D1, scheduler or provider health; authenticated `/ax/command/diagnostics` does probe | Not probed live |
| D1 connectivity | D1 repositories initialize idempotently; failure is surfaced, not hidden | Not verified against staging/production |
| Required variable names | `HABITAT_AX_COMMAND_TOKEN`, `HABITAT_AX_BRIDGE_TOKEN`, `HABITAT_OWNER_DEVICE_IDS`, `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN`; optional `AX_SCHEDULER_TOKEN`, `HABITAT_PUBLIC_ORIGIN`, `AX_AGENT_LOCAL_ROOT` | Presence on Render unknown |
| Scheduler auth | Tick endpoint requires `AX_SCHEDULER_TOKEN`; owner command routes require the Ax token; device routes require per-device tokens | Locally tested only |
| Owner/device auth | Bearer credential plus owner device allowlist; phone revocation clears credentials on 401 | Locally/compile tested, no physical device |
| Background execution | `setInterval` worker inside the web process only while awake; recommended executor is a separate cron job | Not created |
| Sleep/wake | Render Free stops the web process after 15 idle minutes (repository documentation) | Not verified; no Render access |
| Scheduled work while asleep | Cannot be relied on for the free web service. A separate cron job or paid always-on service is required | Not operational |

## Honest integration verdict

- **Implemented:** startup, `/health`, D1 repository adapters, token/owner/device authorization, scheduler endpoint with lease fencing, durable command queue, cron tick script.
- **Locally tested:** startup/check path, health response shape, auth failures, D1-shaped repositories, scheduler multi-process lease, tick exit codes.
- **CI verified:** six workflows on `5f2175d`; the final Mission 13 head must be rechecked after this document is committed.
- **Staging verified:** no.
- **Production verified:** no.
- **Continuous autonomous operation:** not claimed. No cron job exists, no scheduler token is configured, no live tick has run, and the free web service can sleep.

## Required environment variable names

Never commit or paste values. Set them in Render → `Habitat-1` → Environment, or use the project secret store.

Required for the web service:

- `HABITAT_AX_COMMAND_TOKEN` — Ax API credential; distinct from the device bridge token.
- `HABITAT_AX_BRIDGE_TOKEN` — device-capable credential; can unpair/command devices.
- `HABITAT_OWNER_DEVICE_IDS` — owner allowlist.
- `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN` — D1 access.

Optional:

- `AX_SCHEDULER_TOKEN` — required by the external tick endpoint.
- `HABITAT_PUBLIC_ORIGIN` — canonical origin for generated links.
- `AX_AGENT_LOCAL_ROOT` — enables local read-only transports; leave unset otherwise.

Cron service only: `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN`, `NEXUS_RUNTIME_ENABLED=true`, `NEXUS_HEARTBEAT_SECONDS=30`, `NEXUS_RETENTION_DAYS=7`, `NEXUS_STALE_QUEUE_SECONDS=600`, `NEXUS_MAX_ATTEMPTS=3`. Do not put device or Ax bridge tokens on the cron service.

## Failure handling

- Startup fails closed if `npm run check` fails; Render will not serve a syntactically broken build.
- `/health` is a liveness/readiness summary, not a full subsystem probe. A green `/health` does not prove D1, scheduler or model-provider health.
- D1 errors surface as 5xx/`storage` errors; the control center shows a failing read rather than a fabricated healthy state.
- A tick holding an expired lease can be taken over; the stale writer receives a lease conflict. This is locally proven with four processes, not on Render.
- A cron run stopped at the 12-hour limit leaves the task lease to expire and a later tick requeues it, bounded by attempts. This is documented behavior, not live-verified.
- The web timer and the cron executor must not both be enabled. The cron service is the intended single executor.

## Staging deployment plan (not executed)

1. Create a separate Render staging web service from this branch; do not point it at production D1 or reuse `Habitat-1` secrets.
2. Provision a disposable staging D1 database and apply migrations 0001–0005. Record identity without credentials.
3. Set staging-only variable names. Use a distinct Ax token and device allowlist; do not copy production tokens.
4. Set the health-check path to `/health`; confirm a cold start finishes within the health-check timeout.
5. Verify unauthenticated command routes return 401/403; authenticated `/ax/command/diagnostics` reports actual D1/scheduler status.
6. Run the staging harness `write` and `verify` processes and the control center against staging reads.
7. Only after that, create a staging cron job with its own staging D1 variables and run it manually once. Confirm a heartbeat and one harmless queued read-only objective completes.
8. Tear down staging resources, or keep them isolated and documented. Never copy staging records into production.

## Owner actions to make Render operational

1. Decide the release branch and deploy it. This is not authorized here.
2. Set the required secrets in Render; do not send them through chat.
3. Run one authenticated diagnostics request and record only non-secret status fields.
4. Create the separate cron job if continuous work is wanted. This costs money and requires explicit owner approval.
5. If staying on Render Free, accept that autonomous work runs only when the web service is awake; do not claim continuous operation.

## Production boundary

No Render deployment, environment change, paid resource, cron job or production D1 access occurred in Mission 13. The service may be deployed and operational from earlier work, but that was not verified here and is not claimed.
