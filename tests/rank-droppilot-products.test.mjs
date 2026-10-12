import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCategory, evaluateProduct, MIN_NET_PROFIT_PER_ORDER } from "../scripts/rank-droppilot-products.mjs";

const product = {
  shopifyProductId: "gid://shopify/Product/1",
  title: "Stackable Kitchen Cabinet Storage Organizer",
  productUrl: "https://store.example/products/organizer",
  productType: "",
  status: "ACTIVE",
  totalInventory: 12,
  minVariantPrice: "40.00"
};
const evidence = {
  supplierCost: 10,
  shippingCost: 3,
  otherPerOrderCosts: 1,
  platformFeeRate: 0.08,
  paymentFeeRate: 0.03,
  demandScore: 80,
  demoScore: 90,
  supplierReliabilityScore: 85,
  evidenceUrl: "https://supplier.example/quote",
  evidenceCheckedAt: new Date().toISOString()
};

test("normalizes broad catalog categories without pretending unknown categories are known", () => {
  assert.equal(normalizeCategory("Clear stackable storage drawers", ""), "home_storage");
  assert.equal(normalizeCategory("Silicone kitchen strainer", ""), "kitchen");
  assert.equal(normalizeCategory("Mystery item xyz", ""), "other_review_required");
});

test("holds products when supplier costs and evidence are missing", () => {
  const result = evaluateProduct(product, null);
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.decision, "HOLD_FOR_EVIDENCE");
  assert.ok(result.missing.includes("supplierCost"));
  assert.ok(result.missing.includes("evidenceUrl"));
});

test("calculates estimated net profit and margin from supplied cost evidence", () => {
  const result = evaluateProduct(product, evidence);
  assert.equal(result.eligibleForRanking, true);
  // 40 - 10 - 3 - 1 - (40 * 0.08) - (40 * 0.03) = 21.60
  assert.equal(result.estimatedNetProfitPerOrder, 21.6);
  assert.equal(result.estimatedNetMarginPercent, 54);
  assert.equal(result.decision, "REVIEW_FOR_LISTING");
});

test("rejects a low-margin product even if demand and demo scores are high", () => {
  const result = evaluateProduct(product, { ...evidence, supplierCost: 30, shippingCost: 5 });
  assert.equal(result.eligibleForRanking, true);
  assert.equal(result.decision, "REJECT_LOW_MARGIN");
});

test("rejects PawCharm economics when selling price is below product plus supplier shipping", () => {
  const charm = { ...product, minVariantPrice: "6.88", title: "PawCharm Keychain" };
  const result = evaluateProduct(charm, {
    ...evidence, supplierCost: 6.88, shippingCost: 5.49, otherPerOrderCosts: 0,
    platformFeeRate: 0.03, paymentFeeRate: 0.03
  });
  assert.equal(result.decision, "REJECT_LOW_MARGIN");
  assert.ok(result.estimatedNetProfitPerOrder < 0);
  assert.ok(result.estimatedNetMarginPercent < 0);
});

test("rejects orders that clear a margin percentage but make less than the absolute minimum", () => {
  const result = evaluateProduct({ ...product, minVariantPrice: "12.00" }, {
    ...evidence, supplierCost: 6.5, shippingCost: 0.5, otherPerOrderCosts: 0,
    platformFeeRate: 0.03, paymentFeeRate: 0.03
  });
  assert.ok(result.estimatedNetMarginPercent >= 20);
  assert.ok(result.estimatedNetProfitPerOrder < MIN_NET_PROFIT_PER_ORDER);
  assert.equal(result.decision, "REJECT_LOW_MARGIN");
  assert.equal(result.minimumProfitThreshold, MIN_NET_PROFIT_PER_ORDER);
});

test("keeps PawCharm at the currently listed price above the minimum profit floor under verified cost assumptions", () => {
  const charm = { ...product, minVariantPrice: "20.88", title: "PawCharm Keychain" };
  const result = evaluateProduct(charm, {
    ...evidence, supplierCost: 6.88, shippingCost: 5.49, otherPerOrderCosts: 0,
    platformFeeRate: 0.08, paymentFeeRate: 0.03
  });
  assert.equal(result.decision, "REVIEW_FOR_LISTING");
  assert.equal(result.estimatedNetProfitPerOrder, 6.21);
  assert.ok(result.estimatedNetProfitPerOrder >= MIN_NET_PROFIT_PER_ORDER);
});

test("holds products when supplier evidence is older than seven days", () => {
  const staleEvidence = { ...evidence, evidenceCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() };
  const result = evaluateProduct(product, staleEvidence);
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.decision, "HOLD_FOR_EVIDENCE");
  assert.ok(result.missing.some(value => value.includes("stale")));
});

test("holds products when supplier evidence timestamp is too far in the future", () => {
  const futureEvidence = { ...evidence, evidenceCheckedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  const result = evaluateProduct(product, futureEvidence);
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.decision, "HOLD_FOR_EVIDENCE");
  assert.ok(result.missing.some(value => value.includes("future")));
});
