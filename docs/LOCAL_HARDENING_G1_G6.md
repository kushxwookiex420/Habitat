# Local hardening of the P1 capability network (G1–G6)

This records how the gaps in `docs/SECURITY_REVIEW_8CA2B3B.md` §7 were addressed, what changed, and
what is still open. Everything here is local: no deployment, no production change, no supplier
connection, no paid service, no Bridge install or signing, and `NEXUS_RUNTIME_ENABLED` remains off.

## Disposition

| Gap | Status | What changed |
| --- | --- | --- |
| G1 — scheduler not wired | **Closed** | The existing tick now takes an optional `approvalExpiry` provider, sweeps due expiries and emits findings. No second scheduler and no second lease. |
| G2 — reads that settle expiry | **Closed** | `get`, `list` and `pendingCommitments` report an *effective* status and write nothing. Expiry is persisted only by the decision paths and by the tick's sweep. |
| G3 — no per-route rate limit | **Closed (per process)** | The five mutating network routes have their own bucket, `AX_NETWORK_WRITE_RATE_MAX` per `AX_NETWORK_WRITE_RATE_WINDOW_MS`, default 60 per minute. Reads are not in it. |
| G4 — single-tenant by construction | **Open, by design** | No `owner_id`; one Habitat owner. Nothing here changes that, and no shared or multi-tenant use should be attempted. |
| G5 — `capabilityId` is descriptive | **Closed** | `requestApproval` refuses an id that is not in the capability registry with `unknown_capability` (400), before anything is stored. |
| G6 — refunds with two ids | **Closed** | A `refunded`/`reversed` event must name the transaction it reverses (`externalId`), is refused at the ledger if that transaction and amount are already refunded, and is deduplicated again in the summary. |

## G1 — approval-expiry monitoring on the existing scheduler

`ax-scheduler.mjs`

- New optional option `approvalExpiry({ withinMs })` and `approvalExpirySoonMs` (default one hour).
  The scheduler still runs one tick under one lease; this is a callback, not a second loop.
- `approvalExpiryFindings()` turns the report into findings:
  - `approval.expired` (high) with `subject: "approval:<id>"`, the vendor, amount and expiry time;
  - `approval.expiring` (warning) with the minutes remaining;
  - `approval.sweep_incomplete` (warning) naming the rows that changed under the sweep;
  - `approval.monitor_failed` (warning) when the provider throws or reports it cannot read the ledger.
- The tick result carries `approvals: { ok, expired, expiringSoon, failed, withinMs }` (or `null`
  when no provider is configured). `limits` exposes `approvalExpirySoonMs`.
- A monitor failure is a finding, never a failed tick: recovery, message drain and autonomy still run.

`ax-approval-gate.mjs`

- `expiryReport({ withinMs, limit })` lists `requested` rows, expires the due ones through the same
  compare-and-swap `commit(record, "requested")` the decision paths use, and reports what is due
  soon. A lost race is re-read once: an already-`expired` row counts as swept, anything else is
  reported in `failed` rather than overwritten.

`ax-network-service.mjs` — `approvalExpiry({ withinMs })` delegates to `gate.expiryReport`.

`device-command-bridge.mjs` — `resolveScheduler()` passes
`approvalExpiry: ({ withinMs }) => axNetwork?.approvalExpiry({ withinMs }) ?? null`, so the network
ledger is monitored by the scheduler that already runs, and a process without the network mounted
reports nothing.

Not done, deliberately: no new cron expression, no new route, no scheduler state in the approval
ledger, and no expiry-driven decision. Expiry still cannot approve or consume anything.

## G2 — no writes on a read path

`effective(record)` returns `{ status: "expired", expired: true, expiredAt }` for a `requested` row
whose `expiresAt` has passed without touching the store. `get`, `list` and `pendingCommitments` use
it, so:

- `GET /ax/command/network/approvals/:id` is now a pure read;
- `GET .../approvals?status=expired` reports rows the sweep has not reached yet;
- the treasury summary continues to see only `approved`, unconsumed, unexpired commitments.

Persistence still happens where a decision is made (`decide`, `consume`, `cancel` call
`settleExpiry`) and in `expiryReport`. The database therefore converges without a read ever writing.

## G3 — a bounded write bucket for the network

`command-routes.mjs` adds `AX_NETWORK_WRITE_RATE_MAX` / `AX_NETWORK_WRITE_RATE_WINDOW_MS` (default
60 per 60 s), keyed by the verified credential role, applied to the five mutating routes: treasury
event, payout observation, approval request, approve and deny.

- Refusal: `429 network_rate_limited` with `retry-after` and a `security` event (`auth.rate_limited`).
- A malformed override falls back to the default rather than locking the surface out.
- The bucket is per process. Behind N instances the effective limit is N times the configured value;
  that is documented rather than presented as a global quota. Reads stay on the shared command
  limiter only, so a write-heavy caller cannot starve a status poll.

## G5 — capability ids are validated against the registry

`requestApproval` trims `capabilityId`, and if it is present but unknown to
`createCapabilityRegistry` returns `{ ok: false, code: "unknown_capability" }` (mapped to 400) without
creating a row. An omitted id is still allowed and stored as `null`: a request with no capability is
honest about being unbound, and the owner still decides it. A known id is stored and fingerprinted as
before, so it cannot be swapped after approval.

## G6 — refunds are identified, not just recorded

`ax-treasury.mjs`

- `settlementFamily(state)` names the ledger an event belongs to: `cash` for `settled`/`available`,
  `refund` for `refunded`/`reversed`, `null` for pipeline states.
- `validateRevenueEvent` refuses a negative state without `externalId`
  (`refund_reference_required`, 400). Without a referenced transaction, the same refund can arrive
  twice with two ids and two evidence strings and reduce cash twice.
- The summary deduplicates on `family:externalId:amountCents`, so a settled→available transition is
  still one receipt while a refund replay with a new id is rejected as `duplicate_refund`.

`ax-network-service.mjs` — `recordRevenue` also refuses a refund family event whose
`externalId` + `amountCents` is already recorded, with `duplicate_refund` (409). This stops the
duplicate reaching the store; the summary dedupe remains as the backstop for rows written by any
other path. Cash states are deliberately *not* refused at write time: observing `settled` and then
`available` is legitimate, and the summary is where one receipt is counted once.

## Tests added

| File | Covers |
| --- | --- |
| `tests/ax-approval-expiry.test.mjs` | no write on read; one sweep per expiry; warning window; a decision racing the sweep survives; an expired approval cannot be approved |
| `tests/ax-scheduler-approvals.test.mjs` | findings on the existing tick; one lease/one tick; configured window; a throwing monitor is a finding; sweep race reported; no provider = no approval noise |
| `tests/ax-network-recovery.test.mjs` | interrupted seed retried without a poisoned latch; reads never seed; unknown capability refused; idempotent replay; replayed refund refused; unreferenced refund refused; duplicate written by another path deduplicated on read; settled→available counted once |
| `tests/ax-treasury.test.mjs` | refund replay under a new id and different evidence; `refund_reference_required` cases |
| `tests/ax-network-routes.test.mjs` | `unknown_capability` 400; replayed refund 409; per-credential write limit with reads unaffected |

## Still open

1. **G4** — single tenant. Multi-tenant use needs ownership scoping before it is safe.
2. **Deployed behaviour** — the scheduler finding is proven in process, not by a Cron Trigger. See
   `docs/OWNER_DEVICE_AND_ORIGIN_TESTS.md` §5.
3. **D1 behaviour** — migration, CAS and sweep behaviour on real D1 is documented in
   `docs/D1_STAGING_VERIFICATION.md` and not yet run.
4. **Write limit is per process**, not global; a shared quota would need a durable counter.
5. **Expiry of approved-but-unconsumed approvals** is still enforced at consume time, not swept.
   That is intentional: an approved commitment that lapses must not silently become spendable, and
   `pendingCommitments` already excludes it.
