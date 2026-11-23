# Connecting ChatGPT (Ax) to Habitat

> **Correction, 2026-11-21 (Mission 04).** This path is **not available to a personal ChatGPT
> account**, Free or paid. OpenAI's help center states: "New GPT creation and publishing are not
> available on personal ChatGPT accounts, including Free, Go, Plus, and Pro." Actions live inside a
> custom GPT, so no personal plan can create one. Custom MCP servers are Business/Enterprise only and
> accept OAuth only — not a bearer key. See `docs/AX_ARCHITECTURE_DECISION.md` §1 for the citations.
>
> The API described below is built and tested. It is the interface a managed workspace would use, and
> it is what the Habitat-native agent calls today. Nothing here can be completed on this account.

**Status: not connected.** This document is the integration plan and the exact first live test. No
ChatGPT workspace, connector or custom GPT has been created, no credential has been issued, and no
request has ever travelled from OpenAI to Habitat. Everything below is unverified until §8 passes.

> **Mission 16 update (2026-11-22).** Custom GPTs are being retired in favour of plugins, and MCP
> authentication is still OAuth-or-none with no custom API keys. The current compatibility decision,
> the validated contract and the usable external relay are in
> [`CHATGPT_CONNECTION_READINESS.md`](CHATGPT_CONNECTION_READINESS.md). Read that first; this file
> remains the historical Action plan.

---

## 1. Which connection method, and why

Researched 2026-11-21 from OpenAI's own documentation:

| Method | Auth it accepts | Fit for Habitat |
| --- | --- | --- |
| **GPT Action** (custom GPT, OpenAPI schema) | None, **API key** (Basic / Bearer / custom header), OAuth | **Chosen.** Bearer API key maps directly onto `HABITAT_AX_COMMAND_TOKEN` |
| Custom MCP server (plugin, SSE/streaming HTTP) | **OAuth or no authentication only** — "ChatGPT does not support … nor can it present custom API keys" | Not usable without building an OAuth authorization server |

Sources: `developers.openai.com/api/docs/actions/authentication` (API key + OAuth),
`developers.openai.com/api/docs/guides/developer-mode` (custom MCP: "OAuth, No authentication, and
OAuth or no authentication"), `developers.openai.com/plugins/build/auth` (no API keys, no
machine-to-machine grants for MCP).

So: **a GPT Action with API-key/Bearer auth**. That is the only supported method that can send
Habitat's existing bearer token. An MCP server would require Habitat to become an OAuth
authorization server — a real project, deliberately out of scope here.

Availability, checked 2026-11-21: **no personal plan (Free, Go, Plus, Pro) can create a GPT**, so no
personal account can create an Action at all; custom MCP servers are limited to Business and
Enterprise/Edu workspaces and accept OAuth only. Custom GPTs are also scheduled for retirement
(standard date 2026-12-11) in favour of plugins. Do not plan around this path without a managed
workspace.

## 2. What the Action sees

The schema is served by the service itself:

```
GET https://<habitat-origin>/ax/command/openapi.json
```

It is public (shapes only, no secret) because ChatGPT fetches it before any credential exists.
Paths: submit, read one task, list tasks, the change feed, presence, tools. `POST /ax/command/tasks`
is marked `x-openai-isConsequential`, so ChatGPT asks for confirmation before submitting.

Limits the API was designed around: ChatGPT Actions time out at **45 seconds**, cannot send custom
headers, and cap payloads at 100k characters. Therefore there is deliberately **no** "wait until
done" endpoint — submit returns an id immediately and Ax polls.

## 3. What must be true on the Habitat side first

Owner actions, in order. Nothing here has been done.

1. **Deploy the branch** `ax-nexus/revision-4.6-nexus-mainline-integration` (commit `20696a2` or
   later) to the existing Render service. Requires merging to a deployed branch or pointing Render
   at it — an owner decision, not made here.
2. **Set `HABITAT_AX_COMMAND_TOKEN`** in Render → Environment as a secret. Generate it locally and
   never paste it into a chat:
   ```sh
   node -e "console.log('axcmd_' + require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Store it in the password manager entry ChatGPT will use. Do **not** reuse
   `HABITAT_AX_BRIDGE_TOKEN`: that one can unpair and command devices, which Ax must not be able to
   do.
3. **Make sure storage exists**: `habitat_command_tasks` and its `(updated_at, id)` index are created
   by the first authenticated command request (`initialize()` is idempotent).
4. **Give NEXUS something to execute with.** Without one of these, submitted tasks stay `queued`
   forever and presence says `canExecute: false`:
   - the Render Cron Job from `docs/NEXUS_CRON_DEPLOYMENT.md` (recommended, $1/mo), or
   - `NEXUS_RUNTIME_ENABLED=true` on the web service (only while it is awake).
5. **Wake the service before the first probe.** On Render Free it sleeps after 15 minutes idle; a
   cold start can exceed the Action's 45-second timeout. Hit `/health` first, or run the service on a
   paid instance.

Verify with curl before touching ChatGPT:

```sh
BASE=https://habitat-1-szzd.onrender.com
curl -sS "$BASE/ax/command/presence" -H "Authorization: Bearer $HABITAT_AX_COMMAND_TOKEN"
# expect 200, schemaVersion 1, presence.reachable true
# expect presence.executor.state "not_mounted" with reason "disabled_by_config" while the worker is off
```

## 4. Creating the Action (ChatGPT UI, manual)

These steps are written from OpenAI's documented UI; they have **not** been performed.

1. ChatGPT → **GPTs** → *Create* (or edit an existing Ax GPT) → **Configure**.
2. **Actions** → *Create new action*.
3. **Import from URL**: `https://<habitat-origin>/ax/command/openapi.json`.
   If the editor refuses the URL, save the document locally and paste/upload it:
   ```sh
   curl -sS "https://<habitat-origin>/ax/command/openapi.json" -o ax-openapi.json
   ```
   Set the server URL in the editor to the same origin.
4. **Authentication** → *API Key* → *Bearer* → paste the `HABITAT_AX_COMMAND_TOKEN` value. ChatGPT
   stores it encrypted server-side; it is not visible in the conversation.
5. Save. In the preview pane, ask: *"Use getPresence and tell me whether NEXUS can execute."* A
   model that returns the presence fields is a working schema; a 401 means the credential is wrong,
   and a 404 means the deploy does not include the route.
6. Add instructions to the GPT that forbid inventing results, e.g.:

   > You are Ax, talking to NEXUS through the Habitat command API. Submit with `submitTask` and use
   > a fresh, unique `idempotencyKey` per objective; reuse the same key only when retrying the same
   > submission. `submitTask` returning an id does not mean the work happened: call `getTask` until
   > the status is `done`, `failed`, `cancelled` or `needs_approval`. Report `result.evidence`
   > verbatim; never summarise it as success unless it exists. If `canExecute` is false, say NEXUS
   > cannot execute and quote the presence fields. Never claim to have approved anything: only the
   > owner's paired device can approve.

## 5. Polling pattern (because of the 45-second limit)

```
submitTask  → task.id, status queued
getTask(id) → queued / working / needs_approval / done / failed / cancelled
```

Between turns, use the feed instead of polling every task:

```
getEvents({ since: <previous nextSince>, afterId: <previous nextAfterId> })
```

Carry **both** cursor values forward. Empty `since` means "from the beginning".

When `status: "needs_approval"`, Ax reports that owner approval is required and stops. It cannot
approve; a request carrying the command token is refused with `403 command_token_cannot_approve`.

## 6. What is deliberately not exposed to Ax

- No side-effecting adapter. Only `repo.inspect`, `task.inspect` and `runtime.health` can be
  registered while `SIDE_EFFECTING_ADAPTERS_ENABLED` is false.
- No device routes (`/ax/device/*`), no pairing, no revoke, no `/nexus/runtime` (operator view).
- No owner approval, no task completion on the owner's behalf.
- No access to `habitat_tasks`; command work lives only in `habitat_command_tasks`.

## 7. Risks accepted by this design

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| ChatGPT receives the command token | It can submit and read command tasks | Separate from device token; rotate without touching pairing; cannot approve |
| Prompt injection inside an objective | A task could try to name a side-effecting adapter | Adapter allowlist refuses it at submit; the worker refuses at mount |
| OpenAI can read task payloads | Objectives and evidence pass through a third party | Submit only non-secret objectives; secrets never go in a task |
| Sleep / cold start | The first Action call may time out | Wake `/health` first; use a paid instance or a cron executor |
| Duplicate submissions on retry | Duplicate work | Required `idempotencyKey`; replay returns the original id |

## 8. The first live communication test (definition of "connected")

Run only after §3 and §4. Record the actual JSON for every step; a green schema import is not a
connection.

1. **Presence from ChatGPT.** Prompt: *"Call getPresence."* Pass: `reachable: true` and a state you
   can explain (`running` or `not_mounted` + reason). Fail: any error, or a fabricated answer that
   the tool did not return.
2. **Submit.** Prompt: *"Use submitTask with objective 'ax live round trip', adapter 'runtime.health',
   idempotencyKey 'ax-live-<date>'."* Pass: a `task.id` beginning `cmd_`, status `queued`. Record it.
3. **Replay.** Ask for the same submission again. Pass: the **same id** with `replayed: true`.
   Fail: a second task.
4. **Progress without a phone.** Ask *"getTask for that id"* until terminal. Pass: `done` with
   `result.evidence` containing a `runtime:` line and `verifiedBy` starting `nexus-`. Fail: stuck
   `queued` (no executor — §3.4), or `result` present without evidence.
5. **Feed.** Ask *"getEvents since ~10 minutes ago"*. Pass: the task appears with
   `type: task.completed` and a usable cursor.
6. **Scope separation.** Prompt: *"Approve that task."* Pass: `403 command_token_cannot_approve`, or
   a refusal before any call. Fail: any 200.

All six must pass on one task id. Until then the only accurate statement is: **the bridge is built
and tested locally; Ax is not connected.**

## 9. What remains manual or impossible from here

- Merging/deploying the branch, creating the Render Cron Job, setting the Render secret: owner.
- Creating the GPT/Action and pasting the bearer token: owner, in the ChatGPT UI.
- A workspace plan that permits creating a GPT with Actions: owner.
- No automated test in this repository can prove the OpenAI → Render → D1 → NEXUS → D1 → OpenAI
  path; only §8 can.
