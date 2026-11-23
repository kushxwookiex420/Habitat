# AX capability network (P1)

Status: **implemented and tested in-process; not deployed, not connected to any provider.**

P1 is a reporting and approval layer. It answers what the system can do, what a supplier actually is,
whether an order is even permitted on a channel, and what money is real. It stops before every
external action: no purchase, order, transfer, OAuth connection or payout.

## 1. Boundaries

Deliberately absent from P1:

- no supplier OAuth or API call (`apiState` is `unconfigured`/`adapter_missing` everywhere);
- no order, shipment, return or financial-link table — they would have no writer;
- no HTTP route that consumes an approval, places an order or moves money;
- no paid subscription, API credit, purchase or install;
- no `NEXUS_RUNTIME_ENABLED`, no deploy, no PR merge.

Reused rather than duplicated: the existing command engine, scheduler lease, continuity journal,
cost ledger, security-event chain and owner-device verification. The approval ledger is new because
no general approval table existed; `habitat_ax_access_requests` is now the single one, and financial
requests simply leave `capability_id` NULL.

## 2. Modules

| File | Responsibility |
| --- | --- |
| `ax-capability-registry.mjs` | Catalog; derives state from configuration; refuses unsafe entries |
| `ax-fulfillment-catalog.mjs` | Suppliers, fulfillers and automation layers; quote gate |
| `ax-channel-eligibility.mjs` | Per-order channel rules; fail-closed decisions |
| `ax-approval-gate.mjs` | Request → owner decision → single-use consumption |
| `ax-treasury.mjs` | Cash basis, revenue validation, spendable calculation |
| `ax-network-repository.mjs` | Memory and D1 JSON-row stores for eight tables |
| `ax-network-service.mjs` | Composition and seeding; the provider the routes read |
| `scripts/bridge-identity-check.mjs` | P0 read-only Bridge identity check |

## 3. Schema

`migrations/0008_ax_capability_registry.sql`

| Table | Purpose |
| --- | --- |
| `habitat_ax_capabilities` | Registry snapshot, one row per capability |
| `habitat_ax_access_requests` | The only approval ledger; financial rows have `capability_id` NULL |

`migrations/0009_ax_fulfillment_treasury.sql`

| Table | Purpose |
| --- | --- |
| `habitat_ax_suppliers` | Supplier/fulfiller/automation catalog |
| `habitat_ax_supplier_offers` | Per-offer rows (schema ready; no writer in P1) |
| `habitat_ax_channel_rules` | Published eligibility rules |
| `habitat_ax_revenue_events` | Recorded revenue states |
| `habitat_ax_payouts` | Observed payout states |
| `habitat_ax_treasury_accounts` | Account labels and status |

Both migrations are additive: `CREATE … IF NOT EXISTS` only. Nothing existing is altered or dropped,
and the migration check proves a pre-existing cost-ledger row survives the upgrade.

## 4. Routes

All are under `/ax/command/network`, require the Ax credential, and answer `503
network_not_configured` when the service is not mounted. None appear in the ChatGPT-facing OpenAPI
document.

| Method | Path | Credential |
| --- | --- | --- |
| GET | `/status` | Ax |
| GET | `/capabilities` | Ax |
| GET | `/suppliers` | Ax |
| GET | `/suppliers/:id` | Ax |
| POST | `/suppliers/fit` | Ax |
| GET | `/channels` | Ax |
| POST | `/channels/eligibility` | Ax |
| GET | `/treasury` | Ax |
| GET | `/treasury/events` | Ax |
| POST | `/treasury/events` | Ax for pipeline; **owner device** for `settled`/`available` |
| GET | `/treasury/payouts` | Ax |
| POST | `/treasury/payouts` | **owner device** |
| POST | `/approvals` | Ax (request only) |
| GET | `/approvals` | Ax |
| GET | `/approvals/:id` | Ax |
| POST | `/approvals/:id/approve` | **owner device** |
| POST | `/approvals/:id/deny` | **owner device** |

`POST /treasury/payouts` records an *observation* of a payout a channel already made. It cannot
initiate, change or cancel one.

## 5. Approval model

```
request(kind, binding)  ->  status: requested
        |
        +-- owner device --approve--> approved
        |                     |
        |                     +-- consume(executionKey, exact binding) --> consumed
        |
        +-- owner device --deny-----> denied (terminal)

requested --ttl elapsed--> expired (terminal, never revived)
```

- **Who may request:** any authenticated internal actor (`ax`, `nexus`, scheduler).
- **Who may decide:** only an actor whose identity begins `owner:`. `ax`, `nexus`, `scheduler`,
  `system`, the command token and an empty identity are refused with `owner_required`, and the
  refusal names the actor *class*, never a credential.
- **Purchase binding:** supplier, items (sku + quantity), item cost, shipping, tax, currency,
  destination, quote id and quote expiry. Every one is required; a missing field is listed back.
- **Quote freshness:** an already-expired quote is refused, and a quote window over 24 hours is
  refused.
- **Duplicates:** a second *open* request with the same fingerprint is refused with
  `duplicate_request` and the existing id. An `idempotencyKey` replays the same row.
- **Consumption:** single use, tied to an `executionKey`; a different amount, currency, vendor or
  destination is `approval_binding_mismatch`. Replaying the same key is idempotent.
- **Secrets:** a request containing a token, key or private-key marker is refused outright.
- **No execution:** `externalActionPerformed` is always `false`. `consume` exists in the module for
  the P2 executor and is deliberately not exposed as a route, because burning an approval with no
  purchase would be worse than leaving it unused.

## 6. Channel eligibility

Decisions are `ALLOW`, `MANUAL_REVIEW` or `DENY`. In P1 `ALLOW` requires an owner-supplied
`approvalReference` plus `documentedProgramApproval: true`; otherwise a non-prohibited combination
is `MANUAL_REVIEW`.

| Rule | Channel | Decision |
| --- | --- | --- |
| Seller must own and maintain inventory | TikTok Shop US | DENY |
| No direct shipment from an international third-party supplier | TikTok Shop US | DENY |
| No retail arbitrage or falsified tracking | TikTok Shop US | DENY |
| Seller of record must fulfil | Amazon marketplace | DENY |
| MCF fulfils seller-owned FBA inventory only | Amazon MCF | DENY |
| MCF is for off-Amazon orders | Amazon MCF | MANUAL_REVIEW |
| Retail arbitrage is refused on every channel | all | DENY |
| Account-level eligibility is unverified | all | MANUAL_REVIEW |

Unknown channel, unknown ownership or unknown fulfilment model is `DENY insufficient_evidence`.
`automatedFulfillment` and `automatedPurchase` are always `false`, and `stopsAtLiveQuote` is always
`true`.

## 7. Fulfillment catalog

The catalog separates four things that are routinely conflated:

- **Supplier** — owns or sources goods: Alibaba (wholesale/MOQ), AliExpress, CJdropshipping,
  Zendrop, Spocket.
- **Fulfiller / 3PL** — stores and ships: Printful (POD), Amazon MCF (seller-owned only).
- **Automation** — forwards orders, owns no stock: DSers, Syncee. Neither may be treated as a
  supplier, and `evaluateSupplierFit` refuses them by name.
- **Marketplace** — Fulfilled by TikTok, seller-owned inventory.

Every entry is `verification: "unverified"`, `connected: 0`, and every evaluation returns
`externalCallPerformed: false`, `orderSubmitted: false`. The furthest an evaluation goes is
`REQUIRES_LIVE_QUOTE`, naming the fields a real quote would have to return.

## 8. Treasury basis

Only `settled` and `available` count as cash. `estimated`, `invoiced` and `collected` are pipeline
and are reported separately; `refunded` and `reversed` subtract from cash.

- Amounts are **integer cents**. A float, a negative or an unknown state is rejected, not rounded.
- A `settled`/`available` event **requires evidence** (payout id, settlement reference or statement
  line). Without it the event is rejected with `cash_evidence_required` and never counted.
- A repeated event id is refused so a retry cannot double the cash.
- Currencies are bucketed and never summed across.
- `availableToSpend = cash − approved-unconsumed commitments`, clamped at zero and flagged
  `overCommitted` when the true figure is negative.
- Cash may legitimately be negative after a refund exceeds settled revenue; that is reported rather
  than hidden.
- `selfFunding` compares settled gross revenue with consumed spend; `ratio` is `null` when nothing
  has been spent.

## 9. Cloud-first operation

The layer is an ordinary HTTP surface in the server process. Research, monitoring, scheduling and
reporting therefore run on the server with no phone attached. The phone is required only for the two
things that are genuinely owner actions: deciding an approval and asserting that money is settled.

When D1 credentials are present the eight tables are durable; without them the process uses an
in-memory store and reports `durable: false` rather than pretending.

## 10. Verification

- `npm run check` — exit 0 (syntax, including every new module and test).
- `npm run migrations:check` — 45/45 checks, in-memory SQLite (not D1).
- `npm test` — 922 pass, 0 fail.
- New suites: `ax-capability-registry`, `ax-channel-eligibility`, `ax-fulfillment-catalog`,
  `ax-treasury`, `ax-approval-gate`, `ax-network-routes`, `bridge-identity-check`.

Not verified: D1 itself, any real supplier quote, any channel account, the installed device identity,
and every provider's live eligibility.

## 11. Deliberate deviation from the P1 sketch

The architecture sketch listed order, shipment, return and financial-link tables in `0009`. They are
not created. P1 has no writer for them, and empty tables would imply a capability this deployment
does not have. They belong with the P2 execution work that can actually create an order.
