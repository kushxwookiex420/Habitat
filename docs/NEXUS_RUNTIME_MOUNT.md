# Nexus runtime mount (Revision 3)

Status: **source integration complete and tested locally; not deployed.** The non-production
service and live D1 run remain outstanding.

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
- Three adapters only: `repo.inspect`, `task.inspect`, `runtime.health`; `repo.test` is excluded.
- Worker gate: the runtime is mounted only when a task store and an atomic D1 query both exist.
  `initialize()` starts it only after the device store and bootstrap setup are complete.
- Fail closed: no D1/store means no `/nexus/runtime` route, no worker, and command routes answer 503.
- Shutdown: the runtime attaches SIGTERM/SIGINT handlers; repeated signals are absorbed while the
  in-flight task drains (15 s default). `bridge.shutdown()` is available for embedded callers.
- Owner approvals remain device-token + owner-id checks; the Ax bridge token never approves.

## Tests

- `tests/nexus-habitat-integration.test.mjs` — 8 tests through the real bridge, routes, engine, D1
  repository code, worker, adapters, and the real SQLite engine. SQLite is reached through the
  repository's production HTTP shape (local D1 transport shim), not by replacing runtime logic.
- `tests/nexus-habitat-lifecycle.test.mjs` — child process sends two SIGTERMs during a mounted
  bridge task; one drain, one completion, exit 0.
- Full backend suite: `npm test` -> **383/383**.
- These are not live Cloudflare D1 or Render results.

## Deployment (non-production only)

Use `render.yaml` in this repository after replacing `REPLACE-WITH-NONPROD-BRANCH`:

- name `ax-nexus-habitat-nonprod`, root `.`, region `oregon`, starter
- build `npm install --omit=dev --ignore-scripts`
- start `npm start` (runs the syntax check, then `server.mjs`)
- health `/health`
- env: `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, `HABITAT_D1_API_TOKEN`,
  `HABITAT_AX_BRIDGE_TOKEN`, `HABITAT_OWNER_DEVICE_ID` (all secret except the IDs)

After deploy: `/nexus/runtime` with the bridge token must report `workerStarted:true` and a live
heartbeat. A task must reach `done` with `runtime:` evidence. Stop and roll back on failure.

## Rollback

Revision 2 remains `artifacts/nexus-runtime-executor/nexus-runtime-executor.patch` in the Ax
workspace (`2fe8b27d...`), with runtime `38264497...`. To roll back a deployed service, redeploy the
previous Revision 2 commit without the mount; do not edit the accepted Runtime file. This mount
changes only `device-command-bridge.mjs`, `package.json`, tests, scripts, docs and `render.yaml`.

## Still blocked

Live D1, Render service creation, Render sandbox probe, and a hosted worker heartbeat. No production
deployment, production credentials, or worker activation was performed.
