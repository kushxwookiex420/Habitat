# Second-pass review — commit `8ca2b3b`

Subject: `ax: add P0 bridge reconciliation and the P1 capability network`
Branch: `nexus/ax-capability-network-p0-p1`, parent `b2eec80`
Method: source review of every changed file, targeted adversarial tests, a fresh in-memory SQLite
replay of the migrations, and a global `fetch` trap around every new service method.

No deployment, merge, push to production, account connection, spend, Bridge signing change or
`NEXUS_RUNTIME_ENABLED` change was performed.

## 1. Verdicts on the ten requested checks

| # | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Correct authentication, owner authorization, permission boundaries on every new route | **Pass, with one fix** | 17 routes, all behind `requireAx`; 4 owner-device actions; refund/reversal were agent-writable and are now owner-only (D4) |
| 2 | Parameterized SQL and ownership boundaries | **Pass** | Every statement uses `?`; table and column names come from a frozen definition map; unknown filter keys are dropped, not interpolated |
| 3 | Approvals cannot be replayed, modified or consumed by an unauthorized actor | **Pass, with two fixes** | Owner-class check, exact-binding consume, single-use; concurrency was last-writer-wins and is now compare-and-swap (D5); cancel could revive an expired row (D6) |
| 4 | Treasury cannot double-count revenue, payouts or refunds | **Pass, with two fixes** | Per-event id dedupe existed; payout ids were not deduped (D2) and a settled→available transition double-counted (D3). Both fixed and tested |
| 5 | No estimated/invoiced/collected revenue becomes spendable cash | **Pass** | `CASH_STATES` is exactly `settled`+`available`; pipeline is a separate total; `assertSpendable` reads only `availableToSpendCents`; refunds/reversals reduce cash and can never add it |
| 6 | Migrations 0008/0009 roll back and preserve existing data | **Pass** | `npm run migrations:rollback` — 11/11 checks, schema restored to the exact pre-0008 object list |
| 7 | Correct use of existing D1 repository and scheduler infrastructure | **Partial** | D1: correct, reuses `createD1Query` and the `record_json` + indexed-column pattern. Scheduler: **not wired** — expiry is enforced lazily on read/decide/consume. See gap G1 |
| 8 | Discovery cannot silently activate a paid service, OAuth integration or side effect | **Pass** | No discovery stage exists in P1; every gated capability is non-available and approval-gated; a global `fetch` trap recorded zero calls across all service methods |
| 9 | Bridge identity script cannot execute unintended device modifications | **Pass, with one fix** | Command allowlist refuses every mutating verb before execution; shell is limited to `dumpsys`/`getprop`; `execFileSync` array form means no shell injection; signature parsing could fingerprint the wrong certificate (D7) |
| 10 | New functionality documented in the OpenAPI contract | **Pass by exclusion, deliberate** | All 105 routes are classified: 10 documented, 95 excluded with a reason. The 17 network routes are excluded from the ChatGPT-facing document because they expose approvals and treasury; they are documented in `docs/AX_CAPABILITY_NETWORK.md` and enforced by `compareSpecToRoutes` |

## 2. Route-by-route security

`Ax` = `HABITAT_AX_BRIDGE_TOKEN` or `HABITAT_AX_COMMAND_TOKEN`. `Owner` = Ax credential **plus** a
paired owner device id and device token verified against the device repository.

| Method | Route | Required | Notes | Covered by |
| --- | --- | --- | --- | --- |
| GET | `/ax/command/network/status` | Ax | Read-only counters; no secret | routes test |
| GET | `/ax/command/network/capabilities` | Ax | State derived from config; no value echoed | routes, registry tests |
| GET | `/ax/command/network/suppliers` | Ax | Static catalog | routes test |
| GET | `/ax/command/network/suppliers/:id` | Ax | 404 for unknown | catalog test |
| POST | `/ax/command/network/suppliers/fit` | Ax | No side effect; refuses a fulfiller | routes test |
| GET | `/ax/command/network/channels` | Ax | Rules only | routes test |
| POST | `/ax/command/network/channels/eligibility` | Ax | Fail-closed; `automatedPurchase` always false | routes, eligibility tests |
| GET | `/ax/command/network/treasury` | Ax | Cash basis stated in the payload | routes test |
| GET | `/ax/command/network/treasury/events` | Ax | Recorded events | treasury tests |
| POST | `/ax/command/network/treasury/events` | Ax for `estimated`/`invoiced`/`collected`; **Owner** for `settled`/`available`/`refunded`/`reversed` | D4 fix | routes test |
| GET | `/ax/command/network/treasury/payouts` | Ax | Observations | routes test |
| POST | `/ax/command/network/treasury/payouts` | **Owner** | Records an observation; cannot move money | routes test |
| POST | `/ax/command/network/approvals` | Ax | Raises a request; `requestedBy` taken from the credential | approval, routes tests |
| GET | `/ax/command/network/approvals` | Ax | List; settles expiry | approval test |
| GET | `/ax/command/network/approvals/:id` | Ax | Settles expiry (bounded write) | approval test |
| POST | `/ax/command/network/approvals/:id/approve` | **Owner** | Command token refused before device check | routes, gate tests |
| POST | `/ax/command/network/approvals/:id/deny` | **Owner** | Same | routes test |

No route consumes an approval, creates an order, transfers money or starts OAuth. A test asserts
those paths are unregistered.

## 3. Defects found and fixed

| Id | Severity | Defect | Fix | Regression test |
| --- | --- | --- | --- | --- |
| D1 | High | A quiet treasury returned a `primary` bucket without `currency` or `selfFunding`, so `primary.selfFunding.ratio` threw on an empty ledger | The fallback bucket is built complete | `ax-treasury`: "an empty treasury still reports a complete primary bucket" |
| D2 | High | `summarizeTreasury` summed payouts without deduplicating ids, so one payout supplied twice counted twice | Payout ids are deduplicated; the second is reported as `duplicate_payout` | `ax-treasury`: "the same payout id is never counted twice" |
| D3 | High | A `settled` event and an `available` event for the same transaction both counted, doubling cash | Cash is deduplicated on `externalId` + amount; the second is `duplicate_cash_transaction`. A payout covering several differently priced orders still counts each | `ax-treasury`: "settled and available for the same external transaction count once", "one payout covering several differently priced orders still counts each order" |
| D4 | Medium-High | The Ax command token could post `refunded`/`reversed`, fabricating a loss and depressing reported cash | Cash-affecting states are owner-only | `ax-network-routes`: "an agent cannot post a refund" |
| D5 | Medium | Approval transitions used a plain write, so a concurrent approve and deny — or two consumptions — could both succeed | Compare-and-swap on `status` in both stores; the loser gets `approval_conflict` (409) | `ax-network-concurrency`: 2 tests |
| D6 | Medium | `cancel` rewrote an expired approval to `cancelled`, making it look live again | Expired requests refuse cancellation | `ax-network-concurrency`: "an expired request cannot be cancelled back to life" |
| D7 | Low-Medium | The signature regex used a cross-line greedy prefix, so a `signatures=` line without a bracket could hash a later line's value and report a confidently wrong identity | Prefix restricted to the current line; no match yields `null` | `bridge-identity-check`: "a signature block without a same-line certificate yields no fingerprint" |

## 4. Verified non-defects

- **SQL injection:** every value is a `?` parameter. Identifiers come from `DEFINITIONS`, and a filter
  key absent from `definition.filters` is skipped rather than concatenated.
- **Credential leakage:** capability state is derived from key *presence*; the missing-key message
  names variables; the review test serialises the whole registry and asserts a configured secret does
  not appear.
- **No external calls:** `globalThis.fetch` was replaced with a throwing stub, every service method
  was exercised, and the call count was zero — with an explicit repository and with no D1 credentials.
- **Approval binding:** amount, currency, vendor and destination are compared exactly; a mismatch is
  `approval_binding_mismatch`. Metadata is excluded from the binding, so changing it cannot widen an
  approval.
- **Secret material in a request:** refused with `secret_material_refused`.
- **Duplicate open request:** refused with the existing id, so an approval cannot be silently doubled.
- **Bridge injection:** a device id containing `;` is passed as one argv element to `execFileSync`
  with no shell, and no mutating verb is ever emitted.

## 5. Migration rollback evidence

`npm run migrations:rollback` (11/11 checks):

1. Apply migrations through 0007.
2. Insert a command task, a cost-ledger row and an objective.
3. Apply 0008 and 0009; insert a capability, an approval and a revenue event.
4. Run `DROP TABLE IF EXISTS` for the eight P1 tables in reverse creation order.
5. Assert every P1 table is gone and the `sqlite_master` object list equals the pre-0008 snapshot
   exactly (no missing, no extra object).
6. Assert all three pre-existing rows are unchanged.
7. Re-apply 0008/0009 and assert the tables return empty and the legacy rows are still intact.

**Rollback is destructive to P1 data.** Dropping the tables discards capability snapshots, approvals,
revenue events, payouts and supplier rows. Operators must export them first. Tables created before
0008 — tasks, memory, notifications, objectives, incidents, security events, scheduler, messages,
cost ledger — are not referenced by the rollback plan, and a test asserts the plan only ever drops the
eight P1 tables.

## 6. OpenAPI position

The contract model is "documented or excluded with a reason". The 17 network routes are excluded
because they expose an approval ledger and a treasury report to a surface a language model drives.
Exclusion is not invisibility: the reason is a rule in `scripts/ax-openapi-contract.mjs`, the parity
check fails if a new route is neither documented nor excluded, `docs/AX_CAPABILITY_NETWORK.md`
documents every route with its credential, and route tests cover each one.

## 7. Gaps not fixed (reported, not hidden)

> Follow-up: G1, G2, G3, G5 and G6 were closed locally after this review; G4 remains open by design.
> See `docs/LOCAL_HARDENING_G1_G6.md` for the change and the tests. The text below is the state as
> reviewed at `8ca2b3b`.

- **G1 — scheduler not wired.** Approval expiry is enforced at read/decide/consume time, which is
  fail-closed, but no scheduler tick produces a proactive "approval expiring" finding. The existing
  scheduler already reports expired *objective* approvals; extending it to the network ledger is the
  natural follow-up.
- **G2 — reads that settle expiry.** `GET /approvals` and `GET /approvals/:id` persist an `expired`
  transition. It is bounded and idempotent, but it is a write on a read path.
- **G3 — no per-route rate limit.** Network routes share the existing per-credential command limiter.
  A dedicated limit for approval and treasury writes would be tighter.
- **G4 — single-tenant by construction.** There is no `owner_id` column. Every row belongs to the one
  Habitat owner. A multi-tenant deployment would need ownership scoping before any shared use.
- **G5 — `capabilityId` is descriptive.** A request may name an unknown capability; authorization does
  not depend on it (the owner decides), but it is not validated against the registry.
- **G6 — refunds with two ids.** The same refund recorded twice under different event ids cannot be
  detected. Unique evidence ids at the ingestion boundary are the mitigation.

## 8. Remaining verification before production or device use

1. **D1 rehearsal:** run 0008/0009 against a staging D1, export the P1 tables, rehearse the drop, and
   compare row counts and the schema before and after. The local check proves SQL compatibility, not
   D1 behaviour.
2. **Owner-device flow on a real deployment:** complete a sign-in, an approval and a refusal from a
   non-owner device, against the deployed origin.
3. **Device identity:** run `node scripts/bridge-identity-check.mjs` with the phone attached. Until
   then the installed app identity is unverified; `adb_unavailable` is not a pass.
4. **Network egress:** confirm the deployed process makes no supplier call. P1 has none, but the
   production network policy is the real proof.
5. **Scheduler follow-up (G1)** before relying on proactive expiry warnings.
