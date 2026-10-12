# Habitat Operating System: Original Design

## Product direction

Habitat is an independent, free-first operations system for Ax and the user's projects. It may learn from common product patterns in other tools, but its architecture, interface, policies, and workflows are Habitat-owned. Do not add a paid dependency or migrate platforms just to imitate another product.

## Operating loop

Every meaningful job follows the same inspectable lifecycle:

1. **Intake** — normalize the request, project, desired outcome, constraints, and deadline.
2. **Plan** — break work into bounded steps and identify tools, costs, and permissions needed.
3. **Gather evidence** — read current source systems; attach source, timestamp, and freshness.
4. **Validate** — run policy checks, input validation, profit/media/release gates, and duplicate detection.
5. **Propose** — produce a concise plan and exact external changes before any protected mutation.
6. **Approve** — require explicit user approval for publishing, spending, price changes, order/fulfillment changes, customer messaging, or other irreversible external actions.
7. **Execute** — use least-privilege credentials, idempotency keys, bounded retries, and timeouts.
8. **Verify** — re-read the source system and compare actual state with intended state.
9. **Record** — save result, evidence, cost, elapsed time, retries, and any rollback instructions.

A job is not complete merely because a model answered, an API accepted a request, or a worker returned success. Completion requires a verifiable postcondition. If verification is unavailable, mark the result **UNKNOWN**, not PASS.

## Status vocabulary

Use a small consistent set of statuses across Android, backend, and integrations:

- **PASS** — fresh evidence confirms the expected state.
- **HOLD** — a policy, safety, profit, permission, or validation gate blocked the action.
- **FAIL** — an operation or assertion failed with evidence.
- **UNKNOWN** — evidence is missing, stale, or inconclusive.
- **STALE** — evidence exists but is older than the configured freshness window.
- **PENDING APPROVAL** — proposal is ready; no external mutation has happened.
- **RUNNING** — work is active and has a deadline/heartbeat.
- **CANCELLED** — safely stopped by user or policy.

Never render a missing integration as healthy. Distinguish configured, authenticated, authorized, reachable, and end-to-end verified.

## Original Habitat surfaces

### Ax Command Center
A phone-first overview of active projects, recent outcomes, worker/task status, blockers, integration health, and the next best action. Keep the top screen actionable rather than decorative. Every status links to the evidence and last checked time.

### Approval Inbox
Each proposal shows: exact action, target account/store, evidence, expected upside, downside/risk, estimated cost, reversibility, and expiry. Approval applies only to that proposal and expires if material inputs change. A reject option should capture a reason for future planning.

### Evidence Ledger
Append-only event timeline for important decisions and mutations. Each entry includes project, task ID, actor, timestamp, source references, before/after summary, policy result, and verification status. Redact tokens, credentials, and unnecessary customer data.

### Capability Cards
Every worker/tool declares allowed projects, readable resources, permitted actions, spending ceiling (default zero), rate limit, timeout, retry limit, and actions that always require approval. Deny by default when a capability is absent or unclear.

### Outcome Lab
Track actual business results rather than model confidence alone: estimated versus realized margin, refunds/returns, fulfillment latency, content rejection rate, successful publish rate, worker retries, provider latency, and API/model spend. Use evidence-backed cohorts and avoid calling a product profitable until enough real orders and costs are reconciled.

### Recovery Desk
Detect stuck jobs, expired leases, duplicate requests, stale integration credentials, failed health checks, and partial operations. Prefer idempotent resume or safe cancellation; never blindly replay an order, payment, publish, or fulfillment mutation.

## Business-specific gates

### Product and profit gate
A candidate is HOLD unless current supplier price, shipping, platform/payment fees, commissions, taxes/returns assumptions, and other variable costs are present with dated evidence. Show both estimated contribution per order and net-margin assumptions. Recalculate immediately before approval. Unknown costs are not zero. Do not auto-publish a listing or change live pricing.

### Order and fulfillment gate
Before any fulfillment request, verify paid status, fulfillment status, line items, supplier mapping, address/variant requirements, duplicate request history, and supplier price/shipping parity. Use a durable idempotency key. If order state changed or parity cannot be verified, HOLD for human review. Never retry a possibly accepted request without checking the supplier/source system first.

### Media and publishing gate
Run format, dimensions, duration, audio, text-safe-area, scene-change, narration-completeness, rights/source, and platform-specific checks on the final rendered artifact. Store a hash of the exact approved file. Any change to file or caption invalidates approval. Upload/publish stays disabled unless the relevant account is authenticated and the user approved the exact final artifact.

## Reliability and cost policy

- Free-first model routing; do not treat a configured key as proof of available quota.
- Use deterministic code for math, validation, idempotency, and permissions; use models for research, synthesis, and bounded planning.
- Cap per-task attempts, runtime, output size, and spend. Default spend limit is $0 unless explicitly configured.
- Cache only where freshness permits; display source age.
- Use contract tests and failure injection for stale data, missing permissions, duplicate events, timeouts, provider quota errors, and partial completion.
- A fallback must preserve the same policy gates; it may not bypass a failed safety or profit check.

## Delivery sequence

### P0 — protect money and external state
1. Validate the current order before fulfillment and block duplicates.
2. Reconcile supplier price/shipping with the actual order and fees.
3. Connect media preflight to the real draft/publish workflow.
4. Make all publish/order/price/spend actions approval-gated.
5. Expose honest health and verification status.

### P1 — make work inspectable
1. Add a unified status/approval API with stable task IDs.
2. Show status, last checked time, evidence, and blocker on Android.
3. Persist event history and approval decisions with access controls.
4. Add stuck-task detection and safe recovery.

### P2 — improve quality and economics
1. Add bounded worker capability policies and idempotency.
2. Add final-artifact visual/audio QA and release checks.
3. Measure provider costs, task success, actual margin, and refund outcomes.
4. Route to the lowest-cost capable provider without weakening checks.

### P3 — optimize from measured outcomes
Use real outcome data to rank product candidates and content experiments. Keep small, reversible experiments and approval gates. Do not optimize for raw listing count, views, or model confidence when those metrics do not correlate with profitable completed orders.

## Definition of done

A feature is not done until:
- automated tests cover normal, invalid, stale, unauthorized, duplicate, timeout, and partial-failure paths;
- CI passes on the exact commit;
- UI states PASS/HOLD/FAIL/UNKNOWN accurately;
- logs/evidence are useful without leaking secrets;
- no production behavior is claimed without a live check;
- rollback and user approval boundaries are documented.

## Non-goals

- No copying proprietary source code, assets, or branding from other tools.
- No platform migration or paid service by default.
- No unattended spending, live price changes, customer messaging, fulfillment, or publishing.
- No claiming profit or successful delivery from estimates or API acceptance alone.
