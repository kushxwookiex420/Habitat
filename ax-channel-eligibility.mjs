/**
 * Channel eligibility.
 *
 * A read-only decision about whether an order may even be considered for a channel. It never
 * places, changes or cancels anything, and it never returns an autonomous approval.
 *
 * The rules encode what the platforms actually require, not what a supplier's marketing says:
 *
 *   - TikTok Shop US requires the seller to own and maintain the inventory. A US seller may not
 *     route a direct-to-consumer order to an international third-party supplier for consolidation
 *     and shipment. Retail arbitrage and falsified tracking are prohibited.
 *   - Amazon marketplace rules out retail arbitrage/dropshipping: the seller of record must be the
 *     one fulfilling. Multi-Channel Fulfillment is for seller-owned FBA inventory on orders that
 *     did not come from Amazon.
 *   - Print-on-demand and seller-owned 3PL models remain possible but their account-level
 *     eligibility, fees and quotas are unverified here.
 *
 * Fail closed: an unknown channel, an unknown fulfilment model or a missing ownership declaration
 * is a DENY, never a MAYBE that someone later treats as a yes.
 */

export const CHANNELS = Object.freeze([
  "tiktok_shop_us",
  "amazon_marketplace",
  "amazon_mcf",
  "shopify_dtc",
  "independent_dtc"
]);

export const INVENTORY_OWNERSHIP = Object.freeze(["seller_owned", "third_party", "unknown"]);
export const FULFILLMENT_MODELS = Object.freeze([
  "us_3pl",
  "seller_owned_3pl",
  "marketplace_owned",
  "international_supplier_direct",
  "retail_arbitrage",
  "print_on_demand",
  "unknown"
]);

export const DECISIONS = Object.freeze(["ALLOW", "MANUAL_REVIEW", "DENY"]);

/** Published as data so a report and the code cannot drift apart. */
export const ELIGIBILITY_RULES = Object.freeze([
  { id: "tiktok_us_requires_owned_inventory", channel: "tiktok_shop_us", decision: "DENY", statement: "TikTok Shop US requires the seller to own and maintain the inventory." },
  { id: "tiktok_us_prohibits_international_supplier_direct", channel: "tiktok_shop_us", decision: "DENY", statement: "A US seller may not ship direct from an international third-party supplier or consolidation service." },
  { id: "tiktok_us_retail_arbitrage", channel: "tiktok_shop_us", decision: "DENY", statement: "Retail arbitrage and falsified tracking are prohibited." },
  { id: "amazon_marketplace_retail_arbitrage", channel: "amazon_marketplace", decision: "DENY", statement: "The seller of record must fulfil; retail-arbitrage dropshipping is prohibited." },
  { id: "amazon_mcf_requires_seller_inventory", channel: "amazon_mcf", decision: "DENY", statement: "MCF fulfils seller-owned FBA inventory only; it is not a supplier." },
  { id: "amazon_mcf_not_amazon_order", channel: "amazon_mcf", decision: "MANUAL_REVIEW", statement: "MCF is intended for off-Amazon orders on seller-owned inventory." },
  { id: "policy_retail_arbitrage_prohibited", channel: "*", decision: "DENY", statement: "This system does not fulfil retail-arbitrage orders on any channel." },
  { id: "verification_required", channel: "*", decision: "MANUAL_REVIEW", statement: "Account-level eligibility, fees and quotas are unverified, so a human decides." }
]);

function deny(reason) {
  return reason;
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

/**
 * @param {object} input
 * @param {string} input.channel
 * @param {string} input.inventoryOwnership  seller_owned | third_party | unknown
 * @param {string} input.fulfillmentModel
 * @param {string} [input.supplierCountry]
 * @param {string} [input.destinationCountry]
 * @param {boolean} [input.documentedProgramApproval] owner-verified program approval on file
 * @param {string} [input.approvalReference]
 * @param {string} [input.verifiedAt]
 */
export function evaluateChannelEligibility(input = {}) {
  const channel = String(input.channel || "").trim().toLowerCase();
  const ownership = String(input.inventoryOwnership || "unknown").trim().toLowerCase();
  const model = String(input.fulfillmentModel || "unknown").trim().toLowerCase();
  const destination = String(input.destinationCountry || "").trim().toUpperCase();
  const supplierCountry = String(input.supplierCountry || "").trim().toUpperCase();
  const reasons = [];

  const base = {
    channel: channel || null,
    inventoryOwnership: ownership,
    fulfillmentModel: model,
    destinationCountry: destination || null,
    supplierCountry: supplierCountry || null,
    automatedFulfillment: false,
    automatedPurchase: false,
    stopsAtLiveQuote: true,
    requiresOwnerApproval: true,
    evaluatedAt: new Date().toISOString()
  };

  if (!CHANNELS.includes(channel)) {
    return { ...base, decision: "DENY", code: "unknown_channel", reasons: ["unknown_channel"], sideEffectsPerformed: false };
  }
  if (!INVENTORY_OWNERSHIP.includes(ownership) || !FULFILLMENT_MODELS.includes(model)) {
    return { ...base, decision: "DENY", code: "insufficient_evidence", reasons: ["inventory_ownership_unverified", "fulfillment_model_unverified"], sideEffectsPerformed: false };
  }
  // "unknown" is a valid enum value but not evidence. Without an ownership declaration and a
  // fulfilment model there is nothing to evaluate, so the answer is a refusal.
  if (ownership === "unknown" || model === "unknown") {
    return { ...base, decision: "DENY", code: "insufficient_evidence", reasons: ["inventory_ownership_unverified", "fulfillment_model_unverified"], sideEffectsPerformed: false };
  }

  // A retail-arbitrage model is refused everywhere, before any channel-specific exception.
  if (model === "retail_arbitrage") {
    return { ...base, decision: "DENY", code: "retail_arbitrage_prohibited", reasons: [deny("policy_retail_arbitrage_prohibited")], sideEffectsPerformed: false };
  }

  if (channel === "tiktok_shop_us") {
    if (ownership !== "seller_owned") pushUnique(reasons, deny("tiktok_us_requires_owned_inventory"));
    if (model === "international_supplier_direct") pushUnique(reasons, deny("tiktok_us_prohibits_international_supplier_direct"));
    if (destination && destination !== "US") {
      // This module only encodes the US program; another market needs its own researched rules.
      pushUnique(reasons, deny("channel_market_not_configured"));
    }
  }

  if (channel === "amazon_marketplace") {
    if (ownership !== "seller_owned") pushUnique(reasons, deny("amazon_marketplace_requires_seller_of_record"));
  }

  if (channel === "amazon_mcf") {
    if (ownership !== "seller_owned") pushUnique(reasons, deny("amazon_mcf_requires_seller_inventory"));
    if (model === "international_supplier_direct") pushUnique(reasons, deny("amazon_mcf_requires_seller_inventory"));
    if (destination && destination !== "US") pushUnique(reasons, deny("amazon_mcf_destination_unverified"));
  }

  if (channel === "shopify_dtc" || channel === "independent_dtc") {
    if (ownership === "third_party" && model === "international_supplier_direct") {
      // Not a platform prohibition, but our own policy: no unverified international direct shipment.
      pushUnique(reasons, deny("international_direct_shipment_unverified"));
    }
  }

  if (reasons.length) {
    return {
      ...base,
      decision: "DENY",
      code: reasons[0],
      reasons,
      sideEffectsPerformed: false
    };
  }

  // ALLOW needs an owner-verified program approval on file. Without it the honest answer is a human
  // review, because every account-level detail in this area is account-specific and unverified.
  const documented = input.documentedProgramApproval === true && String(input.approvalReference || "").trim().length > 0;
  if (documented) {
    return {
      ...base,
      decision: "ALLOW",
      code: "documented_program_approval",
      reasons: [],
      approvalReference: String(input.approvalReference).slice(0, 200),
      note: "Eligibility rests on the owner-supplied program approval reference. It does not authorize a purchase.",
      sideEffectsPerformed: false
    };
  }

  return {
    ...base,
    decision: "MANUAL_REVIEW",
    code: "verification_required",
    reasons: [deny("verification_required")],
    note: "The model is not prohibited, but account-level eligibility is unverified. A human decides.",
    sideEffectsPerformed: false
  };
}

/** The rules for one channel, for documentation and the read-only route. */
export function rulesForChannel(channel) {
  const wanted = String(channel || "").trim().toLowerCase();
  return ELIGIBILITY_RULES.filter(rule => rule.channel === wanted || rule.channel === "*");
}
