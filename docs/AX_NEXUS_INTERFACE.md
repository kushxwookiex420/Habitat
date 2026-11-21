# Ax ↔ NEXUS interface — milestone M-2

Design for the next communication milestone, continuing the Mission 01 review. This is a design, not
an implementation, and it is **not** evidence of connectivity.

> **Status: Ax is not connected.** `/ax/command/*` exists and is authenticated, but no Ax surface has
> ever performed an authenticated round trip against the deployed service. Until the acceptance test
> in §7 passes on the real origin, every description of Ax and NEXUS talking to each other is a plan.

---

## 1. What already works (in code, tested locally)

| Direction | Endpoint | Auth | Proven by |
| --- | --- | --- | --- |
| Ax → submit | `POST /ax/command/tasks` `{objective, role, adapter, idempotencyKey}` | Ax bridge token | `tests/command-routes.test.mjs` |
| NEXUS → acknowledge | `201 {ok, task:{id,status}}`; duplicate key → `{replayed:true}` | — | same |
| Ax → progress/result | `GET /ax/command/tasks/:id`, `GET /ax/command/tasks?status=&limit=` | Ax bridge token | same |
| NEXUS → failure | `status:"failed"`, `error`, `attemptHistory` | — | engine tests |
| NEXUS → approval request | `POST …/approval` (Ax asks), `GET /device/command/approvals` (owner phone) | device proof | integration tests |
| Shared state + evidence | one `habitat_command_tasks` row; `result.summary`, `result.evidence[]` | — | integration tests |
| Execution liveness | `GET /nexus/runtime` (heartbeat + queue + stale flag) | Ax bridge token | `tests/nexus-autonomous-foundation.test.mjs` |

## 2. Gaps this milestone closes

1. **No change feed.** Ax cannot ask "what changed since I last looked" without re-reading and
   diffing up to 200 rows.
2. **One token for everything.** The chat-facing credential can also revoke devices and read
   `/nexus/runtime`. A command-scoped token separates the two.
3. **No envelope version.** Two independently deployed sides need `schemaVersion`.
4. **No presence.** NEXUS cannot say when Ax last reached it.
5. **No documented error vocabulary** for a client to branch on.
6. **No acceptance test.** This is the only item that turns the design into connectivity.

## 3. Authentication model

| Credential | Header | May call | Must not call |
| --- | --- | --- | --- |
| `HABITAT_AX_COMMAND_TOKEN` (new) | `Authorization: Bearer …` | `/ax/command/*` | `/ax/device/*`, `/nexus/runtime`, `/ax/device/:id/revoke`, `/tasks` |
| `HABITAT_AX_BRIDGE_TOKEN` (existing) | `Authorization: Bearer …` | everything it does today, including `/ax/command/*` | — |
| owner device token | `x-owner-device-token` + `x-owner-device-id` | owner actions only | everything else |

Rules: tokens never appear in a URL, a log line or an error body; comparison stays constant-time; if
both tokens are configured the command routes accept either; if the command token is absent the
behaviour is unchanged (backwards compatible).

`POST /ax/command/tasks` stays **Ax-only** — the owner device does not submit work, it approves it.

## 4. Response envelope

Every `/ax/command/*` response gains `schemaVersion: 1`. Additive only; nothing is renamed.

## 5. Change feed

`GET /ax/command/events?since=<iso>&afterId=<id>&limit=200`

Derived from the one source of truth — no second event table, so the feed cannot disagree with the
task record:

```
GET /ax/command/events
→ 200 {
    schemaVersion: 1, ok: true,
    events: [
      { seq: "<updatedAt>|<id>", at, taskId, type, status, detail }
    ],
    nextSince: "<iso>", nextAfterId: "<id>",
    hasMore: false
  }
```

- Rows are selected by `updated_at >= since`, ordered by `(updated_at, id)`, bounded by `limit`.
- `type` is one of `task.created`, `task.claimed`, `task.progress`, `task.approval_requested`,
  `task.approved`, `task.denied`, `task.completed`, `task.failed`, `task.cancelled`, derived from the
  task's own `history` entries whose timestamp is at or after `since`, plus a `task.state` event for
  the current state.
- Cursor is `(nextSince, nextAfterId)` so two tasks updated in the same millisecond cannot be skipped.
- Requires an index: `CREATE INDEX IF NOT EXISTS habitat_command_tasks_updated_at
  ON habitat_command_tasks(updated_at, id)` (additive, idempotent).
- A task older than `since` whose history is trimmed still appears if its `updated_at` moved — that is
  the correct behaviour: the feed reports change, not archaeology.

## 6. Presence and errors

`GET /ax/command/presence` → `{schemaVersion:1, ok:true, ax:{lastCallAt, lastRoute, calls24h}}`,
backed by a single-row table `habitat_ax_presence(id='ax', last_call_at, last_route, calls)` updated
by the command-route guard. Absent row → `{lastCallAt:null}`, which means "Ax has never called",
not "Ax is connected".

Error vocabulary (stable `code` values, already emitted or added here):
`invalid_objective`, `adapter_not_allowed`, `unknown_role`, `not_found`, `invalid_transition`,
`approval_pending`, `attempt_limit_reached`, `claim_required`, `stale_claim`, `fencing_unsupported`,
`owner_required`, `owner_invalid`, `owner_unconfigured`, `not_owner`, `task_owned_by_worker`,
`command_store_unavailable`.

HTTP mapping: `400` invalid input, `401` missing/invalid credential, `403` verified non-owner,
`404` unknown task, `409` state conflict, `503` not configured or storage not ready.

## 7. Acceptance test — the definition of "connected"

Run from the Ax surface with the **command** token. Never paste the token into a chat, a document or
a commit.

```sh
BASE=https://habitat-1-szzd.onrender.com
H="Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN"

# 1. liveness of the interface (no storage)
curl -sS "$BASE/ax/command/tools" -H "$H"
#    expect 200, schemaVersion:1, a tools summary

# 2. submit with an idempotency key
curl -sS -X POST "$BASE/ax/command/tasks" -H "$H" -H 'content-type: application/json' \
  -d '{"objective":"ax round trip probe","role":"ax","adapter":"runtime.health","idempotencyKey":"ax-rt-2026-11-21"}'
#    expect 201 {ok:true, task:{id, status:"queued"}}   → record <id> and <updatedAt>

# 3. the same key must not create a second task
curl -sS -X POST "$BASE/ax/command/tasks" -H "$H" -H 'content-type: application/json' \
  -d '{"objective":"ax round trip probe","role":"ax","adapter":"runtime.health","idempotencyKey":"ax-rt-2026-11-21"}'
#    expect replayed:true and the SAME id

# 4. progress, without any phone involved
curl -sS "$BASE/ax/command/tasks/<id>" -H "$H"
#    expect status queued → working → done; result.evidence contains a line starting "runtime:"

# 5. change feed
curl -sS "$BASE/ax/command/events?since=<updatedAt-from-step-2>" -H "$H"
#    expect the task's events in order, with nextSince/nextAfterId

# 6. presence
curl -sS "$BASE/ax/command/presence" -H "$H"
#    expect lastCallAt set to the most recent call above
```

Pass criteria, all required:

1. Step 2 returns a task id; step 3 replays that same id and creates nothing.
2. Step 4 reaches `done` with adapter-produced evidence and **no phone activity**.
3. Step 5 returns the task's events and a usable cursor.
4. Step 6 shows the call the server just received.
5. The command token is rejected on `/ax/device/devices` (scope separation holds).

Until all five hold, the only true statement is: *the interface exists; Ax is not connected.*

---

## 8. Implementation tasks (small, independently testable)

| ID | Task | Test |
| --- | --- | --- |
| M-2.1 | `schemaVersion: 1` on every `/ax/command` response | one route test asserting the field on all 14 routes |
| M-2.2 | `HABITAT_AX_COMMAND_TOKEN` with route-level scope separation | command token → 403 on `/ax/device/*`; bridge token still works |
| M-2.3 | `GET /ax/command/events` with `(updated_at, id)` cursor + index DDL | cursor paging test, same-millisecond tie, no duplicates |
| M-2.4 | `GET /ax/command/presence` + `habitat_ax_presence` upsert | row present after a call; `null` before any call |
| M-2.5 | Document the error vocabulary in the interface doc | table above stays accurate |
| M-2.6 | Run §7 against the deployed origin and record the JSON | manual; **owner** supplies the token to the Ax surface |

Order matters: M-2.1 and M-2.2 first (cheap, no storage), then M-2.4 (single row), then M-2.3 (needs
the index and careful paging), then M-2.6.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| A chat credential leaking into a transcript | command-scoped token; rotate without touching devices |
| Ax polling too often and reading D1 in a loop | cursor feed + `limit` cap; poll interval documented (≥ 30 s) |
| Two Ax surfaces submitting the same objective | required `idempotencyKey`; replay returns the original id |
| Ax approving its own task | structurally impossible: approvals require a verified owner device |
| Feed skipping a task in a busy millisecond | `(updated_at, id)` compound cursor |
| Presence row claiming a connection that never happened | presence records calls, not intention; absence reads as `null` |
