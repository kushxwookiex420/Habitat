# Continuous improvement, wired

The engine (`ax-improvement.mjs`) derives findings from signals the running process already observes,
and it now rides the **existing** scheduler tick rather than adding a second scheduler.

## Path

```
scheduler tick (one lease)
  → improvementFindings()            ax-scheduler.mjs
      → createImprovementMonitor().check()      ax-improvement.mjs
          → improvementPass({ systemStatus, … })  collect + rank
      → severity mapped into the scheduler's vocabulary
  → findings merged, bounded by SCHEDULER_LIMITS.maxFindings
  → the existing bounded notification step (dedupeKey scheduler:<hour>) carries any high finding
```

`server.mjs` supplies the signals (`collectSystemStatus()`), so the findings are about observed state.
`device-command-bridge.mjs` passes them to `createSchedulerService({ improvement })`. With no signals
the scheduler behaves exactly as before and claims nothing.

## Preserved safeguards

| Safeguard | How it is preserved |
| --- | --- |
| Evidence | A finding with no evidence is dropped in `collectFindings`; the scheduler never sees it |
| Deduplication | Deterministic finding ids in the engine; a monitor reports each id once per process |
| Authorisation | No new route and no new credential: the tick already runs under the scheduler lease |
| Cost | The engine performs no model call and no network request; nothing to spend |
| Notification | One existing notification path, unchanged dedupe key and bounded body |
| Failure isolation | A throwing signal source becomes a `warning` finding; the tick still completes |
| No auto-action | Every improvement finding is emitted with `safeAction: null`, so it can never be executed |

## Honest limits

- The dedupe memory is **process-local and bounded** (500 ids). A restart reports a still-present
  condition once more. This is stated in the code and the returned report (`processLocalMemory: true`).
- Warnings do not degrade the tick status; only high/critical do, matching the existing policy.
- Nothing here is deployed: the integration is committed and tested, and becomes live only when a
  staging service runs this branch.
