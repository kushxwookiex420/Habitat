import test from "node:test";
import assert from "node:assert/strict";
import {
  CASH_STATES,
  REVENUE_STATES,
  assertSpendable,
  isCashState,
  summarizeTreasury,
  validatePayout,
  validateRevenueEvent
} from "../ax-treasury.mjs";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const OCCURRED = "2026-11-23T10:00:00.000Z";

const event = (id, state, amountCents, extra = {}) => ({
  id,
  state,
  amountCents,
  currency: "USD",
  occurredAt: OCCURRED,
  source: "manual-report",
  ...extra
});

test("estimated, invoiced and collected are pipeline and never cash", () => {
  const summary = summarizeTreasury({
    revenueEvents: [
      event("e1", "estimated", 5000),
      event("e2", "invoiced", 2000),
      event("e3", "collected", 1000)
    ],
    now: NOW
  });
  assert.equal(summary.primary.cashCents, 0);
  assert.equal(summary.primary.settledCents, 0);
  assert.equal(summary.primary.availableCents, 0);
  assert.equal(summary.primary.pipelineCents, 8000);
  assert.equal(summary.primary.availableToSpendCents, 0);
  assert.equal(summary.cashBasis, "settled_and_available_only");
  assert.ok(summary.excludedFromCash.includes("estimated"));
  assert.ok(summary.excludedFromCash.includes("invoiced"));
  assert.ok(summary.excludedFromCash.includes("collected"));
  assert.deepEqual([...CASH_STATES].sort(), ["available", "settled"]);
  assert.equal(summary.rejectedCount, 0);
});

test("only settled and available states are cash", () => {
  for (const state of REVENUE_STATES) {
    assert.equal(isCashState(state), state === "settled" || state === "available", state);
  }
});

test("settled and available amounts count, refunds subtract, and cash can go negative", () => {
  const summary = summarizeTreasury({
    revenueEvents: [
      event("s1", "settled", 4000, { evidence: ["payout_123"] }),
      event("a1", "available", 1000, { evidence: ["statement_2026_11"] }),
      event("r1", "refunded", 1500, { evidence: ["refund_9"], externalId: "refund_9" })
    ],
    now: NOW
  });
  assert.equal(summary.primary.cashCents, 3500);
  assert.equal(summary.primary.availableToSpendCents, 3500);
  assert.equal(summary.primary.refundedCents, 1500);

  const overdrawn = summarizeTreasury({
    revenueEvents: [event("s2", "settled", 100, { evidence: ["payout_1"] }), event("r2", "refunded", 900, { evidence: ["refund_1"], externalId: "refund_1" })],
    now: NOW
  });
  assert.equal(overdrawn.primary.cashCents, -800);
  assert.equal(overdrawn.primary.availableToSpendCents, 0);
  assert.equal(overdrawn.primary.overCommitted, true);
});

test("a settled amount without evidence is rejected, never counted", () => {
  const summary = summarizeTreasury({
    revenueEvents: [
      event("bad", "settled", 999999),
      event("good", "settled", 2000, { evidence: ["payout_7"] })
    ],
    now: NOW
  });
  assert.equal(summary.primary.cashCents, 2000);
  assert.equal(summary.rejectedCount, 1);
  assert.equal(summary.rejectedEvents[0].code, "cash_evidence_required");
});

test("malformed events are rejected with a specific code", () => {
  const cases = [
    [event("x1", "maybe", 100), "invalid_revenue_state"],
    [event("x2", "estimated", 12.5), "invalid_amount"],
    [event("x3", "estimated", -100), "invalid_amount"],
    [event("x4", "estimated", 100, { currency: "US" }), "invalid_currency"],
    [event("x5", "estimated", 100, { occurredAt: "not-a-date" }), "invalid_occurred_at"],
    [event("x6", "estimated", 100, { source: "" }), "revenue_source_required"],
    [{ ...event("x7", "estimated", 100), id: "" }, "revenue_id_required"],
    [event("x8", "refunded", 100, { evidence: ["refund_1"] }), "refund_reference_required"],
    [event("x9", "reversed", 100), "refund_reference_required"]
  ];
  for (const [input, code] of cases) {
    const checked = validateRevenueEvent(input);
    assert.equal(checked.ok, false, code);
    assert.equal(checked.code, code, code);
  }
  const summary = summarizeTreasury({ revenueEvents: cases.map(([input]) => input), now: NOW });
  assert.equal(summary.rejectedCount, cases.length);
  assert.equal(summary.primary.cashCents, 0);
});

test("the same refund cannot be replayed under a second id or a different evidence string", () => {
  const summary = summarizeTreasury({
    revenueEvents: [
      event("s1", "settled", 5000, { evidence: ["payout_9"], externalId: "payout_9" }),
      event("r1", "refunded", 1200, { evidence: ["refund_9", "case_7"], externalId: "refund_9" }),
      event("r2", "refunded", 1200, { evidence: ["case_12"], externalId: "refund_9" }),
      event("r3", "reversed", 1200, { evidence: ["refund_9"], externalId: "refund_9" })
    ],
    now: NOW
  });
  assert.equal(summary.primary.refundedCents, 1200);
  assert.equal(summary.primary.reversedCents, 0);
  assert.equal(summary.primary.cashCents, 3800);
  assert.equal(summary.rejectedCount, 2);
  assert.deepEqual(summary.rejectedEvents.map(item => item.code), ["duplicate_refund", "duplicate_refund"]);
});

test("the same event recorded twice does not double the cash", () => {
  const duplicate = event("dup", "settled", 500, { evidence: ["payout_1"] });
  const summary = summarizeTreasury({ revenueEvents: [duplicate, duplicate], now: NOW });
  assert.equal(summary.primary.cashCents, 500);
  assert.equal(summary.rejectedEvents[0].code, "duplicate_event");
});

test("approved but unconsumed commitments reduce spendable cash; consumed spend drives self-funding", () => {
  const future = new Date(NOW + 60 * 60 * 1000).toISOString();
  const summary = summarizeTreasury({
    revenueEvents: [event("s1", "settled", 4000, { evidence: ["payout_1"] })],
    approvals: [
      { id: "a1", status: "approved", amountCents: 1500, currency: "USD", expiresAt: future, consumedAt: null },
      { id: "a2", status: "approved", amountCents: 1000, currency: "USD", expiresAt: future, consumedAt: "2026-11-23T11:00:00.000Z" },
      { id: "a3", status: "requested", amountCents: 9999, currency: "USD", expiresAt: future }
    ],
    now: NOW
  });
  assert.equal(summary.primary.reservedCents, 1500);
  assert.equal(summary.primary.availableToSpendCents, 2500);
  assert.equal(summary.primary.consumedSpendCents, 1000);
  assert.equal(summary.primary.selfFunding.ratio, 4);
  assert.equal(summary.primary.selfFunding.covered, true);
  assert.equal(summary.pendingApprovals, 1);
});

test("payouts are movement, not revenue, and a bad payout is rejected", () => {
  const summary = summarizeTreasury({
    revenueEvents: [event("s1", "settled", 1000, { evidence: ["payout_1"] })],
    payouts: [
      { id: "p1", state: "in_transit", amountCents: 800, currency: "USD" },
      { id: "p2", state: "paid", amountCents: 200, currency: "USD" },
      { id: "p3", state: "teleported", amountCents: 1, currency: "USD" }
    ],
    now: NOW
  });
  assert.equal(summary.primary.cashCents, 1000);
  assert.equal(summary.primary.payoutsInTransitCents, 800);
  assert.equal(summary.primary.payoutsPaidCents, 200);
  assert.equal(summary.rejectedEvents.some(item => item.id === "p3" && item.code === "invalid_payout_state"), true);
  assert.equal(validatePayout({ id: "p1", state: "paid", amountCents: 1, currency: "USD" }).ok, true);
});

test("currencies are bucketed separately and never summed across", () => {
  const summary = summarizeTreasury({
    revenueEvents: [
      event("u1", "settled", 1000, { evidence: ["payout_usd"] }),
      event("j1", "settled", 5000, { currency: "JPY", evidence: ["payout_jpy"] })
    ],
    now: NOW
  });
  assert.equal(summary.mixedCurrencies, true);
  assert.equal(summary.currencies.USD.cashCents, 1000);
  assert.equal(summary.currencies.JPY.cashCents, 5000);
  assert.equal(summary.primaryCurrency, "USD");
  assert.equal(summary.primary.cashCents, 1000);
});

test("a spend check refuses more than settled cash allows", () => {
  const summary = summarizeTreasury({ revenueEvents: [event("s1", "settled", 1000, { evidence: ["payout_1"] })], now: NOW });
  assert.equal(assertSpendable(summary, { amountCents: 900 }).ok, true);
  const tooMuch = assertSpendable(summary, { amountCents: 2000 });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.code, "insufficient_settled_cash");
  assert.equal(assertSpendable(summary, { amountCents: 0 }).code, "invalid_amount");
  assert.equal(assertSpendable(summary, { amountCents: 100, currency: "EUR" }).code, "unknown_currency");
});

test("an empty treasury still reports a complete primary bucket", () => {
  const summary = summarizeTreasury({});
  assert.equal(summary.primary.currency, "USD");
  assert.equal(summary.primary.cashCents, 0);
  assert.equal(summary.primary.availableToSpendCents, 0);
  assert.deepEqual(summary.primary.selfFunding, { settledGrossCents: 0, spendCents: 0, ratio: null, covered: false });
  assert.equal(summary.mixedCurrencies, false);
});

test("the same payout id is never counted twice", () => {
  const payout = { id: "p1", state: "in_transit", amountCents: 800, currency: "USD" };
  const summary = summarizeTreasury({ payouts: [payout, payout], now: NOW });
  assert.equal(summary.primary.payoutsInTransitCents, 800);
  assert.ok(summary.rejectedEvents.some(item => item.code === "duplicate_payout"));
});

test("settled and available for the same external transaction count once", () => {
  const summary = summarizeTreasury({
    revenueEvents: [
      event("s1", "settled", 1000, { evidence: ["payout_1"], externalId: "txn_1" }),
      event("a1", "available", 1000, { evidence: ["payout_1"], externalId: "txn_1" })
    ],
    now: NOW
  });
  assert.equal(summary.primary.cashCents, 1000);
  assert.ok(summary.rejectedEvents.some(item => item.code === "duplicate_cash_transaction"));
});

test("one payout covering several differently priced orders still counts each order", () => {
  const summary = summarizeTreasury({
    revenueEvents: [
      event("s1", "settled", 1000, { evidence: ["payout_1"], externalId: "payout_1" }),
      event("s2", "settled", 2500, { evidence: ["payout_1"], externalId: "payout_1" })
    ],
    now: NOW
  });
  assert.equal(summary.primary.cashCents, 3500);
  assert.equal(summary.rejectedCount, 0);
});
