# NEXUS Mission 20 — model-backed intelligence and research engine

Starting head: `0fae065bc382e62430c13b71568520ed68b21c0b` (Mission 19).
Branch: `ax-nexus/revision-4.6-nexus-mainline-integration` (PR #93, **not merged**).
No deployment, no environment change, no paid provider call, no credential exposure.

| Assignment | Status |
| --- | --- |
| Inspect provider abstraction, OpenRouter, research, transports, memory, work cycle | complete |
| Provider-independent model planning, strict validation, timeout, bounded retries, deterministic fallback | **built and tested** |
| Hard per-task and daily cost limits; free-only refuses paid calls | **built and tested** |
| Secure web research: SSRF, redirects, size limits, attribution | **built and tested** |
| Research execution inside the existing Research Agent | **integrated and tested** |
| Evidence, URLs, timestamps, uncertainty, conflicting findings preserved | **persisted and tested** |
| Research → Verification Agent → persistent memory | **wired and tested** |
| Full suite, release checks, CI | see the completion report; 781/781 before the final commit |

## 1. What was built

### 1.1 `ax-mission-planner.mjs` — model planning for the Director

The model is injected as a `complete({system,user,schema,signal})` function, so the planner does not
depend on a provider. `createOpenRouterCompletion` is one adapter (OpenAI-compatible); any transport
that returns `{ ok, text|json, costUsd, provider, model, free }` works.

- **Strict validation** (`validateModelMissionPlan`): 1–6 steps; agent must be in
  `MISSION_ROLE_IDS`; objective 8–1000 characters; no duplicate agent; **no adapter**; no director
  self-assignment. Unknown agents, adapters, duplicates and oversized plans are refused.
- **Guarantees cannot be delegated**: security review and independent verification are appended when
  the model omits them, and the result records `augmented`.
- **Timeout** per attempt (12 s default) and **one bounded retry** for transient/repairable failures.
  A refusal, forbidden plan or budget refusal is final and not retried.
- **Deterministic fallback**: every failure returns the existing `planMissionSteps` plan with
  `provider: "deterministic"`, `fallback: true` and the exact reason, so a mission never dies because
  a model was slow, malformed or over budget. The Director records the mode in its evidence.
- Missing capabilities are computed from the real capability matrix; the work cycle blocks rather
  than inventing an agent.

### 1.2 `ax-cost-governor.mjs` — hard spend limits

- Every call **reserves** an estimate first; the reservation is checked against the per-task ceiling
  and the remaining daily ceiling, then held so two concurrent missions cannot overdraw the day.
- `settle` replaces the reservation with the actual cost; failed calls are still settled.
- **Free-only is the default.** A call whose provider/model is not explicitly free is refused before
  any request: `openrouter/free` and models ending in `:free` are the only free forms.
- Defaults: `$0.02` per task, `$0.25` per day, `$0.006` estimate.
- The default ledger is process-local. That is stated as a limitation: a restart starts a new daily
  total. A durable store can be injected without changing the enforcement logic.

### 1.3 `ax-web-research.mjs` — secure research transport

- HTTPS only; credentials in the URL refused; non-443 ports refused.
- Hostname resolved and **every** answer checked; loopback, private, link-local, multicast and
  reserved IPv4/IPv6 ranges are refused, including `169.254.169.254`, `10/8`, `172.16/12`,
  `192.168/16`, `::1`, `fc00::/7`, `fe80::/10` and IPv4-mapped forms.
- At most three redirects, and **each hop is re-validated**; a public URL redirecting to a private
  address is refused.
- Content-type allowlist and a byte cap; truncation is labelled (`truncated`, `uncertainty`) instead
  of being passed off as a complete page.
- Source attribution: final URL, title, excerpt, SHA-256 digest, retrieval timestamp, confidence,
  HTTP status, content type and byte count.
- Contradictory sources are **preserved**. `divergences` flags pairs that share terms but differ in
  polarity as `resolved: false`; it is a review signal, not a verdict.
- No URL and no configured search means **no request** and an explicit empty result.

### 1.4 Integration

- **Director** (`ax-agents.mjs`) uses the injected planner when present, keeps the deterministic plan
  otherwise, and reports `planner.mode/provider/model/costUsd/fallbackReason`.
- **Research Agent** returns attribution in both the evidence summary and structured fields
  (`url`, `retrievedAt`, `confidence`, `uncertainty`), plus `sources` and `divergences` on the
  envelope.
- **Objective store** persists those attribution fields on each evidence item, so a later reader can
  re-check the URL and retrieval time.
- **Verification Agent** receives the same evidence with URL and timestamp in its context.
- **Memory** writes the verified run with the preserved research sources; the statement names the
  source count and first URL.
- **Transports**: `AX_WEB_RESEARCH_ENABLED=true` mounts web research, composed with repository
  research when `AX_AGENT_LOCAL_ROOT` is set. With neither, the agent still reports
  `capability_unavailable`.
- **Observability**: authenticated `GET /ax/command/agents` now reports the planner mode, provider,
  model, free flag and the shared cost ledger (never a credential).

## 2. Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `NEXUS_MODEL_PLANNING_ENABLED` | off | enables the model planner; without it Director planning is deterministic |
| `NEXUS_PLANNER_PROVIDER` | `openrouter` | only the implemented OpenRouter adapter is accepted |
| `NEXUS_PLANNER_MODEL` | `openrouter/free` | a paid model is refused while free-only is on |
| `NEXUS_FREE_ONLY` | `true` | refuses every non-free call before requesting |
| `NEXUS_TASK_COST_LIMIT_USD` | `0.02` | per-task ceiling |
| `NEXUS_DAILY_COST_LIMIT_USD` | `0.25` | daily ceiling shared by all missions |
| `NEXUS_MODEL_ESTIMATE_USD` | `0.006` | reservation amount per planning call |
| `AX_WEB_RESEARCH_ENABLED` | off | mounts the web research transport |
| `AX_WEB_RESEARCH_ALLOW_LOOPBACK` | off | test-only; never enable in production |
| `AX_AGENT_LOCAL_ROOT` | unset | repository research/engineering transport |

No production value was changed. With `NEXUS_MODEL_PLANNING_ENABLED` unset, the live service keeps
using deterministic planning exactly as in Mission 19.

## 3. Tests and actual results

`tests/ax-mission-20.test.mjs` — **21 tests**, all passing:

- free-only refuses before the provider is called; task ceiling; shared daily ceiling under two
  concurrent reservations; settlement and day rollover;
- deterministic fallback without a model; valid model plan accepted with cost charged; forbidden plan
  refused without retry; provider timeout bounded; strict plan validation;
- OpenRouter free model request shape and zero cost; paid model refused; key absent from the result;
  runtime planner off by default and refuses a paid model;
- private/loopback/link-local/reserved address table; HTTPS/credentials/port/DNS validation;
  redirect-to-private refusal; redirect bound; byte cap with honest truncation; content-type refusal;
  no-URL honesty; conflicting sources preserved and flagged; composite repository + web sources;
- end-to-end: model-planned mission through the real agent runtime and work cycle performs web
  research, persists URL/timestamp, passes independent verification, and writes memory with sources.

Full suite before the final commit: **781/781 pass**, `npm run check` exit 0, release gate pass.

## 4. What is real, and what is deliberately not claimed

- The planning **code path**, validation, fallback, cost enforcement and research pipeline are the
  production modules; tests inject the provider, DNS resolver and HTTP client.
- **No real model call was made in this mission**: no API key exists in this environment, and enabling
  a provider would be a production configuration change. The acceptance demonstration therefore uses
  an injected transport and is labelled as such, not as a live model result.
- **No real website was fetched in this mission**: tests use injected HTTP. The live service does not
  have `AX_WEB_RESEARCH_ENABLED` set.
- Nothing was deployed, and PR #93 remains unmerged.

## 5. Known limitations

1. The daily cost ledger is process-local by default; a restart starts a new daily total. Injecting a
   D1-backed store is the next hardening step.
2. DNS is validated and then re-resolved by the HTTP client, so a determined DNS-rebinding attacker
   could change the answer between check and connection. Mitigation needs a pinned-IP transport with
   custom TLS verification; not implemented.
3. Conflict detection is a polarity heuristic over excerpts, not semantic analysis; it never resolves
   a disagreement.
4. Verification remains keyword coverage, not semantic proof.

## 6. Next engineering objective

1. D1-backed cost ledger so the daily ceiling survives restarts and multiple instances.
2. A pinned-IP web fetch path (SNI/Host preserved) to close the DNS-rebinding window.
3. Live free-model validation after the owner deploys and authorizes
   `NEXUS_MODEL_PLANNING_ENABLED=true` with `openrouter/free`.
4. Then the approval-gated engineering write sandbox (Mission 19 backlog), still behind an explicit
   approval record and never touching the deployed checkout.
