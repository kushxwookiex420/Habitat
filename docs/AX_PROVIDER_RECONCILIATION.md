# AX provider reconciliation

The question: does the "native intelligence" provider duplicate the orchestrator, memory, approval or
cost-governor code? Answer, after reading the modules: **there is no separate native-intelligence
module in this repository.** No file, export or document matches that name. What exists is one
orchestrator and one provider layer that are already separated along a clean seam, plus one leftover
that is not wired to anything.

## What exists

| Concern | Module | Responsibility |
| --- | --- | --- |
| Run lifecycle, planning loop, verification, approval stop | `ax-orchestrator.mjs` (`createAxOrchestrator`) | Owns a run, persists it with compare-and-swap, stops at `needs_approval`, never settles a run it did not verify |
| Model I/O, failover, circuit breaking, timeouts, JSON validation | `ax-providers.mjs` (`createProviderPlanner`, `createFailoverPlanner`, `createAxPlannerFromProviderConfig`) | The only code that calls a model endpoint for planning |
| Durable memory | `ax-memory.mjs` + `d1-ax-memory-repository.mjs` | Approved-memory context, injected into the orchestrator |
| Approval | `ax-approval-gate.mjs` + `ax-treasury.mjs` | Decides what needs the owner; the orchestrator can only *stop* for approval |
| Spend | `ax-cost-governor.mjs` + `d1-ax-cost-ledger-repository.mjs` | Task and daily ceilings, compare-and-swap ledger |

`createAxOrchestrator` **requires** an injected `planner` (`if (!planner || typeof planner.plan !==
"function") throw`), so the orchestrator does not contain a second HTTP client or a second plan
prompt. `device-command-bridge.mjs` wires exactly one planner:

```js
axOrchestrator = createAxOrchestrator({ engine, planner: createAxPlannerFromProviderConfig(...), ... })
```

That is the reconciliation, and it is already correct: one planner implementation, injected.

## The one real duplication

`ax-orchestrator.mjs` also exports `createOpenAiPlanner`, a single-provider planner with its own
prompt and fetch. Nothing in the runtime and no test wires it — the wiring grep finds it only at its
own definition. It duplicates a subset of `ax-providers.mjs` (no failover, no circuit breaker, no
timeout policy, no provider allowlist).

Recommendation, not applied here because deleting an exported function is a public-surface change:
keep it as an explicitly documented fallback for tests, or remove it in a dedicated commit that also
greps the whole tree. Until then it must not be described as the native planning path.

## Guardrails confirmed in the paths that matter

- **Approval is not optional.** A plan containing an approval step makes the run `needs_approval`;
  the orchestrator never submits that step and Ax cannot approve it.
- **Cost is bounded before execution.** The ledger refuses a task above `taskUsd` or the remaining
  `dailyUsd`, and a concurrent writer loses the compare-and-swap rather than overspending.
- **Memory failure does not fail a run.** Missing memory context is recorded, and planning proceeds.
- **Verification is independent.** `verifyResult` reads the task record; a `needs_approval` status is
  reported as such, never as done.

## What this document does not claim

No model call was made to prove any of the above. The claims are about wiring and guards, verified by
reading the code and by the existing test suites (`ax-native-orchestrator`, `ax-orchestrator-lifecycle`,
`ax-providers`, `ax-cost-governor`), not by a live provider round trip, which needs a key.
