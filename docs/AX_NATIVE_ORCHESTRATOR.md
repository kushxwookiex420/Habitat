# Habitat-native Ax

Ax runs inside Habitat. An objective goes in; a plan, task ids, verified evidence and a token cost
come out. It does not own a second task engine: it drives the existing command engine and NEXUS
worker.

Code: `ax-orchestrator.mjs`, `d1-ax-run-repository.mjs`, routes in `command-routes.mjs`, wiring in
`device-command-bridge.mjs`. Tests: `tests/ax-native-orchestrator.test.mjs`.

**Status: built and tested locally. No live model call, no deployment.** The model transport is the
only stubbed part of the tests; everything after it is production code.

---

## 1. Flow

```
POST /ax/command/runs {objective}
  │
  ├─ planner (OpenAI chat/completions, JSON-schema response)      ← the only model call
  │     → plan: [{objective, adapter, needsApproval}]
  │     → validated against the worker's real adapter set; unknown adapter ⇒ refused, nothing queued
  │
  ├─ step marked needsApproval ⇒ NOT submitted. Run ends "needs_approval". Ax cannot approve.
  │
  ├─ engine.submit() per step, idempotencyKey = <runId>:s<index>
  │     → the same habitat_command_tasks rows the API and the worker already use
  │
  ├─ NEXUS executes: the in-process worker's tick(), or the cron executor if none is mounted
  │
  ├─ verify: status done AND result.evidence non-empty AND result.verifiedBy matches /^nexus-/
  │     → a "done" task without worker evidence is not accepted
  │
  ├─ one failed step? ask the planner for ONE corrective step (bounded), submit it, verify again
  │
  └─ run record: status, plan, steps, evidence, token usage, cost, corrections, errors
```

Run statuses: `completed` (every step verified or repaired-and-verified), `needs_approval`,
`failed`, `budget_exceeded`, `deadline_exceeded`, `running` (no in-process executor: queued for the
cron job), `error` (planning failed).

A corrected failure stays visible in the record: `steps[0].status: "failed"`,
`steps[0].correctedBy: "<task id>"`, and the corrective step carries `corrective: true`. The run is
`completed` only because the corrective task produced verified evidence.

## 2. Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/ax/command/runs` | `{objective}` → run record (201). Requires the command token. |
| GET | `/ax/command/runs?limit=` | recent runs, newest first |
| GET | `/ax/command/runs/:id` | one run, including its plan, steps, evidence and cost |

All three answer `503` with `code: "orchestrator_disabled"` or `"openai_unconfigured"` when the agent
is not available, and `"run_store_unavailable"` when D1 cannot hold the run record. They are **not**
in `/ax/command/openapi.json`: this is Habitat's own agent, not a tool for an external model.

Tasks created by a run are ordinary command tasks: they appear in `GET /ax/command/tasks`, in the
change feed, and in `/nexus/runtime` queue counts. There is no second task store.

## 3. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | required; a server-side secret, never returned or logged |
| `AX_ORCHESTRATOR_ENABLED` | off | must be exactly `true`; disabled means the routes answer 503 |
| `AX_MODEL` | `gpt-6-luna` | planning model |
| `AX_OPENAI_BASE_URL` | `https://api.openai.com/v1` | override for a compatible gateway |
| `AX_MAX_STEPS` | 4 | 1–8; a plan larger than this is refused |
| `AX_MAX_CORRECTIONS` | 1 | 0–3; corrective steps per run |
| `AX_RUN_DEADLINE_MS` | 90000 | a run that has not settled by then reports `deadline_exceeded` |
| `AX_POLL_MS` | 250 | pause between executions while driving |
| `AX_RUN_BUDGET_USD` | 0.05 | hard stop on model spend for one run |
| `AX_PRICE_INPUT_PER_MTOK` | 2.00 | conservative; set to the model's real rate |
| `AX_PRICE_OUTPUT_PER_MTOK` | 10.00 | conservative; set to the model's real rate |

The agent also needs the command store (`CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`,
`HABITAT_D1_API_TOKEN`) and the command token or bridge token for callers.

## 4. Monitoring

Everything is durable and readable:

- `GET /ax/command/runs` — every run, its status, cost and steps
- `GET /ax/command/runs/:id` — the plan, each step's task id, status, evidence and failure reason
- `GET /ax/command/tasks/:id` — the underlying task with its full `statusHistory`
- `GET /ax/command/events` — feed of every task change
- `GET /ax/command/presence` — whether the executor is alive and whether the queue is stale

Nothing is hidden behind an in-memory counter. A run that failed says why; a run that could not be
persisted says `storeError: "run_could_not_be_persisted"`.

## 5. Security

- **The key never leaves the service.** It is used as a request header inside `createOpenAiPlanner`,
  never stored on a run, a task, a response or a log line. `redact()` strips `sk-…` and
  `Bearer …` shapes from any error before it is persisted or returned, and a test asserts none of the
  paths carries the key.
- **Least privilege.** The planner can only choose from `READ_ONLY_ADAPTER_NAMES`
  (`repo.inspect`, `task.inspect`, `runtime.health`). A plan naming anything else is refused before a
  task exists. `SIDE_EFFECTING_ADAPTERS_ENABLED` stays false.
- **No owner impersonation.** The orchestrator calls `engine.submit` as `ax`. A step the plan marks
  `needsApproval` is never submitted — the run stops and reports it. Approvals still require the
  owner's paired device, and the command token is refused with `403 command_token_cannot_approve`.
- **Bounded spend and bounded work.** `AX_RUN_BUDGET_USD`, `AX_MAX_STEPS`, `AX_MAX_CORRECTIONS` and
  `AX_RUN_DEADLINE_MS` all stop a runaway run; the budget is checked after every model call.
- **Auditable.** Task history lives in `habitat_command_tasks`; the plan and its cost live in
  `habitat_ax_runs`. Neither is overwritten by a later run.
- **No destructive production changes.** Only read-only adapters are registrable. A destructive
  action would require a new adapter, an explicit flag and owner approval — none exists.

## 6. Cost

Measured by the run, from the API's own token counts. One planning call of 900 input / 220 output
tokens costs **$0.0040** at the default conservative prices, or about **$0.0002** at a cheap tier's
published rate. Ten objectives a day is roughly **$1.20/mo** at the conservative price and cents at
the cheap one. Execution adds nothing. Details and the comparison with option A:
`docs/AX_ARCHITECTURE_DECISION.md` §3.

## 7. Making it live (owner actions)

1. Create an OpenAI API key at `platform.openai.com` and set it in Render → Environment as
   `OPENAI_API_KEY`. Never paste it into a chat or a commit.
2. Set `AX_ORCHESTRATOR_ENABLED=true`.
3. Set `AX_PRICE_INPUT_PER_MTOK` / `AX_PRICE_OUTPUT_PER_MTOK` to the model's current published rate
   so cost reporting is exact rather than conservative.
4. Deploy the branch. The run table and the command tables are created idempotently on first use.
5. Ensure an executor: the cron job (`docs/NEXUS_CRON_DEPLOYMENT.md`) or
   `NEXUS_RUNTIME_ENABLED=true`.
6. Verify, in this order:
   ```sh
   export BASE=https://<origin>
   export H="Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN"
   curl -sS "$BASE/ax/command/presence" -H "$H"                       # canExecute / reason
   curl -sS -X POST "$BASE/ax/command/runs" -H "$H" -H 'content-type: application/json' \
     -d '{"objective":"report the runtime health of this service"}'
   curl -sS "$BASE/ax/command/runs/<id>" -H "$H"                     # status, evidence, costUsd
   ```
   Pass: `status: "completed"`, `verified: true`, every step's `evidence` non-empty, `costUsd > 0`,
   and `GET /ax/command/tasks/<step id>` shows `result.verifiedBy` starting `nexus-`.
7. Repeat one objective with a deliberately impossible adapter name in the objective text and confirm
   the plan still only names real adapters (or the run refuses it).

Until step 6 passes on a deployed service, the only accurate statement is: **the agent is implemented
and locally proven; it has never called a real model or a real database.**

## 8. Limits

- The model can mis-plan. The adapter allowlist and the evidence check bound the damage, not the
  quality of the plan.
- A run is synchronous up to `AX_RUN_DEADLINE_MS`. With no in-process worker it returns `running`
  immediately and the cron job finishes the work.
- One corrective attempt per failed step. Repeated failure ends the run as `failed` with the reason.
- No streaming, no multi-turn dialogue: Ax is an orchestrator here, not a chat partner.
