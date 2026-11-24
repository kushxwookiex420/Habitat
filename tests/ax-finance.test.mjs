import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFinance, summarizeFinanceFile, validateAsset, validateExpense, validateLiability } from "../ax-finance.mjs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const OCCURRED = "2026-11-20T10:00:00.000Z";

const revenue = (id, state, amountCents, extra = {}) => ({
  id,
  state,
  amountCents,
  currency: "USD",
  occurredAt: OCCURRED,
  source: "tiktok-settlement",
  evidence: ["payout_2026_11_20"],
  externalId: "payout_" + id,
  ...extra
});

const expense = (id, amountCents, extra = {}) => ({
  id,
  amountCents,
  currency: "USD",
  state: "paid",
  occurredAt: OCCURRED,
  category: "software",
  source: "card statement 2026-11",
  evidence: ["statement_2026_11_line_4"],
  ...extra
});

const asset = (id, valueCents, extra = {}) => ({
  id,
  label: "Verified balance",
  kind: "cash",
  valueCents,
  currency: "USD",
  valuationAt: OCCURRED,
  evidence: ["bank_statement_2026_11"],
  ...extra
});

const liability = (id, amountCents, extra = {}) => ({
  id,
  label: "Card balance",
  kind: "payable",
  amountCents,
  currency: "USD",
  evidence: ["statement_2026_11"],
  ...extra
});

test("profit and cash flow come from evidenced cost against cash revenue", () => {
  const summary = summarizeFinance({
    revenueEvents: [revenue("r1", "available", 5000)],
    expenses: [expense("e1", 2000)],
    now: NOW
  });
  assert.equal(summary.primary.revenueCents, 5000);
  assert.equal(summary.primary.expensesPaidCents, 2000);
  assert.equal(summary.primary.profitCents, 3000);
  assert.equal(summary.primary.marginPct, 60);
  assert.equal(summary.primary.netCashFlowCents, 3000);
  assert.equal(summary.rejectedCount, 0);
});

test("an expense without evidence is rejected and never subtracted", () => {
  const summary = summarizeFinance({
    revenueEvents: [revenue("r1", "available", 5000)],
    expenses: [{ ...expense("e1", 9999), evidence: [] }],
    now: NOW
  });
  assert.equal(summary.primary.expensesPaidCents, 0);
  assert.equal(summary.primary.profitCents, 5000);
  assert.equal(summary.rejectedCount, 1);
  assert.equal(summary.rejected[0].code, "expense_evidence_required");
});

test("an unverified asset is a claim and never contributes to net worth", () => {
  const summary = summarizeFinance({
    assets: [{ id: "a1", label: "Unsold inventory", kind: "inventory", valueCents: 12000, currency: "USD" }],
    now: NOW
  });
  assert.equal(summary.primary.claimedAssetsCents, 12000);
  assert.equal(summary.primary.verifiedAssetsCents, 0);
  assert.equal(summary.primary.verifiedNetWorthCents, 0);
  assert.equal(summary.primary.claimedNetWorthCents, 12000);
  assert.equal(summary.unverifiedAssetValueCents, 12000);
});

test("verified assets minus evidenced liabilities is the only net worth reported", () => {
  const summary = summarizeFinance({
    assets: [asset("a1", 10000), { id: "a2", label: "Laptop", kind: "equipment", valueCents: 2000, currency: "USD" }],
    liabilities: [liability("l1", 4000)],
    now: NOW
  });
  assert.equal(summary.primary.verifiedAssetsCents, 10000);
  assert.equal(summary.primary.liabilitiesCents, 4000);
  assert.equal(summary.primary.verifiedNetWorthCents, 6000);
  assert.equal(summary.primary.claimedNetWorthCents, 8000, "the unverified laptop is only a claim");
});

test("a liability without evidence is refused outright", () => {
  const checked = validateLiability({ id: "l1", label: "Loan", kind: "loan", amountCents: 100, currency: "USD" });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, "liability_evidence_required");
});

test("a period excludes out-of-period costs without hiding them", () => {
  const summary = summarizeFinance({
    revenueEvents: [revenue("r1", "available", 5000)],
    expenses: [expense("e1", 2000), expense("e2", 800, { occurredAt: "2026-10-01T00:00:00.000Z" })],
    period: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z" },
    now: NOW
  });
  assert.equal(summary.primary.expensesPaidCents, 2000);
  assert.equal(summary.outOfPeriodCount, 1);
});

test("recurring cost contributes a monthly run rate, not a guess", () => {
  const summary = summarizeFinance({
    expenses: [
      expense("e1", 500, { cadence: "monthly" }),
      expense("e2", 1200, { cadence: "annual", state: "scheduled" })
    ],
    now: NOW
  });
  assert.equal(summary.primary.monthlyRunRateCents, 600, "500 monthly + 1200/12 annual");
  assert.equal(summary.primary.expensesPaidCents, 500);
  assert.equal(summary.primary.expensesDueCents, 1200);
});

test("pipeline revenue is not profit", () => {
  const summary = summarizeFinance({ revenueEvents: [revenue("p1", "estimated", 9000)], now: NOW });
  assert.equal(summary.primary.revenueCents, 0);
  assert.equal(summary.primary.pipelineCents, 9000);
  assert.equal(summary.primary.profitCents, 0);
});

test("refunds reduce revenue and profit", () => {
  const summary = summarizeFinance({
    revenueEvents: [revenue("r1", "available", 5000), revenue("r2", "refunded", 1500, { externalId: "refund_1" })],
    now: NOW
  });
  assert.equal(summary.primary.revenueCents, 3500);
  assert.equal(summary.primary.refundsCents, 1500);
  assert.equal(summary.primary.profitCents, 3500);
});

test("currencies are separated and never summed together", () => {
  const summary = summarizeFinance({
    revenueEvents: [revenue("r1", "available", 5000)],
    expenses: [expense("e1", 2000, { currency: "EUR", evidence: ["eu_statement"], source: "eu card" })],
    now: NOW
  });
  assert.equal(summary.mixedCurrencies, true);
  assert.equal(summary.primary.revenueCents, 5000);
  assert.equal(summary.primary.expensesPaidCents, 0);
  assert.equal(summary.byCurrency.EUR.expensesPaidCents, 2000);
});

test("a duplicate expense id is rejected, not double counted", () => {
  const summary = summarizeFinance({ expenses: [expense("e1", 1000), expense("e1", 1000)], now: NOW });
  assert.equal(summary.primary.expensesPaidCents, 1000);
  assert.equal(summary.rejected[0].code, "duplicate_expense");
});

test("validators refuse malformed money and missing provenance", () => {
  assert.equal(validateExpense({ id: "x", amountCents: 12.5, currency: "USD", occurredAt: OCCURRED, source: "s", evidence: ["e"] }).code, "invalid_amount");
  assert.equal(validateExpense({ id: "x", amountCents: 100, currency: "US", occurredAt: OCCURRED, source: "s", evidence: ["e"] }).code, "invalid_currency");
  assert.equal(validateExpense({ id: "x", amountCents: 100, currency: "USD", occurredAt: "nope", source: "s", evidence: ["e"] }).code, "invalid_occurred_at");
  assert.equal(validateExpense({ id: "x", amountCents: 100, currency: "USD", occurredAt: OCCURRED, source: "", evidence: ["e"] }).code, "expense_source_required");
  assert.equal(validateAsset({ id: "a", label: "x", kind: "magic", valueCents: 1, currency: "USD" }).code, "invalid_asset_kind");
  assert.equal(validateExpense({ id: "e", amountCents: 100, currency: "USD", occurredAt: OCCURRED, source: "s", evidence: ["x"], cadence: "hourly" }).code, "invalid_cadence");
});

test("an empty ledger reports a complete zero-valued position, not an error", () => {
  const summary = summarizeFinance({ now: NOW });
  assert.equal(summary.ok, true);
  assert.equal(summary.primary.profitCents, 0);
  assert.equal(summary.primary.marginPct, null);
  assert.equal(summary.primary.verifiedNetWorthCents, 0);
  assert.equal(summary.rejectedCount, 0);
});

test("the file loader summarises an exported ledger", () => {
  const summary = summarizeFinanceFile({
    revenueEvents: [revenue("r1", "available", 1000)],
    expenses: [expense("e1", 250)],
    assets: [asset("a1", 500)],
    liabilities: [liability("l1", 100)]
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.primary.profitCents, 750);
  assert.equal(summary.primary.verifiedNetWorthCents, 400);
  assert.throws(() => summarizeFinanceFile(null), /JSON object/);
});
