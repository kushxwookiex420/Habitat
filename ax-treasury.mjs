/**
 * Treasury reporting.
 *
 * This is a ledger and a policy surface, not a wallet. It reads recorded revenue events, payouts and
 * approvals and reports what is actually spendable.
 *
 * The single most important rule: only `settled` and `available` count as cash. `estimated`,
 * `invoiced` and `collected` are pipeline, and a summary that adds them to cash is wrong even when
 * the number looks better. Amounts are integer minor units (cents); a float is rejected rather than
 * rounded, because rounding money silently loses it.
 *
 * A `settled`/`available` event must carry evidence (a payout id, settlement reference or statement
 * line). Without evidence it is rejected and reported, never counted.
 */

export const REVENUE_STATES = Object.freeze([
  "estimated",
  "invoiced",
  "collected",
  "settled",
  "available",
  "refunded",
  "reversed"
]);

/** The only states that are cash. Exported so a caller cannot hard-code a different set. */
export const CASH_STATES = Object.freeze(["settled", "available"]);
export const PIPELINE_STATES = Object.freeze(["estimated", "invoiced", "collected"]);
export const NEGATIVE_STATES = Object.freeze(["refunded", "reversed"]);

export const PAYOUT_STATES = Object.freeze(["requested", "in_transit", "paid", "failed", "cancelled"]);

export function isCashState(state) {
  return CASH_STATES.includes(String(state || "").trim().toLowerCase());
}

function isoOrNull(value) {
  const at = Date.parse(String(value ?? ""));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function isCents(value) {
  return Number.isInteger(value) && value >= 0;
}

function cleanText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeEvidence(value) {
  return []
    .concat(Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .map(item => cleanText(item, 300))
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Validate one revenue event. Rejections are specific: a caller learns which field failed without
 * being told anything about other records.
 */
export function validateRevenueEvent(event = {}) {
  const id = cleanText(event.id, 120);
  if (!id) return { ok: false, code: "revenue_id_required", error: "A revenue event needs an id." };
  const state = cleanText(event.state, 20).toLowerCase();
  if (!REVENUE_STATES.includes(state)) {
    return { ok: false, code: "invalid_revenue_state", error: "state must be one of " + REVENUE_STATES.join(", ") + "." };
  }
  if (!isCents(event.amountCents)) {
    return { ok: false, code: "invalid_amount", error: "amountCents must be a non-negative integer number of cents." };
  }
  if (event.amountCents < 0) {
    return { ok: false, code: "invalid_amount", error: "A negative amount is not accepted; use the refunded or reversed state." };
  }
  const currency = cleanText(event.currency, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, code: "invalid_currency", error: "currency must be a three-letter ISO code." };
  }
  const occurredAt = isoOrNull(event.occurredAt);
  if (!occurredAt) return { ok: false, code: "invalid_occurred_at", error: "occurredAt must be an ISO-8601 timestamp." };
  const source = cleanText(event.source, 120);
  if (!source) return { ok: false, code: "revenue_source_required", error: "A revenue event needs a source (channel, payout or statement)." };

  const evidence = normalizeEvidence(event.evidence);
  if (CASH_STATES.includes(state) && evidence.length === 0) {
    return {
      ok: false,
      code: "cash_evidence_required",
      error: "A settled or available amount needs evidence: a payout id, settlement reference or statement line."
    };
  }

  return {
    ok: true,
    event: {
      id,
      state,
      amountCents: event.amountCents,
      currency,
      occurredAt,
      source,
      evidence,
      channel: cleanText(event.channel, 60) || null,
      externalId: cleanText(event.externalId, 160) || null,
      note: cleanText(event.note, 300) || null
    }
  };
}

export function validatePayout(payout = {}) {
  const id = cleanText(payout.id, 120);
  if (!id) return { ok: false, code: "payout_id_required", error: "A payout needs an id." };
  const state = cleanText(payout.state, 20).toLowerCase();
  if (!PAYOUT_STATES.includes(state)) {
    return { ok: false, code: "invalid_payout_state", error: "state must be one of " + PAYOUT_STATES.join(", ") + "." };
  }
  if (!isCents(payout.amountCents)) {
    return { ok: false, code: "invalid_amount", error: "amountCents must be a non-negative integer number of cents." };
  }
  const currency = cleanText(payout.currency, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, code: "invalid_currency", error: "currency must be a three-letter ISO code." };
  }
  return {
    ok: true,
    payout: {
      id,
      state,
      amountCents: payout.amountCents,
      currency,
      channel: cleanText(payout.channel, 60) || null,
      accountId: cleanText(payout.accountId, 120) || null,
      arrivalAt: isoOrNull(payout.arrivalAt),
      note: cleanText(payout.note, 300) || null
    }
  };
}

function bucket() {
  return {
    settledCents: 0,
    availableCents: 0,
    estimatedCents: 0,
    invoicedCents: 0,
    collectedCents: 0,
    refundedCents: 0,
    reversedCents: 0,
    cashCents: 0,
    pipelineCents: 0,
    reservedCents: 0,
    consumedSpendCents: 0,
    payoutsPaidCents: 0,
    payoutsInTransitCents: 0,
    availableToSpendCents: 0,
    overCommitted: false,
    eventCount: 0
  };
}

/**
 * @param {object} input
 * @param {Array}  [input.revenueEvents]
 * @param {Array}  [input.payouts]
 * @param {Array}  [input.approvals]  access requests; only approved, unconsumed, unexpired commitments count
 * @param {string} [input.primaryCurrency]
 * @param {number} [input.now]
 */
export function summarizeTreasury({
  revenueEvents = [],
  payouts = [],
  approvals = [],
  primaryCurrency = "USD",
  now = Date.now()
} = {}) {
  const currencies = {};
  const rejected = [];
  const seen = new Set();

  const bucketFor = currency => {
    if (!currencies[currency]) currencies[currency] = bucket();
    return currencies[currency];
  };

  for (const raw of Array.isArray(revenueEvents) ? revenueEvents : []) {
    const checked = validateRevenueEvent(raw);
    if (!checked.ok) {
      rejected.push({ id: raw?.id ?? null, code: checked.code, error: checked.error });
      continue;
    }
    const event = checked.event;
    // The same event recorded twice must not double the reported cash.
    if (seen.has(event.id)) {
      rejected.push({ id: event.id, code: "duplicate_event", error: "The same revenue event id was supplied more than once." });
      continue;
    }
    seen.add(event.id);
    const target = bucketFor(event.currency);
    target.eventCount += 1;
    if (event.state === "settled") target.settledCents += event.amountCents;
    else if (event.state === "available") target.availableCents += event.amountCents;
    else if (event.state === "estimated") target.estimatedCents += event.amountCents;
    else if (event.state === "invoiced") target.invoicedCents += event.amountCents;
    else if (event.state === "collected") target.collectedCents += event.amountCents;
    else if (event.state === "refunded") target.refundedCents += event.amountCents;
    else if (event.state === "reversed") target.reversedCents += event.amountCents;
  }

  for (const raw of Array.isArray(payouts) ? payouts : []) {
    const checked = validatePayout(raw);
    if (!checked.ok) {
      rejected.push({ id: raw?.id ?? null, code: checked.code, error: checked.error });
      continue;
    }
    const payout = checked.payout;
    const target = bucketFor(payout.currency);
    if (payout.state === "paid") target.payoutsPaidCents += payout.amountCents;
    else if (payout.state === "requested" || payout.state === "in_transit") target.payoutsInTransitCents += payout.amountCents;
  }

  for (const approval of Array.isArray(approvals) ? approvals : []) {
    const status = String(approval?.status || "");
    const amount = approval?.amountCents;
    const currency = String(approval?.currency || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || !isCents(amount)) continue;
    const target = bucketFor(currency);
    if (status === "approved" && !approval.consumedAt) {
      const expiresAt = Date.parse(String(approval.expiresAt || ""));
      if (Number.isFinite(expiresAt) && expiresAt > now) target.reservedCents += amount;
    } else if (status === "consumed" || (status === "approved" && approval.consumedAt)) {
      target.consumedSpendCents += amount;
    }
  }

  for (const [currency, target] of Object.entries(currencies)) {
    // Cash can go negative after a refund that exceeds what has settled. Report the truth, and let
    // spendable clamp at zero so the UI cannot offer money that is not there.
    target.cashCents = target.settledCents + target.availableCents - target.refundedCents - target.reversedCents;
    target.pipelineCents = target.estimatedCents + target.invoicedCents + target.collectedCents;
    const spendable = target.cashCents - target.reservedCents;
    target.overCommitted = spendable < 0;
    target.availableToSpendCents = Math.max(0, spendable);
    target.selfFunding = {
      settledGrossCents: target.settledCents + target.availableCents,
      spendCents: target.consumedSpendCents,
      ratio: target.consumedSpendCents > 0
        ? Number(((target.settledCents + target.availableCents) / target.consumedSpendCents).toFixed(4))
        : null,
      covered: target.consumedSpendCents > 0 && (target.settledCents + target.availableCents) >= target.consumedSpendCents
    };
    target.currency = currency;
  }

  const primary = String(primaryCurrency || "USD").toUpperCase();
  const primaryBucket = currencies[primary] || bucket();

  return {
    ok: true,
    cashBasis: "settled_and_available_only",
    excludedFromCash: [...PIPELINE_STATES, ...NEGATIVE_STATES],
    currencies,
    mixedCurrencies: Object.keys(currencies).length > 1,
    primaryCurrency: primary,
    primary: primaryBucket,
    rejectedEvents: rejected,
    rejectedCount: rejected.length,
    pendingApprovals: (Array.isArray(approvals) ? approvals : []).filter(item => String(item?.status) === "requested").length,
    note: "Estimated, invoiced and collected amounts are not cash and are never counted as spendable. A settled or available amount without evidence is rejected."
  };
}

/**
 * Guard for any future spend path. Takes the summary, not the raw rows, so a caller cannot
 * re-add pipeline states on the way to the check.
 */
export function assertSpendable(summary, { amountCents, currency = "USD" } = {}) {
  if (!isCents(amountCents) || amountCents <= 0) {
    return { ok: false, code: "invalid_amount", error: "A spend check needs a positive integer amount of cents." };
  }
  const wanted = String(currency || "").toUpperCase();
  const target = summary?.currencies?.[wanted];
  if (!target) return { ok: false, code: "unknown_currency", error: "No treasury activity in " + wanted + "; nothing is spendable." };
  if (amountCents > target.availableToSpendCents) {
    return {
      ok: false,
      code: "insufficient_settled_cash",
      error: "Available settled cash is " + target.availableToSpendCents + " cents; requested " + amountCents + ".",
      availableToSpendCents: target.availableToSpendCents
    };
  }
  return { ok: true, availableToSpendCents: target.availableToSpendCents - amountCents };
}
