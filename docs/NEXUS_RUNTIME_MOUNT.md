# Nexus runtime mount (Revision 3)

Status: **source integration complete and tested locally; non-production configuration hardened,
not deployed.** The Render service and live D1 run remain outstanding because no Render or
Cloudflare credentials are available to the agent. See `docs/NONPROD_ACTIVATION.md` for the
owner runbook.

## Repository identity

- Authoritative backend: `github.com/kushxwookiex420/Habitat` — flat root, base commit
  `3ec19af17a37d1eb2e14ff54bee6b3042f220b73`.
- `github.com/kushxwookiex420/home-launcher` is a **separate** Android/relay repository. It is not
  a rename and must not be used as the Habitat deploy source.
- The Ax gateway/connector live under `home-launcher` in `integrations/ax-nexus/`; the Habitat
  service uses this repository's own `render.yaml`.

## Design

`device-command-bridge.mjs` already owns the device repository and the `/ax/command` routes. The
mount adds one runtime after those routes:

```
registerUniversalCommandRoutes  ->  commandApi { engine, store }
        |                                  |
        +--> buildReadOnlyNexusAdapters ---+--> registerNexusRuntime (same store + engine)
                                                   |
                                          initialize(): store.initialize
                                                   -> heartbeat table
                                                   -> worker.start()
```

- One task store: the runtime receives `commandApi.store()` and `commandApi.engine`; it never creates
  another repository or engine.
- One device repository: `deviceRepository: store` is passed for owner-device verification.
- Three adapters only: `repo.inspect`, `task.inspect`, `runtime.health`; `repo.test` is excluded,
  and calling its factory directly still fails closed unless `enableTestAdapter:true` is passed.
- Worker gate: the runtime is mounted only when `NEXUS_RUNTIME_ENABLED=true` **and** a task store and
  an atomic D1 query exist. The flag defaults to false; an existing service does not start the worker
  merely by upgrading the code. `server.mjs` calls `initialize({startWorker:false})`, opens the HTTP
  listener, and only then starts the worker, so `/health` is never blocked by the first task tick.
- Claim gate: only tasks naming a non-empty adapter are claimable. Legacy/adapter-less queued rows
  stay queued instead of being claimed and failed; an unknown adapter is claimed only so the worker
  can fail it with an explicit "no adapter registered" error.
- Revocation: a revoked device is never revived by replaying a pairing code. Recovery is an explicit
  owner-device action (`POST /device/owner/devices/:deviceId/unrevoke`). Recovery destroys the old
  token hash and every old pairing code for the device; the device must complete a fresh pairing.
  All configured owner devices are administrators and may restore another configured owner's device;
  non-owners and revoked owner tokens are refused.
- Fail closed: no D1/store means no `/nexus/runtime` route, no worker, and command routes answer 503.
- Shutdown: the runtime attaches SIGTERM/SIGINT handlers; repeated signals are absorbed while the
  in-flight task drains (15 s default). `bridge.shutdown()` is available for embedded callers.
- Owner approvals remain device-token + owner-id checks; the Ax bridge token never approves.

## Tests

- `tests/nexus-habitat-integration.test.mjs` — 10 tests through the real bridge, routes, engine, D1
  repository code, worker, adapters, and the real SQLite engine. SQLite is reached through the
  repository's production HTTP shape (local D1 transport shim), not by replacing runtime logic.
- `tests/nexus-habitat-lifecycle.test.mjs` — child process sends two SIGTERMs during a mounted
  bridge task; one drain, one completion, exit 0.
- Full backend suite: `npm test`; exact counts are recorded in the remediation report, not in this
  document. These are not live Cloudflare D1 or Render results.

## Deployment (non-production only)

`render.yaml` targets the published branch `ax-nexus/revision-3-nonprod` and declares:

- name `ax-nexus-habitat-nonprod`, root `.`, region `oregon`, starter
- build `npm install --omit=dev --ignore-scripts`
- start `npm start` (runs the syntax check, then `server.mjs`)
- health `/health`
- required service variables: `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`,
  `HABITAT_D1_API_TOKEN`, `HABITAT_AX_BRIDGE_TOKEN`, `HABITAT_OWNER_DEVICE_ID`, and the deliberate
  activation flag `NEXUS_RUNTIME_ENABLED=true`. Without the flag the worker stays absent.

`/health` is the Render liveness check only; it returns 200 even when the optional AI provider is
not configured. Nexus readiness is `/nexus/runtime`, which requires the bridge token and must report
`workerStarted:true` plus a non-stale heartbeat. A health 200 alone is not acceptance.

A task must reach `done` with `runtime:` evidence. Stop and roll back on failure. Do not use the
production database, token, or Render service.

## Rollback

Revision 2 remains `artifacts/nexus-runtime-executor/nexus-runtime-executor.patch` in the Ax
workspace (`2fe8b27d...`), with runtime `38264497...`. To roll back a deployed service, redeploy the
previous Revision 2 commit (or the last known-good commit) rather than editing files in place. This
revision changes production/runtime files: `command-routes.mjs`, `device-command-bridge.mjs`,
`device-habitat.mjs`, `d1-command-task-repository.mjs`, `d1-content-job-repository.mjs`,
`d1-device-command-repository.mjs`, `d1-dispatch-lease-repository.mjs`, `d1-secret-vault.mjs`,
`d1-task-repository.mjs`, `nexus-adapters.mjs`, `nexus-adapter-registration.mjs`,
`nexus-runtime.mjs`, `render-sandbox-compat.mjs`, `server.mjs`, `render.yaml`, and
  `scripts/d1-live-test.mjs`, `scripts/d1-cleanup.mjs`; tests and docs change with them. Revert all of
  them together; reverting only `device-command-bridge.mjs` is not sufficient. Recovery changes in
  `device-command-bridge.mjs` and `d1-device-command-repository.mjs` must be reverted together.

## Still blocked

Live D1, Render service creation, Render sandbox probe, and a hosted worker heartbeat. No production
deployment, production credentials, or worker activation was performed. The agent environment has
no Render or Cloudflare credentials; those steps need the owner's secure dashboard access.
