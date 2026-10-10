import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCategory, evaluateProduct } from "../scripts/rank-droppilot-products.mjs";

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
  evidenceCheckedAt: "2026-10-10T12:00:00Z"
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
  const result = evaluateProduct(product, {
    ...evidence,
    supplierCost: 30,
    shippingCost: 5
  });
  assert.equal(result.eligibleForRanking, true);
  assert.equal(result.decision, "REJECT_LOW_MARGIN");
});
