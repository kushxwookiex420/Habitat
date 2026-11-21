# Ax ↔ NEXUS: which architecture, and why

Researched 2026-11-21 against OpenAI's own documentation. The answer changed the design, so it is
recorded here rather than assumed.

---

## 1. What OpenAI actually allows today

### Custom GPTs and GPT Actions

> "**New GPT creation and publishing are not available on personal ChatGPT accounts, including Free,
> Go, Plus, and Pro.**"
> — [Creating and editing GPTs](https://help.openai.com/en/articles/9083999), updated 2026-11-21

Actions live **inside** a custom GPT. No GPT creation ⇒ no GPT Action. This is not a Free-plan
limitation that Plus would lift: every personal plan is excluded.

Custom GPTs are also being retired in favour of plugins (`ChatGPT → plugins`, "standard retirement
scheduled for December 11, 2026"; Enterprise new-GPT creation already ended 2026-10-26).

### Custom MCP servers

> "Custom MCP server connections and full MCP support are available for ChatGPT Business and
> Enterprise/Edu customers on ChatGPT web."
> — [Connecting custom MCP servers](https://help.openai.com/en/articles/12584461)

Authentication for a custom MCP server: **OAuth, no authentication, or OAuth-or-none**. ChatGPT
"does **not** support machine-to-machine OAuth grants … nor can it present custom API keys"
([plugin authentication](https://developers.openai.com/plugins/build/auth)). A bearer token like
`HABITAT_AX_COMMAND_TOKEN` cannot be presented to an MCP server.

### Consequence for this account

A personal Free account **cannot** host either path:

| Path | Needs | Available here |
| --- | --- | --- |
| GPT Action (bearer API key) | ability to create a GPT | **no** — excluded on all personal plans |
| Custom MCP server | Business/Enterprise workspace **and** an OAuth authorization server | **no** on both counts |

Mission 03 built and tested the API a GPT Action would call. That work is not wasted — it is the
interface the native agent now uses, and it is ready if a managed workspace ever exists — but no
ChatGPT-side connection can be established from this account today. Saying otherwise would be
building on a feature the user cannot access.

---

## 2. The two architectures

### A. ChatGPT → GPT Action / connector → Habitat → NEXUS

ChatGPT holds the conversation, imports `/ax/command/openapi.json`, submits objectives with a bearer
key, and polls task results.

### B. Habitat-native Ax → Habitat API → NEXUS

Habitat runs its own agent. An objective arrives at `POST /ax/command/runs`; a model plans it into
steps; the orchestrator submits each step through the existing command engine; the NEXUS worker
executes it; the orchestrator verifies the stored evidence and reports.

| | **A. ChatGPT → Habitat** | **B. Habitat-native Ax** |
| --- | --- | --- |
| Account compatibility | **Blocked.** No personal plan can create a GPT; MCP needs Business/Enterprise + OAuth server | **Works with what exists**: the Render service, D1, an OpenAI API key |
| Setup effort | Blocked before it starts; if unblocked: Business workspace, OAuth authorization server, connector review | `OPENAI_API_KEY` + `AX_ORCHESTRATOR_ENABLED=true`; run store created on first run |
| Recurring cost | ChatGPT subscription (Business ≈ $25–30/user/mo) **or** a workspace seat you already have | API tokens only (see §3) + the existing Render/D1 bill |
| API usage | ChatGPT's own model usage, billed to the subscription | Measured per run: prompt/completion tokens × configured prices, recorded on the run |
| Security | The command token is stored in a third-party UI; OpenAI sees every objective and result | The key never leaves the service; objectives and evidence stay in D1 |
| Autonomy | Model-driven but turn-bound: nothing progresses unless a person keeps the conversation going | A run completes on its own once started; a cron can start runs unattended |
| Background operation | None. ChatGPT does not call your API while nobody is chatting | Yes, with the cron executor or the in-process tick |
| No manual relaying | Removes *you* from the loop only while you are in the conversation | Removes you from the loop entirely |
| Owner approvals | Structurally impossible for the command token — good | Same: Ax plans, a step that needs approval is **not submitted**, owner device decides |
| Failure handling | The model decides what to do next, with no bound | Bounded: one corrective step per failed step, budget cap, deadline, recorded reasons |

### Recommendation

**B, Habitat-native Ax.** A is not merely more expensive — it is unavailable on this account, and
even if a workspace existed it would need an OAuth server Habitat does not have. B reuses the
engine, adapters, repository, worker and run storage that already exist, costs a fraction of a cent
per objective, and continues without anyone typing.

A remains a later option for interactive use from a managed workspace. The API it would call is
already built and tested.

---

## 3. Cost

The orchestrator records real token usage per run and prices it with `AX_PRICE_INPUT_PER_MTOK` /
`AX_PRICE_OUTPUT_PER_MTOK`. Defaults are deliberately conservative (**$2.00 in / $10.00 out per 1M**,
the published `gpt-6.1-sol` / `gpt-6.2-sol` rate) so an estimate never understates the bill.

Measured shape of one planning call (from the acceptance test's usage payload, a realistic size):
900 input tokens, 220 output tokens.

| | Tokens | At $2/$10 per 1M | At $0.10/$0.50 per 1M |
| --- | --- | --- | --- |
| One plan | 900 in / 220 out | **$0.0040** | **$0.0002** |
| One repair call | ~600 in / 200 out | $0.0032 | $0.0002 |
| One objective (plan only) | | $0.0040 | $0.0002 |
| One objective with a repair | | $0.0072 | $0.0004 |
| 10 objectives/day (300/mo) | | ≈ **$1.20/mo** | ≈ **$0.06/mo** |

Execution itself costs nothing extra: the adapters are local reads. The infrastructure bill is
unchanged (Render from $1–7/mo, D1 free tier). Prices change; the defaults are a ceiling, and the
run record always shows the token counts so the bill can be recomputed.

`AX_RUN_BUDGET_USD` (default **$0.05**) stops a run before it can spend more, and a plan is capped at
`AX_MAX_STEPS` (default 4).

---

## 4. What is still not live

- No OpenAI API key has been used. The acceptance test stubs the model transport with a fake
  credential and asserts every step **after** the model call with real code.
- No run has been started against a deployed service.
- `OPENAI_API_KEY` must be supplied by the owner (see `docs/AX_NATIVE_ORCHESTRATOR.md` §7).

Nothing in this document claims that Ax has talked to a live model, and nothing claims the ChatGPT
path works — it is documented as unavailable, with the citations above.
