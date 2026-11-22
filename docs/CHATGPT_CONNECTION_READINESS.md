# ChatGPT ↔ Habitat connection readiness (Mission 16)

**Status: BLOCKED BY CHATGPT PLAN for a direct ChatGPT connection. READY FOR OWNER SETUP on the
Habitat side.** The Ax command contract is validated against the real routes, a live local HTTP run
passes, and an external token-holding relay exists for use today. No ChatGPT account is connected:
no request has ever travelled from OpenAI to Habitat, and this document does not claim one has.

- Repository: `kushxwookiex420/Habitat`, PR #93, branch `ax-nexus/revision-4.6-nexus-mainline-integration`.
- Baseline: `5640afeb66d6c10b7b9aab7a3a3f76de9d849515` (Mission 15 head).
- Researched and run: 2026-11-22. Evidence levels are stated per claim.
- No Render deployment, merge, production variable change, D1 migration, paid resource or ChatGPT
  setting was made.

---

## 1. Decision

**Recommended architecture today — B: an external authenticated client with a manual relay.**

```
ChatGPT (Free)  --copy/paste text-->  owner / Ax relay (holds HABITAT_AX_COMMAND_TOKEN)
                                             |
                                             +--> HTTPS --> Habitat /ax/command/* --> NEXUS
```

ChatGPT cannot call Habitat itself on this account. The only honest, secure connection is a client
that holds the credential outside ChatGPT and relays what the model wrote. The owner is the
transport; the model never sees a token and no inbound request from OpenAI exists to verify.

**Not available on this account:**

| Path | Why it is unavailable | Verdict |
| --- | --- | --- |
| GPT Action (OpenAPI import, API-key auth) | Actions live inside a custom GPT. OpenAI: "New GPT creation and publishing are not available on personal ChatGPT accounts, including Free, Go, Plus, and Pro." Custom GPTs also have a standard retirement date of 2026-12-11. | **Unsupported** |
| Custom MCP connector | MCP authentication is OAuth 2.1 or no authentication; "ChatGPT … nor can it present custom API keys". Habitat's credential is a bearer token, so an MCP server would need to become an OAuth 2.1 authorization server. Custom MCP availability also depends on plan/workspace and is not documented for Free. | **Unsupported today** |
| ChatGPT Sites-hosted plugin relay | OpenAI documents creating a plugin with an app hosted on ChatGPT Sites "on any ChatGPT plan", but that app would hold the Habitat token inside OpenAI-hosted infrastructure and must be built in the ChatGPT UI. It cannot be built or verified from this repository. | **Possible owner project, not recommended for a bearer-only private service** |
| Raw REST/OpenAPI as MCP | A REST API is not an MCP server. ChatGPT does not import OpenAPI as a connector; OpenAPI is consumed only by Actions. | **Unsupported** |
| Authenticated external client (this relay, Buffy/Freebuff, scripts, control center) | Holds the token where a secret can live, uses the documented HTTPS contract. | **Works today** |

Sources checked 2026-11-22: `help.openai.com/en/articles/9275245` (Free tier FAQ), `help.openai.com/en/articles/20001256`
(plugins availability), `help.openai.com/en/articles/9442513` (actions and the retirement date),
`developers.openai.com/plugins/build/auth` (OAuth only, no custom API keys), `developers.openai.com/plugins/quickstart`
(Add custom MCP server, no-authentication example).

Because the Action and MCP paths are blocked before any Habitat work matters, **no OAuth server, MCP
adapter or unauthenticated endpoint was added**. Adding one to satisfy a feature this account cannot
use would be an unverified security surface.

---

## 2. Contract validation — the document against the real routes

`scripts/ax-openapi-contract.mjs` compares the served document with the route table produced by the
real `registerUniversalCommandRoutes` mount. It is not a schema lint over a hand-written file.

| Check | Result |
| --- | --- |
| Registered `/ax/command` + `/ax/nexus` routes | 84 |
| Operations advertised in the document | 10 |
| Documented but not implemented (invented endpoints) | **0** |
| Implemented but neither documented nor explicitly excluded | **0** |
| Excluded routes with a recorded reason (NEXUS surface, operator views, owner transitions) | 74 |
| Duplicate operation ids | 0 |
| Path parameters declared and required | all |
| Server origin HTTPS (loopback allowed for local checks only) | pass |
| Credential-shaped strings in the document | 0 |
| Global `bearerAuth` scheme (`http`/`bearer`) | pass |

Four real contract defects were found and fixed in `scripts/ax-openapi.mjs`:

1. `nullable: true` is OpenAPI 3.0 syntax and invalid in a 3.1 document — replaced with type unions
   (`["string", "null"]`), which a strict importer accepts.
2. The task schema advertised `history`; the API returns `statusHistory`.
3. A completed result advertises `verifiedBy` (the worker id) but the schema omitted it.
4. `blocked` (a task with no adapter waits for a human) was missing from the status enum.

The document remains a faithful description of the implemented routes; nothing was added to make a
tool look richer than it is.

---

## 3. Live local run — real socket, real process

`npm run readiness:chatgpt` starts the real composition root (`registerDeviceCommandBridge`) in a
**separate Node process** with a real TCP listener and drives it with real `fetch`.

Result: **22/22 checks pass, exit 0.** Evidence: `release/mission-16-chatgpt-readiness.json`.

| Check group | What was demonstrated |
| --- | --- |
| Public schema | `/ax/command/openapi.json` answers `200` with no credential, `application/json`, OpenAPI 3.1.0 |
| No invented operations | every advertised operation exists in the real route table |
| Anonymous refusal | **all 10** advertised operations answer `401 invalid_token` without a credential |
| Authenticated use | presence `200` and `reachable: true`; tools `200`; note submitted `201` `from: ax` |
| Replay protection | the same idempotency key returns `200 replayed: true` and the same message id |
| Correlation | the thread is retrievable by correlation id with exactly one message |
| Credential separation | Ax credential → `/ax/nexus/*` `401`; NEXUS credential → `/ax/command/*` `401`; NEXUS credential → own surface `200` |
| Request validation | an incomplete task is refused with a 4xx |
| Rate limiting | message channel 30/min per origin; the whole command surface now also has a per-credential limiter (`AX_COMMAND_RATE_MAX`, default 240/min, `AX_COMMAND_RATE_WINDOW_MS`) returning `429 rate_limited` |

**Labelled substitutions:** the D1 network transport is `node:sqlite` behind a D1-shaped fetch shim.
No Cloudflare, Render or OpenAI endpoint is contacted by this run. This is **local**, not staging,
not production.

Unit tests added: `tests/ax-openapi-contract.test.mjs` (14), `tests/ax-relay.test.mjs` (10),
`tests/ax-command-rate-limit.test.mjs` (3). The validator tests prove it *fails* on an invented
endpoint, an unclassified route, a duplicate operation id, plain HTTP, `nullable`, an oversized
description, an undeclared path parameter and an embedded credential.

---

## 4. The external relay (usable today)

`scripts/ax-relay.mjs` is a token-holding client, not a ChatGPT connector.

- The token is read from `HABITAT_AX_COMMAND_TOKEN` only — never a flag, a file or a chat message.
- The origin must be HTTPS unless it is loopback.
- An envelope may contain only `kind`, `body`, `objective`, `adapter`, `correlationId`, `project`,
  `idempotencyKey`; `from` and unknown fields are refused, so the model cannot choose its direction.
- A deterministic idempotency key is derived from the envelope when absent, so running the same
  reply twice replays instead of duplicating work.
- Output is redacted against the credential shapes the channel stores. It cannot approve anything
  and has no command for approvals, device routes or the NEXUS surface.

```
npm run ax:relay -- brief                     # read-only snapshot to paste into ChatGPT
npm run ax:relay -- thread cor_123            # one thread, oldest first
npm run ax:relay -- send envelope.json --dry-run
npm run ax:relay -- send envelope.json        # POST /ax/command/messages
```

The envelope ChatGPT writes back is one JSON object:

```json
{"kind":"task","body":"why it matters","objective":"report runtime health","adapter":"runtime.health","correlationId":"chatgpt-2026-11-22-1"}
```

This is the manual step, stated plainly: the owner copies the brief in and the envelope out. It is
not automatic, it is not a ChatGPT connection, and the conversation is visible to OpenAI by design.

---

## 5. What the deployed origin shows today (read-only probe)

`https://habitat-1-szzd.onrender.com` on 2026-11-22, unauthenticated:

| Path | Status | Meaning |
| --- | --- | --- |
| `/health` | `200`, no `nexus` block, no `version` | the service is awake and runs **pre-Mission-14 code** |
| `/ax/command/openapi.json` | `404 Cannot GET` | the contract is not deployed |
| `/ax/command/presence` | `404` | the command API is not deployed |
| `/ax/nexus/channel` | `404` | the NEXUS surface is not deployed |

So even a perfectly configured ChatGPT client would fail against the live origin today. The repository
is ready; the deployment is not.

---

## 6. Phone-first setup path

### 6.1 Today — verify and use from a phone browser

1. **Deploy** the branch head from the Render dashboard (Render → `habitat-1-szzd` → Manual Deploy →
   the `ax-nexus/revision-4.6-nexus-mainline-integration` branch). Do not merge PR #93 to do this if
   the owner prefers a branch deploy.
2. **Add the secrets** in Render → Environment (values generated on the owner's device, never in chat):
   `AX_NEXUS_TOKEN` (new), `HABITAT_AX_COMMAND_TOKEN`, `HABITAT_AX_BRIDGE_TOKEN`, the three D1
   variables, optionally `HABITAT_PUBLIC_ORIGIN=https://habitat-1-szzd.onrender.com`.
3. **Verify from the phone browser, in this order:**
   - `https://habitat-1-szzd.onrender.com/health` → must now contain a `nexus` block and `version`.
   - `https://habitat-1-szzd.onrender.com/ax/command/openapi.json` → `200` JSON, `"openapi":"3.1.0"`.
   - `https://habitat-1-szzd.onrender.com/ax/command/presence` → `401` without a token (correct).
   - `https://habitat-1-szzd.onrender.com/control` → the control center.
4. **Use it:** the control center works from the phone. The relay needs Node and the token, so run it
   on a computer or in an agent workspace, not in the phone browser.

### 6.2 When an eligible ChatGPT surface exists

- **Action (managed workspace only):** create the GPT → Actions → Import from URL
  `https://habitat-1-szzd.onrender.com/ax/command/openapi.json` → Authentication *API key, Bearer* →
  paste `HABITAT_AX_COMMAND_TOKEN` into the Action auth field (never into the conversation) → save →
  ask it to call `getPresence`, then `submitTask`, then `getTask` until terminal.
- **MCP (OAuth-capable plan only):** do not start this until Habitat has an OAuth 2.1 authorization
  server with protected-resource metadata, PKCE and audience checks. A bearer token cannot be
  presented to ChatGPT's MCP client, and an unauthenticated MCP endpoint is not acceptable.

Neither step is possible on a personal Free account today; §1 gives the citations.

---

## 7. Evidence levels

| Claim | Level |
| --- | --- |
| Document matches 84 real routes; 10 operations; 4 defects fixed | implemented, unit-tested locally |
| Public schema, anonymous 401 on every operation, authenticated presence, idempotent replay, credential separation, rate limit | **live local HTTP**, real TCP socket, separate Node process |
| Storage behaviour | local `node:sqlite` behind a D1-shaped shim — **not D1** |
| Live Render origin | real network, unauthenticated read-only probe — deployment is stale |
| ChatGPT connection | **none**. No OpenAI request, no connector, no Action, no MCP server |

---

## 8. Owner actions still required

Separated from the work completed above.

1. Deploy the branch head to Render and add `AX_NEXUS_TOKEN` (and confirm the other variables).
2. Confirm `/health` gains `nexus` and `/ax/command/openapi.json` answers `200`.
3. Create the scheduler trigger (Render Cron `npm run tick` or an external tick with
   `AX_SCHEDULER_TOKEN`) — without it, submitted tasks stay queued.
4. Generate `HABITAT_AX_COMMAND_TOKEN` locally, store it in a password manager, and run the relay
   from a computer or this agent workspace.
5. Only with a managed ChatGPT workspace: create the Action (§6.2). A personal plan cannot.
6. Treat every brief pasted into ChatGPT as public to OpenAI; never paste a token or an owner device
   secret.

---

## 9. Risks and limitations

| Risk | Status |
| --- | --- |
| ChatGPT receives pasted content | by design on the relay path; redaction covers known token shapes, not arbitrary secrets |
| Manual relay is not automation | stated; nothing runs unattended on the ChatGPT side |
| Limiters are per process | behind several Render instances the effective limit multiplies |
| The command API has no per-message content moderation | bodies are bounded and redacted, not interpreted |
| MCP would need an OAuth server | deliberately not built; bearer-token MCP is unsupported |
| Deployed origin is stale | verified 404s; no claim of a working live contract |
| A model answering a NEXUS `approval_request` | the answer is recorded, never applied to a task; owner approval still requires the paired device, and the relay cannot answer at all |

---

## 10. Release decision

| Criterion | State |
| --- | --- |
| Which ChatGPT path is usable on this account | **none for a direct connection**; external authenticated client + manual relay |
| OpenAPI validated against implemented routes | yes, 0 phantom, 0 unclassified |
| Auth on every advertised operation | yes, live local HTTP |
| HTTPS / request validation / idempotency / audit / rate limits | enforced or validated; audit is written by the channel and security log |
| Secrets kept out of documents, logs, evidence and chat | yes — the validator refuses a credential in the document |
| Real ChatGPT request observed and verified | **no** |
| Deployed Render contract | **no** — 404 at the live origin |

**Final status: BLOCKED BY CHATGPT PLAN.** Habitat is ready for owner setup; the only missing pieces
are a deployment and a ChatGPT surface this account does not have.
