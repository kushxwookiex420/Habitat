# Nexus runtime mount (Revision 4)

Status: **source integration complete and tested locally; non-production configuration hardened,
not deployed.** The Render service and live D1 run remain outstanding because no Render or
Cloudflare credentials are available to the agent. See `docs/NONPROD_ACTIVATION.md` for the
owner runbook.

## Repository identity

- Authoritative backend: `github.com/kushxwookiex420/Habitat` — flat root. Revision 4 is based on
  the verified Revision 3 commit `662d6b5f2d1374cb0a8b9447b56ae3015036fdc2`.
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
- Device ownership: every paired device has a server-side owner record in
  `habitat_device_ownership`; pairing codes carry their issuing owner in `habitat_pairing_owners`.
  The owner is never read from a request body. The authenticated owner may recover or revoke only a
  device assigned to that same owner. Missing or ambiguous ownership fails closed.
- Revocation: a revoked device is never revived by replaying a pairing code. Recovery is an explicit
  owner-device action (`POST /device/owner/devices/:deviceId/unrevoke`) and is restricted to the
  target's recorded owner. A revoked owner cannot enroll devices, and revocation deletes every code
  the owner issued. Recovery destroys the old token hash and every old pairing code for the device;
  the device must complete a fresh pairing. The separately configured Ax bridge credential remains
  the super-admin revocation path; it is not an owner-device recovery credential.
- Owner lockout: `POST /device/break-glass/devices/:deviceId/unrevoke` requires the separate
  `HABITAT_BREAK_GLASS_TOKEN`, targets only a revoked owned device, and writes an audit record. It
  removes the revocation and old credential but never returns a token; a fresh pairing is required.
- Pairing replay: a consumed code allows one 60-second lost-response recovery, claimed with a
  conditional update. A third exchange, an expired code, or a recovery by another device fails.
- Bootstrap: a consumed bootstrap code is never reactivated by restart. The startup seed never
  clears `consumed_at` or restores a wildcard binding, and a revoked bootstrap owner is skipped.
- Console: session cookies are `HttpOnly; Secure; SameSite=Strict`; login is rate-limited by client
  address; login and state-changing routes reject cross-origin browser requests.
- Pairing: Ax/Control Center minting resolves the single configured owner server-side and refuses
  when several owners are configured. An authenticated owner may mint through
  `POST /device/owner/pairings` only for itself, a new ownerless device, or a device it already owns.
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

`render.yaml` targets the non-production branch `ax-nexus/revision-4-security-remediation` and declares:

- name `ax-nexus-habitat-nonprod`, root `.`, region `oregon`, starter
- build `npm install --omit=dev --ignore-scripts`
- start `npm start` (runs the syntax check, then `server.mjs`)
- health `/health`
- required service variables: `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`,
  `HABITAT_D1_API_TOKEN`, `HABITAT_AX_BRIDGE_TOKEN`, `HABITAT_OWNER_DEVICE_ID`,
  `HABITAT_RUNTIME_ENV=nonproduction`, and the deliberate activation flag
  `NEXUS_RUNTIME_ENABLED=true`. Without the flag the worker stays absent. `HABITAT_RUNTIME_ENV` or
  `NODE_ENV=production`, or a D1 database matching `HABITAT_PRODUCTION_D1_DATABASE_ID`, disables the
  runtime and owner enrollment even if the flag is true.

`/health` is the Render liveness check only; it returns 200 even when the optional AI provider is
not configured. Nexus readiness is `/nexus/runtime`, which requires the bridge token and must report
`workerStarted:true` plus a non-stale heartbeat. A health 200 alone is not acceptance.

A task must reach `done` with `runtime:` evidence. Stop and roll back on failure. Do not use the
production database, token, or Render service.

## Rollback

The verified rollback target is the Revision 3 commit
`662d6b5f2d1374cb0a8b9447b56ae3015036fdc2` on `ax-nexus/revision-3-nonprod` (the exact baseline
this branch was created from). The previously cited `2fe8b27d...` artifact/commit is not present in
this repository and must not be used as a deployment rollback reference.

Procedure, performed only with explicit authorization in the non-production environment:

1. Record the failed Revision 4 commit and deployment ID.
2. Build and test the Revision 3 commit locally: `npm ci`, `npm run check`, `npm test`.
3. Deploy that exact commit (or the last verified non-production commit) to a fresh non-production
   service. Do not edit files in place.
4. The Revision 4 schema is additive. Rolling back the code leaves `habitat_device_ownership`,
   `habitat_pairing_owners`, `habitat_security_audit`, and the nullable `recovery_at` column in place;
   Revision 3 ignores them. Reverting DDL is not required for a code rollback and should not drop
   ownership evidence.
5. Re-run the Revision 3 owner/pairing acceptance checks and record the `/health` and
   `/nexus/runtime` responses before declaring rollback complete.

Revision 4 changed `command-routes.mjs`, `device-command-bridge.mjs`, `device-habitat.mjs`,
`d1-command-task-repository.mjs`, `d1-content-job-repository.mjs`, `d1-device-command-repository.mjs`,
`d1-dispatch-lease-repository.mjs`, `d1-secret-vault.mjs`, `d1-task-repository.mjs`,
`nexus-adapters.mjs`, `nexus-adapter-registration.mjs`, `nexus-runtime.mjs`,
`render-sandbox-compat.mjs`, `server.mjs`, `render.yaml`, `home-bridge-client.mjs`,
`home-bridge-console.mjs`, `device-ownership-migration.mjs`, and `migrations/0003_*`; tests and docs
change with them. Revert the application changes together; reverting only
`device-command-bridge.mjs` is not sufficient.

## Still blocked

Live D1, Render service creation, Render sandbox probe, and a hosted worker heartbeat. No production
deployment, production credentials, or worker activation was performed. The agent environment has
no Render or Cloudflare credentials; those steps need the owner's secure dashboard access.
