# Agent capability matrix (Mission 14)

A manifest is not proof of a working agent. This table separates what each agent **is declared to
do**, what it **actually executes in this repository**, and what it **proves**. Source of truth:
`ax-agents.mjs` (`AGENT_MANIFESTS`, `runHandler`) and `ax-agent-transports.mjs`.

**Evidence level: locally implemented and locally tested** (`tests/ax-agents.test.mjs`,
`tests/ax-agent-transports.test.mjs`, `tests/ax-adversarial-transports.test.mjs`). No agent made a
network request or a paid model call in Mission 14.

| Agent | Real transport in code | Available by default | Produces | Cannot do |
| --- | --- | --- | --- | --- |
| **Research** | `createRepositoryResearchTransport` over `AX_AGENT_LOCAL_ROOT`: greps the bounded repository, returns file/line citations | **No** — needs `AX_AGENT_LOCAL_ROOT`; reports `capability_unavailable` otherwise | cited notes with `path:line` | read the internet, invent a citation, leave the root |
| **Engineering** | `createRepositoryEngineeringTransport`: read-only file inspection + `node --check` and up to 3 declared `tests/*.test.mjs` in a sandboxed child process | **No** — same root requirement | change proposal or test evidence | write a file, deploy, run an undeclared command |
| **Security** | inline policy review: adapter allowlist vs registry, dangerous adapter names, permission drift | **Yes** | severity-ranked findings | read credentials, weaken a policy |
| **Operations** | probes the mounted diagnostics (database, memory, providers, scheduler, device bridge, executor) | **Yes** when diagnostics are mounted | health evidence, per-subsystem status | deploy, write the database, buy anything |
| **Memory** | `ax-memory-context` over the approved memory store: retrieval with provenance + citations | **Yes** when the memory store is mounted | cited context; proposals | promote a claim to `verified_fact` (owner only) |
| **Content** | draft/plan generation from campaign inputs | **Yes** | draft plan | publish, contact customers, purchase |
| **Device** | reads the paired device row, recent receipts and pairing state | **Yes** when the device store is ready | device state and capability report | run a device command without the owner |

## How availability is decided

`available(id)` requires the dependency named by the manifest:

| Agent | `requires` |
| --- | --- |
| research | `research` (local transport) |
| engineering | `engineering` (local transport) |
| security | `null` |
| operations | `diagnostics` |
| memory | `memory` |
| content | `null` |
| device | `device` |

An unavailable agent never returns a generic success: it returns
`{ ok:false, code:"capability_unavailable", missingCapability, evidence:[], confidence:0, limitations }`.

## Assignment and evidence recording

- `POST /ax/command/agents/select` returns the deterministic route for an objective.
- `POST /ax/command/agents/delegate` runs the agent, then an Ax review of its output. A rejected
  result raises `agent.permission_violation` in the security log.
- An objective plan names the agent per step. Dispatch attaches the resulting task ids to the
  objective (`execution.tasks`), and the evidence produced by the read-only adapter is appended to
  the objective's evidence list.
- Delegation depth is bounded (max 3) and the chain is recorded, so recursion cannot be used to
  bypass limits.

## Honest gaps

1. **Research is repository research.** It does not browse. Calling it "market research" would be
   false; the Mission 04 correction in `docs/CHATGPT_INTEGRATION.md` applies.
2. **Engineering does not edit code.** It inspects and verifies; a change is still made by the
   operator or a coding agent outside this runtime.
3. **Content never publishes.** Publishing needs a separate owner authorization and the existing
   TikTok/Shopify gates, neither of which this agent can reach.
4. **Device is read-only.** `device.command` requires owner approval and the phone must be paired;
   in this mission no phone was connected.
5. **No agent spends money.** `maxProviderCostUsd` is declared, but no agent transport calls a paid
   model; the objective/orchestrator budget is the only spending path.
