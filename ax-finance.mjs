import { summarizeTreasury } from "./ax-treasury.mjs";

/**
 * Financial intelligence for one Habitat owner.
 *
 * The rule this module enforces structurally: **no figure exists without a record, and no record
 * exists without evidence.** There is no default value, no inferred price and no "assume zero":
 *
 *   - an expense needs a source and at least one evidence string;
 *   - an asset marked `verified` needs evidence *and* a valuation date, and only verified assets
 *     enter net worth. An unverified asset is reported separately as a claim, never as value;
 *   - a liability needs a source/evidence, and always reduces verified net worth;
 *   - revenue comes from the treasury summary, which already refuses cash without evidence.
 *
 * Rejections are returned, counted and explained. Nothing is silently dropped.
 */

export const EXPENSE_STATES = Object.freeze(["paid", "due", "scheduled"]);
export const EXPENSE_CADENCES = Object.freeze(["weekly", "monthly", "annual"]);
export const ASSET_KINDS = Object.freeze(["cash", "receivable", "inventory", "equipment", "intangible"]);
export const LIABILITY_KINDS = Object.freeze(["payable", "loan", "tax", "other"]);

const CADENCE_TO_MONTHLY = Object.freeze({ weekly: 52 / 12, monthly: 1, annual: 1 / 12 });

function clean(value, max = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isCents(value) {
  return Number.isInteger(value) && value >= 0;
}

function isoOrNull(value) {
  if (!value) return null;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function evidenceOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item, 300)).filter(Boolean).slice(0, 20);
}

function moneyShape(input, rejected, id) {
  if (!isCents(input.amountCents !== undefined ? input.amountCents : input.valueCents)) {
    rejected.push({ id, code: "invalid_amount", error: "The amount must be a non-negative integer number of cents." });
    return null;
  }
  const currency = clean(input.currency, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    rejected.push({ id, code: "invalid_currency", error: "currency must be a three-letter ISO code." });
    return null;
  }
  return currency;
}

export function validateExpense(input = {}) {
  const id = clean(input.id, 120);
  if (!id) return { ok: false, code: "expense_id_required", error: "An expense needs an id." };
  const rejected = [];
  const currency = moneyShape(input, rejected, id);
  if (!currency) return { ok: false, ...rejected[0] };
  const state = clean(input.state || "paid", 20).toLowerCase();
  if (!EXPENSE_STATES.includes(state)) {
    return { ok: false, code: "invalid_state", error: "state must be one of " + EXPENSE_STATES.join(", ") + "." };
  }
  const occurredAt = isoOrNull(input.occurredAt) || isoOrNull(input.dueAt);
  if (!occurredAt) return { ok: false, code: "invalid_occurred_at", error: "An expense needs an ISO-8601 occurredAt or dueAt." };
  const source = clean(input.source, 160);
  if (!source) return { ok: false, code: "expense_source_required", error: "An expense needs a source (statement, invoice, receipt id)." };
  const evidence = evidenceOf(input.evidence);
  if (evidence.length === 0) {
    return { ok: false, code: "expense_evidence_required", error: "An expense needs at least one evidence reference; an unevidenced cost is a claim, not a cost." };
  }
  const cadence = clean(input.cadence, 20).toLowerCase();
  if (cadence && !EXPENSE_CADENCES.includes(cadence)) {
    return { ok: false, code: "invalid_cadence", error: "cadence must be one of " + EXPENSE_CADENCES.join(", ") + "." };
  }
  return {
    ok: true,
    expense: {
      id,
      amountCents: input.amountCents,
      currency,
      state,
      occurredAt,
      category: clean(input.category, 60) || "uncategorised",
      vendor: clean(input.vendor, 120) || null,
      source,
      evidence,
      cadence: cadence || null,
      recurring: Boolean(cadence),
      note: clean(input.note, 300) || null
    }
  };
}

export function validateAsset(input = {}) {
  const id = clean(input.id, 120);
  if (!id) return { ok: false, code: "asset_id_required", error: "An asset needs an id." };
  const label = clean(input.label, 160);
  if (!label) return { ok: false, code: "asset_label_required", error: "An asset needs a label." };
  const rejected = [];
  const currency = moneyShape(input, rejected, id);
  if (!currency) return { ok: false, ...rejected[0] };
  const kind = clean(input.kind, 40).toLowerCase();
  if (!ASSET_KINDS.includes(kind)) {
    return { ok: false, code: "invalid_asset_kind", error: "kind must be one of " + ASSET_KINDS.join(", ") + "." };
  }
  const evidence = evidenceOf(input.evidence);
  const valuationAt = isoOrNull(input.valuationAt);
  const verified = input.verified !== false && Boolean(valuationAt) && evidence.length > 0;
  // An unverified asset is allowed to exist, but it can never contribute to net worth.
  return {
    ok: true,
    asset: {
      id,
      label,
      kind,
      valueCents: input.valueCents,
      currency,
      valuationAt,
      evidence,
      verified,
      verificationNote: verified ? null : "No valuation date and evidence, so this is a claim and is excluded from net worth.",
      note: clean(input.note, 300) || null
    }
  };
}

export function validateLiability(input = {}) {
  const id = clean(input.id, 120);
  if (!id) return { ok: false, code: "liability_id_required", error: "A liability needs an id." };
  const label = clean(input.label, 160);
  if (!label) return { ok: false, code: "liability_label_required", error: "A liability needs a label." };
  const rejected = [];
  const currency = moneyShape(input, rejected, id);
  if (!currency) return { ok: false, ...rejected[0] };
  const kind = clean(input.kind, 40).toLowerCase();
  if (!LIABILITY_KINDS.includes(kind)) {
    return { ok: false, code: "invalid_liability_kind", error: "kind must be one of " + LIABILITY_KINDS.join(", ") + "." };
  }
  const evidence = evidenceOf(input.evidence);
  if (evidence.length === 0) {
    return { ok: false, code: "liability_evidence_required", error: "A liability needs at least one evidence reference; an unevidenced debt is neither spendable nor payable." };
  }
  return {
    ok: true,
    liability: {
      id,
      label,
      kind,
      amountCents: input.amountCents,
      currency,
      dueAt: isoOrNull(input.dueAt),
      evidence,
      verified: true,
      note: clean(input.note, 300) || null
    }
  };
}

function emptyBucket() {
  return {
    revenueCents: 0,
    refundsCents: 0,
    pipelineCents: 0,
    expensesPaidCents: 0,
    expensesDueCents: 0,
    monthlyRunRateCents: 0,
    profitCents: 0,
    marginPct: null,
    inflowCents: 0,
    outflowCents: 0,
    netCashFlowCents: 0,
    verifiedAssetsCents: 0,
    claimedAssetsCents: 0,
    liabilitiesCents: 0,
    verifiedNetWorthCents: 0,
    claimedNetWorthCents: 0,
    expenseCount: 0,
    assetCount: 0,
    liabilityCount: 0
  };
}

function inPeriod(at, period) {
  if (!period || (!period.from && !period.to)) return true;
  const time = Date.parse(String(at || ""));
  if (!Number.isFinite(time)) return false;
  if (period.from && time < Date.parse(period.from)) return false;
  if (period.to && time > Date.parse(period.to)) return false;
  return true;
}

/**
 * @param {object} input
 * @param {Array}  [input.revenueEvents]
 * @param {Array}  [input.payouts]
 * @param {Array}  [input.approvals]
 * @param {Array}  [input.expenses]
 * @param {Array}  [input.assets]
 * @param {Array}  [input.liabilities]
 * @param {object} [input.period]          { from, to } ISO timestamps, inclusive
 * @param {string} [input.primaryCurrency]
 * @param {number} [input.now]
 */
export function summarizeFinance({
  revenueEvents = [],
  payouts = [],
  approvals = [],
  expenses = [],
  assets = [],
  liabilities = [],
  period = null,
  primaryCurrency = "USD",
  now = Date.now()
} = {}) {
  const rejected = [];
  const buckets = {};
  const bucketFor = (currency) => {
    if (!buckets[currency]) buckets[currency] = emptyBucket();
    return buckets[currency];
  };

  const treasury = summarizeTreasury({ revenueEvents, payouts, approvals, primaryCurrency, now });
  for (const [currency, source] of Object.entries(treasury.currencies || {})) {
    const target = bucketFor(currency);
    target.revenueCents = Number(source.cashCents) || 0;
    target.refundsCents = (Number(source.refundedCents) || 0) + (Number(source.reversedCents) || 0);
    target.pipelineCents = Number(source.pipelineCents) || 0;
    target.inflowCents = target.revenueCents;
  }

  const seen = new Set();
  let outOfPeriod = 0;

  for (const raw of Array.isArray(expenses) ? expenses : []) {
    const checked = validateExpense(raw);
    if (!checked.ok) {
      rejected.push({ id: raw?.id ?? null, code: checked.code, error: checked.error });
      continue;
    }
    const expense = checked.expense;
    if (seen.has("expense:" + expense.id)) {
      rejected.push({ id: expense.id, code: "duplicate_expense", error: "The same expense id was supplied more than once." });
      continue;
    }
    seen.add("expense:" + expense.id);
    if (!inPeriod(expense.occurredAt, period)) {
      outOfPeriod += 1;
      continue;
    }
    const target = bucketFor(expense.currency);
    target.expenseCount += 1;
    if (expense.state === "paid") target.expensesPaidCents += expense.amountCents;
    else target.expensesDueCents += expense.amountCents;
    if (expense.cadence) {
      target.monthlyRunRateCents += Math.round(expense.amountCents * (CADENCE_TO_MONTHLY[expense.cadence] || 0));
    }
  }

  for (const raw of Array.isArray(assets) ? assets : []) {
    const checked = validateAsset(raw);
    if (!checked.ok) {
      rejected.push({ id: raw?.id ?? null, code: checked.code, error: checked.error });
      continue;
    }
    const asset = checked.asset;
    if (seen.has("asset:" + asset.id)) {
      rejected.push({ id: asset.id, code: "duplicate_asset", error: "The same asset id was supplied more than once." });
      continue;
    }
    seen.add("asset:" + asset.id);
    const target = bucketFor(asset.currency);
    target.assetCount += 1;
    target.claimedAssetsCents += asset.valueCents;
    if (asset.verified) target.verifiedAssetsCents += asset.valueCents;
  }

  for (const raw of Array.isArray(liabilities) ? liabilities : []) {
    const checked = validateLiability(raw);
    if (!checked.ok) {
      rejected.push({ id: raw?.id ?? null, code: checked.code, error: checked.error });
      continue;
    }
    const liability = checked.liability;
    if (seen.has("liability:" + liability.id)) {
      rejected.push({ id: liability.id, code: "duplicate_liability", error: "The same liability id was supplied more than once." });
      continue;
    }
    seen.add("liability:" + liability.id);
    const target = bucketFor(liability.currency);
    target.liabilityCount += 1;
    target.liabilitiesCents += liability.amountCents;
  }

  for (const bucket of Object.values(buckets)) {
    bucket.outflowCents = bucket.expensesPaidCents;
    bucket.netCashFlowCents = bucket.inflowCents - bucket.outflowCents;
    bucket.profitCents = bucket.inflowCents - bucket.expensesPaidCents;
    bucket.marginPct = bucket.inflowCents > 0
      ? Math.round((bucket.profitCents / bucket.inflowCents) * 1000) / 10
      : null;
    bucket.verifiedNetWorthCents = bucket.verifiedAssetsCents - bucket.liabilitiesCents;
    bucket.claimedNetWorthCents = bucket.claimedAssetsCents - bucket.liabilitiesCents;
  }

  const currencies = Object.keys(buckets).sort();
  const primary = primaryCurrency && buckets[primaryCurrency] ? primaryCurrency : (currencies[0] || primaryCurrency || "USD");
  const primaryBucket = buckets[primary] || emptyBucket();

  return {
    ok: true,
    asOf: new Date(now).toISOString(),
    cashBasis: "settled_and_available_only",
    period: period ? { from: period.from || null, to: period.to || null } : null,
    primaryCurrency: primary,
    currencies,
    mixedCurrencies: currencies.length > 1,
    primary: primaryBucket,
    byCurrency: buckets,
    otherCurrencies: currencies.filter((code) => code !== primary),
    rejectedCount: rejected.length,
    rejected,
    outOfPeriodCount: outOfPeriod,
    treasuryRejectedCount: treasury.rejectedCount,
    unverifiedAssetValueCents: primaryBucket.claimedAssetsCents - primaryBucket.verifiedAssetsCents,
    note: "Verified net worth counts only assets with a valuation date and evidence. Unverified assets are shown as claimed value and never as net worth. Revenue is cash only."
  };
}

/** Load an exported ledger file and summarise it. Used by the CLI; no network, no credentials. */
export function summarizeFinanceFile(document) {
  if (!document || typeof document !== "object") {
    throw new Error("The finance file must contain a JSON object.");
  }
  return summarizeFinance({
    revenueEvents: document.revenueEvents || [],
    payouts: document.payouts || [],
    approvals: document.approvals || [],
    expenses: document.expenses || [],
    assets: document.assets || [],
    liabilities: document.liabilities || [],
    period: document.period || null,
    primaryCurrency: document.primaryCurrency || "USD"
  });
}
