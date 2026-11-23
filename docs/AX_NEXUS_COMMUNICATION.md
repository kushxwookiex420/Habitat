# Ax ↔ NEXUS communication protocol (Mission 14)

**Evidence level: locally implemented and locally tested.** Every claim below is proven by
`tests/ax-message-channel.test.mjs` (9 tests) and `tests/ax-nexus-e2e.test.mjs` (3 tests) against
the real composition root, a D1-shaped SQLite transport and the real NEXUS tick. Nothing here has
travelled over the internet, reached Render, touched D1, or involved a ChatGPT connector.

> **What "direct communication" means here.** Habitat now exposes a durable, authenticated,
> bidirectional channel that an authorised Ax client can use. This ChatGPT session is not that
> client: a personal ChatGPT plan cannot create a GPT/Action, and no connector has been authorised
> in this session. §7 states exactly what an owner must do to put Ax on the other end.

---

## 1. Why a message channel, not a chat endpoint

The existing `/ax/command/tasks` API submits work but has no concept of a conversation: there is no
correlation id, no NEXUS-initiated question, no place for an approval request's answer, and no
retry/DLQ state. The channel adds exactly that and reuses everything else:

| Concern | Existing component reused |
| --- | --- |
| Execution | `universal-command-engine` → `habitat_command_tasks` |
| Worker | NEXUS runtime tick, atomic claim + fence + lease |
| Adapters | `READ_ONLY_ADAPTER_NAMES` allowlist (repo.inspect, task.inspect, runtime.health) |
| Audit | append-only `habitat_ax_security_events` (hash-chained) |
| Notifications | `habitat_ax_notifications` (inbox channel) |
| Budget | objective reservation/settlement, per-run budget |
| Owner approval | paired owner device only |

The channel owns **one new table**, `habitat_ax_messages`. It is not a second task store and it
never executes anything itself.

## 2. Direction and identity are structural

Two credentials, two surfaces:

| Credential | Header | Routes | Records as |
| --- | --- | --- | --- |
| `HABITAT_AX_COMMAND_TOKEN` (or the device-capable `HABITAT_AX_BRIDGE_TOKEN`) | `Authorization: Bearer …` | `/ax/command/messages*` | `from: "ax"` |
| `AX_NEXUS_TOKEN` | `x-nexus-token` or Bearer | `/ax/nexus/*` | `from: "nexus"` |

- A body field named `from` is ignored. The authenticated surface decides the direction.
- Ax's credentials are rejected on `/ax/nexus/*` with `401 invalid_nexus_token`, and NEXUS's
  credential is not accepted on `/ax/command/*`.
- `AX_NEXUS_TOKEN` unset → `/ax/nexus/*` answers `503 nexus_auth_unconfigured`. It never falls back
  to an Ax token.
- Comparisons are constant-time and fail closed; no token appears in a URL, log or response.

## 3. Endpoints

### Ax surface (`/ax/command`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/ax/command/messages` | Submit a `task`, `question` or `note` |
| GET | `/ax/command/messages` | List, filter by `status`, `correlationId`, `from` |
| GET | `/ax/command/messages/thread/:correlationId` | **Retrieve the whole exchange by correlation id** |
| GET | `/ax/command/messages/:id` | Read one message |
| POST | `/ax/command/messages/:id/answer` | Answer a NEXUS question or approval request |

### NEXUS surface (`/ax/nexus`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ax/nexus/channel` | Channel stats, allowed adapters, limits |
| GET | `/ax/nexus/inbox` | Queued / acknowledged / working messages |
| POST | `/ax/nexus/messages/:id/acknowledge` | Receipt |
| POST | `/ax/nexus/messages/:id/progress` | Working + note/percent |
| POST | `/ax/nexus/messages/:id/complete` | Result + **required evidence** |
| POST | `/ax/nexus/messages/:id/fail` | Error, retryable or terminal |
| POST | `/ax/nexus/messages/ask` | Question or approval request to Ax |
| POST | `/ax/nexus/messages/notify` | Informational message to Ax |
| GET | `/ax/nexus/thread/:correlationId` | Same thread view for the runtime |

`/ax/command/openapi.json` now includes the Ax message endpoints, so an Action/connector can import
them (`sendNexusMessage`, `listNexusMessages`, `getNexusThread`, `answerNexusQuestion`).

## 4. Record and state machine

```json
{
  "id": "msg_…", "schemaVersion": 1, "correlationId": "cor_…",
  "project": "habitat", "from": "ax", "to": "nexus",
  "origin": { "client": "ax-command-token", "role": "ax-client" },
  "kind": "task", "status": "queued",
  "objective": "report runtime health", "adapter": "runtime.health",
  "body": "…", "taskId": null, "attempts": 0, "maxAttempts": 3,
  "result": null, "error": null, "evidence": [],
  "timeline": [{ "at": "…", "from": "ax", "to": "nexus", "type": "submitted", "status": "queued" }],
  "createdAt": "…", "updatedAt": "…"
}
```

```
queued ──ack──▶ acknowledged ──▶ working ──▶ completed
   │                 │              │
   └─────────────────┴──────────────┴──▶ failed ──(retryable, attempts<3)──▶ queued
                                              └──(attempts=3)──▶ dead_letter
awaiting_answer ──answer──▶ answered
sent  (informational NEXUS→Ax; terminal)
```

Every transition is a compare-and-swap on the stored record, so an acknowledgement and a completion
arriving together cannot overwrite each other. A repeated transition is a replay, not a rewrite.

## 5. Guarantees and limits

| Property | Implementation |
| --- | --- |
| Idempotent submission | `idempotencyKey` is mandatory; message id = `sha256("ax-message:"+from+key)`. A retry returns the original message; the engine reuses `message:<id>` as the task key |
| Exactly-once side effects | **Not claimed.** Delivery is at-least-once; only read-only adapters are allowed |
| Correlation | `correlationId` is bounded (120 chars, `[A-Za-z0-9._:-]`), generated when omitted |
| Thread retrieval | `GET …/thread/:correlationId` returns messages oldest-first plus `terminal[]` and `awaitingDecision[]` |
| Bounded payloads | body 4000, objective 2000, summary 1200, 12 evidence items × 800, 60 timeline entries |
| Rate limiting | 30 messages per origin per 60 s; refused messages are not stored; `429` + `retryAfterMs` |
| Redaction | `sk-…`, `Bearer …`, GitHub tokens, `axcmd_/axbridge_/axnexus_…`, owner-token assignments → `[redacted]` before persistence |
| Evidence requirement | `complete` refuses without at least one evidence item (`400 evidence_required`) |
| Audit | submit/ack/complete/fail/dead-letter/question/answer are written to the security log **before** the response |
| Retry / DLQ | retryable failure requeues with `attempts+1`; at `maxAttempts` the message becomes `dead_letter` and raises a high-severity finding |
| No arbitrary execution | `kind=task` must name an adapter on `READ_ONLY_ADAPTER_NAMES`; bodies are never interpreted as commands |
| Project isolation | `project` is stored and filterable; the channel never reads another store's rows |

## 6. Acceptance test — what was actually demonstrated

`tests/ax-nexus-e2e.test.mjs`, against the real `registerDeviceCommandBridge` composition:

1. Ax submits a harmless task (`kind=task`, adapter `runtime.health`). → `201`, `queued`, `from: ax`.
2. Habitat persists it; the same store returns it by id.
3. Unauthorised submission → `401 invalid_token`.
4. Duplicate submission (same idempotency key) → `200`, `replayed: true`, same id.
5. Ax credential on the NEXUS surface → `401 invalid_nexus_token`.
6. Scheduler autonomy pass acknowledges and dispatches it → message `working`, `taskId cmd_…`.
7. The real NEXUS tick claims and executes the task → `done` with adapter evidence.
8. The next autonomy pass completes the message from that evidence.
9. `GET …/thread/:correlationId` returns `completed` with evidence and no pending decision.
10. The security log contains `ax.message.submitted`, `ax.message.completed` and `auth.failure`.
11. A second, freshly constructed bridge over the same database reconstructs the thread.
12. State comes from durable rows, not process memory.
13. After the restart the duplicate key still replays and the tick claims nothing.
14. Exactly one message and one task exist.
15. An approval-gated objective is untouched by autonomy and the command token cannot approve it.

Plus the focused suite: idempotency, allowlist refusal, redaction, rate limit, ack/progress/complete,
question/answer, retry→dead-letter, drain-not-resubmitting, and route-level credential separation.

## 7. What an owner must do to put Ax on the other end

Nothing in this repository can authorise this ChatGPT session to reach a private server by itself.

1. **Deploy** this branch (or merge it) so `/ax/command/messages` is reachable over HTTPS. The
   service must set `HABITAT_AX_COMMAND_TOKEN` and `AX_NEXUS_TOKEN` as Render secrets.
2. **Use a client that can send a Bearer token.** OpenAI's documentation (checked for Mission 04)
   says personal ChatGPT plans cannot create GPTs/Actions, and custom MCP servers are
   Business/Enterprise with OAuth only. So either:
   - a managed ChatGPT workspace creates an Action from
     `https://<origin>/ax/command/openapi.json` with API-key/Bearer auth, or
   - an Ax client (the Freebuff agent, a script, a desktop tool) calls the same API with the token.
3. **Tell Ax the contract**: submit with a fresh idempotency key per objective, poll `getNexusThread`
   by correlation id, report `result.evidence` verbatim, and never claim to have approved anything.
4. **Keep the tokens out of the transcript.** Use Render → Environment / a password manager; rotate
   `HABITAT_AX_COMMAND_TOKEN` without touching device pairing.

Until step 1 and 2 are done on a real origin, the only accurate statement is: **the channel is
built and locally proven; Ax is not connected to a deployed NEXUS.**

## 8. Residual risks

| Risk | Mitigation |
| --- | --- |
| At-least-once adapter execution | read-only allowlist only; `SIDE_EFFECTING_ADAPTERS_ENABLED` remains false |
| A leaked command token submits messages | cannot approve, cannot reach devices, cannot read `/nexus/runtime`; rotate independently |
| Model-authored body carries a secret | redaction before persistence; bounded length |
| Prompt injection inside a body | the body is data; the adapter must already be allowlisted and is chosen by the client, not parsed from the text |
| Render Free sleeps | the channel persists; delivery resumes on the next tick after wake |
| Dead-letter accumulation | high-severity finding on the next tick; an owner decision is required to requeue |
