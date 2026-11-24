import test from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, DECISIONS, ELIGIBILITY_RULES, evaluateChannelEligibility, rulesForChannel } from "../ax-channel-eligibility.mjs";

const sellerOwned = { channel: "tiktok_shop_us", inventoryOwnership: "seller_owned", fulfillmentModel: "us_3pl", destinationCountry: "US" };

test("unknown channels and unverified ownership fail closed", () => {
  const unknown = evaluateChannelEligibility({ channel: "ebay", inventoryOwnership: "seller_owned", fulfillmentModel: "us_3pl" });
  assert.equal(unknown.decision, "DENY");
  assert.equal(unknown.code, "unknown_channel");

  const missing = evaluateChannelEligibility({ channel: "tiktok_shop_us" });
  assert.equal(missing.decision, "DENY");
  assert.ok(missing.reasons.includes("inventory_ownership_unverified"));
  assert.ok(missing.reasons.includes("fulfillment_model_unverified"));
  assert.equal(evaluateChannelEligibility({}).decision, "DENY");
});

test("TikTok Shop US denies third-party inventory and international direct shipment", () => {
  const thirdParty = evaluateChannelEligibility({ ...sellerOwned, inventoryOwnership: "third_party" });
  assert.equal(thirdParty.decision, "DENY");
  assert.ok(thirdParty.reasons.includes("tiktok_us_requires_owned_inventory"));

  const international = evaluateChannelEligibility({ ...sellerOwned, fulfillmentModel: "international_supplier_direct" });
  assert.equal(international.decision, "DENY");
  assert.ok(international.reasons.includes("tiktok_us_prohibits_international_supplier_direct"));

  const nonUs = evaluateChannelEligibility({ ...sellerOwned, destinationCountry: "GB" });
  assert.equal(nonUs.decision, "DENY");
  assert.ok(nonUs.reasons.includes("channel_market_not_configured"));
});

test("TikTok Shop US with owned inventory and US fulfilment is a manual review, never automatic", () => {
  const decision = evaluateChannelEligibility(sellerOwned);
  assert.equal(decision.decision, "MANUAL_REVIEW");
  assert.equal(decision.code, "verification_required");
  assert.equal(decision.automatedFulfillment, false);
  assert.equal(decision.automatedPurchase, false);
  assert.equal(decision.stopsAtLiveQuote, true);
  assert.equal(decision.requiresOwnerApproval, true);
  assert.equal(decision.sideEffectsPerformed, false);
});

test("retail arbitrage is denied on every channel, including DTC", () => {
  for (const channel of CHANNELS) {
    const decision = evaluateChannelEligibility({ ...sellerOwned, channel, fulfillmentModel: "retail_arbitrage" });
    assert.equal(decision.decision, "DENY", channel);
    assert.ok(decision.reasons.includes("policy_retail_arbitrage_prohibited"), channel);
  }
});

test("Amazon marketplace requires the seller of record and denies arbitrage dropshipping", () => {
  const thirdParty = evaluateChannelEligibility({ channel: "amazon_marketplace", inventoryOwnership: "third_party", fulfillmentModel: "us_3pl" });
  assert.equal(thirdParty.decision, "DENY");
  assert.ok(thirdParty.reasons.includes("amazon_marketplace_requires_seller_of_record"));

  const owned = evaluateChannelEligibility({ channel: "amazon_marketplace", inventoryOwnership: "seller_owned", fulfillmentModel: "us_3pl" });
  assert.equal(owned.decision, "MANUAL_REVIEW");
});

test("Amazon MCF is for seller-owned inventory and is not a sourcing channel", () => {
  const thirdParty = evaluateChannelEligibility({ channel: "amazon_mcf", inventoryOwnership: "third_party", fulfillmentModel: "us_3pl" });
  assert.equal(thirdParty.decision, "DENY");
  assert.ok(thirdParty.reasons.includes("amazon_mcf_requires_seller_inventory"));

  const international = evaluateChannelEligibility({ channel: "amazon_mcf", inventoryOwnership: "seller_owned", fulfillmentModel: "international_supplier_direct" });
  assert.equal(international.decision, "DENY");

  const owned = evaluateChannelEligibility({ channel: "amazon_mcf", inventoryOwnership: "seller_owned", fulfillmentModel: "seller_owned_3pl", destinationCountry: "US" });
  assert.equal(owned.decision, "MANUAL_REVIEW");

  const abroad = evaluateChannelEligibility({ channel: "amazon_mcf", inventoryOwnership: "seller_owned", fulfillmentModel: "seller_owned_3pl", destinationCountry: "CA" });
  assert.equal(abroad.decision, "DENY");
  assert.ok(abroad.reasons.includes("amazon_mcf_destination_unverified"));
});

test("ALLOW needs a documented, owner-supplied program approval reference", () => {
  const withoutReference = evaluateChannelEligibility({ ...sellerOwned, documentedProgramApproval: true });
  assert.equal(withoutReference.decision, "MANUAL_REVIEW");

  const documented = evaluateChannelEligibility({ ...sellerOwned, documentedProgramApproval: true, approvalReference: "seller-program-2026-001" });
  assert.equal(documented.decision, "ALLOW");
  assert.equal(documented.approvalReference, "seller-program-2026-001");
  assert.equal(documented.automatedPurchase, false);
  assert.equal(documented.sideEffectsPerformed, false);
});

test("every decision is one of the published values and no runtime rule is undocumented", () => {
  const samples = CHANNELS.map(channel => evaluateChannelEligibility({ ...sellerOwned, channel }));
  for (const sample of samples) assert.ok(DECISIONS.includes(sample.decision));
  assert.ok(ELIGIBILITY_RULES.length >= 8);
  for (const rule of rulesForChannel("tiktok_shop_us")) {
    assert.ok(DECISIONS.includes(rule.decision));
    assert.ok(rule.statement.length > 20);
  }
});
