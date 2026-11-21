# Ax command API

The authenticated interface Ax uses to submit work to NEXUS, follow it, and read what it actually
produced. Base path: `/ax/command`. Implementation: `command-routes.mjs`,
`d1-command-task-repository.mjs`, `universal-command-engine.mjs`, `nexus-runtime.mjs`.

**Status:** implemented and covered by automated tests locally. Not exercised against a deployment
and not connected to any ChatGPT surface — see `docs/CHATGPT_INTEGRATION.md` §8.

---

## 1. Authentication

| Credential | Scope | Never allowed |
| --- | --- | --- |
| `HABITAT_AX_COMMAND_TOKEN` | every `/ax/command/*` route | `/ax/device/*`, `/nexus/runtime`, owner actions |
| `HABITAT_AX_BRIDGE_TOKEN` (existing) | unchanged: command routes **and** device routes | — |
| owner device proof (`x-owner-device-id` + `x-owner-device-token`) | approve / deny / close / cancel / retry | command submission |

```http
Authorization: Bearer <HABITAT_AX_COMMAND_TOKEN>
```

Rules enforced in code:

- Both tokens are compared with `timingSafeEqual`, and both comparisons always run, so a caller
  cannot learn from timing which credential matched.
- An empty or unset credential never matches. With neither token configured the whole command API
  answers `503 command_auth_unconfigured` — it fails closed, never open.
- The command token is a **different secret** from the bridge token. Rotating it does not touch
  device pairing; a leaked command token cannot unpair, revoke or command a device.
- Ax can *request* an owner approval and can never *satisfy* one. A request carrying the command
  token is refused with `403 command_token_cannot_approve` before any device check, even if owner
  device headers are present.
- The token is never written into a task record, a log line, a response or the OpenAPI document.

## 2. Envelope

Every `/ax/command` response — success, validation failure, auth failure, storage failure — carries:

```json
{ "schemaVersion": 1, "ok": true }
```

Errors add `code` and `error`:

```json
{ "schemaVersion": 1, "ok": false, "code": "invalid_token", "error": "Ax command authentication required." }
```

A client must refuse `schemaVersion` values it does not know instead of guessing. `GET
/ax/command/openapi.json` is the one exception: it is the schema itself and stays a valid document.

## 3. Endpoints

### `POST /ax/command/tasks` — submit

```json
{ "objective": "report runtime health", "role": "ax", "adapter": "runtime.health",
  "idempotencyKey": "ax-2026-11-21-0001" }
```

- `objective` — required, non-empty, ≤ 2000 characters.
- `role` — `ax` (default) | `atlas` | `orion` | `sentinel`.
- `adapter` — optional. Only read-only adapters are registrable; a task naming no adapter waits for
  a human and is reported as `blocked`, never executed with a guess.
- `idempotencyKey` — **use one per objective**. Repeating it returns the original task instead of
  creating a second one.

`201` for a new task, `200` with `replayed: true` for a repeat:

```json
{ "schemaVersion": 1, "ok": true, "task": { "id": "cmd_…", "status": "queued",
  "objective": "…", "adapter": "runtime.health", "attempts": 0, "createdAt": "…", "updatedAt": "…" } }
```

Submission returns **immediately**. It is not an execution and does not mean the work succeeded.

### `GET /ax/command/tasks/:id` — status and result

```json
{ "schemaVersion": 1, "ok": true, "task": {
    "id": "cmd_…", "status": "done", "attempts": 1,
    "result": { "summary": "…", "evidence": ["runtime: …"], "verifiedBy": "nexus-1a2b3c4d" },
    "statusHistory": [ { "from": null, "to": "queued", "at": "…", "by": "ax", "reason": null } ],
    "error": null } }
```

`result.evidence` is produced by the adapter that ran, not by the caller. `verifiedBy` is the worker
id that completed the task. `404 not_found` for an unknown id.

### `GET /ax/command/tasks` — list

`?status=queued|working|needs_approval|done|failed|cancelled&limit=1..200` (default 50), newest
first. Intended for dashboards, not for following progress — use the feed for that.

### `GET /ax/command/events` — change feed

`?since=<ISO-8601>&afterId=<taskId>&limit=1..200`

```json
{ "schemaVersion": 1, "ok": true,
  "events": [ { "seq": "2026-11-21T00:00:00.000Z|cmd_…", "at": "…", "taskId": "cmd_…",
                "type": "task.completed", "status": "done", "objective": "…",
                "requiresApproval": false,
                "changes": [ { "from": "working", "to": "done", "at": "…", "by": "nexus-…", "reason": "completed with evidence" } ],
                "resultSummary": "…", "error": null } ],
  "nextSince": "…", "nextAfterId": "cmd_…", "hasMore": false }
```

- The cursor is the pair `(updated_at, id)`, so two tasks written in the same millisecond are neither
  skipped nor repeated: pass back **both** `nextSince` and `nextAfterId`.
- Rows are ordered oldest first; `limit` counts changed **tasks**, not events.
- `changes` holds the transitions that happened at or after `since` (last 20).
- An empty or absent `since` starts at the beginning of time.
- Types: `task.queued`, `task.working`, `task.approval_required`, `task.completed`, `task.failed`,
  `task.cancelled`.
- The feed is derived from the task rows themselves — there is no second event table, so it cannot
  disagree with `GET /tasks/:id`. It reports the current state of everything that changed; the full
  sequence of an individual task is in its `statusHistory`.

### `GET /ax/command/presence` — is NEXUS available?

```json
{ "schemaVersion": 1, "ok": true, "presence": {
    "reachable": true,
    "executor": { "configured": true, "started": true, "state": "running" },
    "heartbeat": { "verified": true, "liveWorkers": 1, "asleep": false, "lastHeartbeatAgeSeconds": 3 },
    "queue": { "ok": true, "eligible": 0, "blocked": 0, "stale": false, "staleAfterSeconds": 600 },
    "canExecute": true,
    "willExecuteWithoutScheduler": true,
    "staleQueue": false, "heartbeatSeconds": 30, "observedAt": "…" } }
```

Read it honestly:

| Observation | Meaning |
| --- | --- |
| `canExecute: true` | a fresh heartbeat exists: something is actually running |
| `canExecute: false`, `executor.state: "mounted_not_started"` | mounted but not polling |
| `heartbeat.asleep: true` | no fresh heartbeat: **nothing is executing** |
| `executor.state: "not_mounted"` + `reason` | no executor in this process; `disabled_by_config` or `command_store_unavailable` |
| `queue.ok: false` | the queue could not be read — not a healthy signal |
| `staleQueue: true` | eligible work is waiting past the deadline; execution works but throughput does not |

`willExecuteWithoutScheduler` is true only for the in-process timer. A cron executor is healthy with
it false, which is why `canExecute` is based on the heartbeat, not on `started`.

Presence answers **without** requiring storage to be ready, so it still returns when D1 is down.

### `GET /ax/command/tools` and `/ax/command/roles`

Read-only descriptions of the adapters a task may name and the roles that may own tasks. No storage.

### `GET /ax/command/openapi.json`

Public, unauthenticated OpenAPI 3.1 document describing the endpoints above. It contains shapes only,
no credential. Served publicly because ChatGPT imports it before any credential exists in a
conversation.

## 4. Errors

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_objective`, `invalid_role`, `invalid_since` | bad input; nothing was written |
| 401 | `invalid_token`, `owner_required`, `owner_invalid` | missing or wrong credential |
| 403 | `command_token_cannot_approve`, `not_owner` | authenticated but not permitted |
| 404 | `not_found` | unknown task id |
| 409 | `task_owned_by_worker`, `invalid_transition`, `approval_pending` | state conflict |
| 503 | `command_auth_unconfigured`, `command_store_unavailable`, `events_unavailable`, `owner_unconfigured` | the service cannot serve this yet |
| 502 | — | the engine or storage failed while handling the request |

## 5. A complete local round trip

`tests/ax-command-bridge.test.mjs` performs, in one process, with SQLite behind the D1 HTTP shape:

```
command token → POST /ax/command/tasks → queued row
              → runTick() claims and executes the runtime.health adapter
              → GET /ax/command/tasks/:id → status done, result.evidence ["runtime: …"],
                                             verifiedBy "nexus-…"
              → GET /ax/command/events → task.completed with the same id
```

Twelve tests cover: valid auth, missing/invalid/unconfigured auth, submission, idempotent
acknowledgment, progress, result and evidence, cursor pagination with a same-millisecond tie,
`task.approval_required` events, presence (live, absent, failing), owner-approval refusal for the
command token, device-route refusal for the command token, and the public OpenAPI document.

That is a real local round trip through production code paths. It is **not** a ChatGPT connection
and proves nothing about a deployment, a live D1 database, or the network path from OpenAI.
