# Ax heartbeat and ChatGPT reconnection

Habitat keeps its own heartbeat. It does not depend on ChatGPT being present, and it never pretends a
disconnected integration is "connected" because a request was sent.

**Status: implemented and locally integration-tested; not enabled, and no ChatGPT reconnection has been
proven end to end.** `HABITAT_HEARTBEAT_ENABLED` is unset.

## What the connection monitor does

- **Beats on its own schedule** (`HABITAT_HEARTBEAT_ENABLED=true`, `AX_HEARTBEAT_INTERVAL_MS`, default
  60s) and persists `lastBeatAt`, missed beats and failures in `habitat_ax_heartbeat_state`.
- **Turns meaningful changes into events**, not periodic chat spam. Event keys are derived from state
  (`mission:<id>:<status>`, `approval:<mission>:<reason>`), stored with a unique dedupe key, so repeated
  beats and process restarts cannot enqueue the same event twice.
- **Queues across disconnection.** An event is `pending` until a delivery succeeds; nothing is dropped
  because no integration is listening.
- **Attempts delivery only through a configured notifier.** With none, events stay queued and the status
  says `notifier: none` rather than claiming delivery.
- **Distinguishes sent / delivered / acknowledged / dead.** A 2xx webhook marks `delivered`; only an
  authenticated acknowledgement marks `acknowledged`; bounded attempts (default 3) end in `dead` with the
  error retained.
- **Detects disconnection.** A beat gap (process down) or a long absence of the integration yields
  `disconnected` / `stale`; the monitor never reports `connected` without a seen integration.

## The trigger

Every reconnect payload begins with the established trigger:

> AX RECONNECT — HABITAT HEARTBEAT.

It carries:

- habitat version/commit/uptime and component states (identity, workforce, missions, gateway);
- active missions, completed work, failures, pending approvals and pending tasks;
- changes since the integration was last seen, and the current queue;
- `delivery: {received: true, executed: false, verified: false}` — reading the trigger does not mean the
  work was executed or verified.

ChatGPT's instruction is to treat the trigger as a request to restore context: inspect status, review
results, then issue follow-ups through the authenticated gateway.

## Supported delivery mechanisms (researched 2026-11-24)

- **GPT Actions / plain connectors are pull-only.** The documented model is a tool call during a user
  turn; an ordinary HTTPS request cannot wake an inactive conversation.
- **ChatGPT scheduled tasks** can run recurring work and show notifications, but they poll — Habitat
  cannot inject a message into that run.
- **MCP Events** is the supported push path: ChatGPT (Work chats, web/desktop) subscribes through an MCP
  server (`events/list`, `events/subscribe`, `events/unsubscribe`) and receives signed webhooks
  (Standard Webhooks headers), webhook-only, one event per request, ≤256 KiB, 10s timeout, with callback
  verification. That is the correct long-term adapter.
- **What is built here:** the durable queue, exact trigger, and a signed webhook notifier
  (`AX_NOTIFY_WEBHOOK_URL`, `AX_NOTIFY_WEBHOOK_SECRET`) suitable for a relay that can place the event
  into a supported surface. The full MCP Events server (subscription storage, callback challenge,
  per-subscription signing secrets) is **not implemented or tested**, so inbound wake of ChatGPT is
  unverified.

The guaranteed path today is pull: `GET /ax/v1/heartbeat` returns the trigger and current context, and
`POST /ax/v1/heartbeat/ack` records acknowledgement.

## API

| Method | Path | Scope | Behaviour |
| --- | --- | --- | --- |
| GET | `/ax/v1/heartbeat` | `status:read` | reconnect payload with trigger; records the integration as seen |
| POST | `/ax/v1/heartbeat/ack` | `events:write` | acknowledges event ids; idempotent (duplicate acknowledged) |

Both are gateway routes: they answer 503 when the gateway is disabled and follow the same token, expiry,
revocation, rate-limit and nonce rules. `events:write` cannot submit, approve or deploy.

## Failure and recovery behaviour

| Situation | Result |
| --- | --- |
| notifier absent | events queued; connection `never_connected`/`awaiting_ack`; nothing called "delivered" |
| webhook 5xx/timeout | attempt recorded, retried on the next delivery pass up to the bound, then `dead` |
| webhook recovers | the queued event is delivered, attempts preserved, failure counter reset |
| integration silent past `staleAfterMs` | `stale` (beats continue) |
| no beats for >2 intervals, or ≥2 missed | `disconnected` until a reconnect |
| duplicate beat | no new event (dedupe key) |
| duplicate ack | `acknowledged: 0, duplicate: true` |
| process restart | queue and state re-read from D1; no phantom "connected" |

## Evidence

`tests/ax-heartbeat.test.mjs` (10 tests): exact trigger text; dedupe across beats; status change event;
delivered ≠ acknowledged; no resend after delivery; bounded retries then dead; no notifier means queued;
missed-beat disconnection and stale detection; reconnect context with active/completed/failed/approval
work; idempotent ack; recovery after two failures; snapshot never invents completion.
`tests/ax-gateway.test.mjs` adds 2 real-HTTP tests: heartbeat payload and scoped, idempotent ack.

## Limits

- No real ChatGPT reconnection, webhook subscription or MCP Events handshake has been exercised.
- The webhook notifier is a relay adapter, not an MCP Events server, and cannot by itself wake ChatGPT.
- Delivery is at-most-once per event in normal operation: once marked delivered it is not resent even if
  the receiver lost it; the pull endpoint's queue is the recovery path before acknowledgement.
- The in-process beat loop means one monitor per process; multiple replicas would each beat. Sequencing
  is by persisted state, but the queue is not partitioned.
