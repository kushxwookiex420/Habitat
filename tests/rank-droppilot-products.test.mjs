import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCategory, evaluateProduct, evaluateProductVariants, evaluateManifestFreshness, MAX_MANIFEST_AGE_HOURS, MIN_NET_PROFIT_PER_ORDER } from "../scripts/rank-droppilot-products.mjs";

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
  verified: true,
  supplierCost: 10,
  supplierStockQuantity: 25,
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

test("holds apparently complete economics unless supplier evidence is explicitly verified", () => {
  const result = evaluateProduct(product, { ...evidence, verified: false });
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.decision, "HOLD_FOR_EVIDENCE");
  assert.ok(result.missing.includes("verified supplier economics (verified: true)"));
});

test("rejects non-HTTPS supplier evidence URLs", () => {
  const result = evaluateProduct(product, { ...evidence, evidenceUrl: "http://supplier.example/quote" });
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.decision, "HOLD_FOR_EVIDENCE");
  assert.ok(result.missing.includes("evidenceUrl (HTTPS source required)"));
});

test("holds products when supplier costs and evidence are missing", () => {
  const result = evaluateProduct(product, null);
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.decision, "HOLD_FOR_EVIDENCE");
  assert.ok(result.missing.includes("supplierCost"));
  assert.ok(result.missing.includes("supplierStockQuantity"));
  assert.ok(result.missing.some((item) => item.startsWith("evidenceUrl")));
});

test("holds inactive, archived, or unknown-status products before profitability ranking", () => {
  for (const status of ["DRAFT", "ARCHIVED", "", undefined]) {
    const candidate = { ...product, status };
    const result = evaluateProduct(candidate, evidence);
    assert.equal(result.eligibleForRanking, false);
    assert.equal(result.decision, "HOLD_PRODUCT_STATUS");
    assert.ok(result.missing.includes("Shopify product status must be ACTIVE"));
  }
});

test("calculates estimated net profit and margin from supplied cost evidence", () => {
  const result = evaluateProduct(product, evidence);
  assert.equal(result.eligibleForRanking, true);
  // 40 - 10 - 3 - 1 - (40 * 0.08) - (40 * 0.03) = 21.60
  assert.equal(result.estimatedNetProfitPerOrder, 21.6);
  assert.equal(result.supplierStockQuantity, 25);
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


test("evaluates every sellable variant and rejects a product if one variant misses the profit floor", () => {
  const variantsProduct = {
    ...product,
    variants: [
      { shopifyVariantId: "variant-good", title: "Standard", price: 40, supplierCost: 10, supplierStockQuantity: 25, inventoryQuantity: 10, availableForSale: true, inventoryPolicy: "DENY" },
      { shopifyVariantId: "variant-bad", title: "Premium", price: 40, supplierCost: 35, supplierStockQuantity: 25, inventoryQuantity: 10, availableForSale: true, inventoryPolicy: "DENY" }
    ]
  };
  const result = evaluateProductVariants(variantsProduct, {
    ...evidence,
    variants: [
      { shopifyVariantId: "variant-good", supplierStockQuantity: 25 },
      { shopifyVariantId: "variant-bad", supplierStockQuantity: 25 }
    ]
  });
  assert.equal(result.decision, "REJECT_LOW_MARGIN");
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.variantDecisionCount, 2);
  assert.equal(result.variantDecisions.find(v => v.shopifyVariantId === "variant-bad").decision, "REJECT_LOW_MARGIN");
});

test("holds a product when sellable variants lack their own supplier stock evidence", () => {
  const variantsProduct = {
    ...product,
    variants: [
      { shopifyVariantId: "variant-one", title: "Standard", price: 40, supplierCost: 10, inventoryQuantity: 10, availableForSale: true, inventoryPolicy: "DENY" }
    ]
  };
  const result = evaluateProductVariants(variantsProduct, {
    ...evidence,
    supplierStockQuantity: 100
  });
  assert.equal(result.decision, "HOLD_FOR_EVIDENCE");
  assert.ok(result.missing.includes("supplierStockQuantity"));
  assert.equal(result.eligibleForRanking, false);
});

test("holds a zero-stock variant if Shopify still marks it available for sale", () => {
  const variantsProduct = {
    ...product,
    variants: [
      { shopifyVariantId: "variant-good", title: "Black", price: 40, supplierCost: 10, inventoryQuantity: 10, availableForSale: true, inventoryPolicy: "DENY" },
      { shopifyVariantId: "variant-zero", title: "Red", price: 40, supplierCost: 10, inventoryQuantity: 0, availableForSale: true, inventoryPolicy: "CONTINUE" }
    ]
  };
  const result = evaluateProductVariants(variantsProduct, evidence);
  assert.equal(result.decision, "HOLD_STOCK_CHECK");
  assert.equal(result.eligibleForRanking, false);
  assert.equal(result.variantDecisions.find(v => v.shopifyVariantId === "variant-zero").decision, "HOLD_STOCK_CHECK");
});


test("catalog snapshot freshness accepts at most 24 hours and rejects missing or future timestamps", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  assert.equal(MAX_MANIFEST_AGE_HOURS, 24);
  assert.deepEqual(evaluateManifestFreshness({ generatedAt: "2026-10-11T12:00:00.000Z" }, now), { fresh: true, ageHours: 24 });
  assert.equal(evaluateManifestFreshness({ generatedAt: "2026-10-11T11:59:59.999Z" }, now).fresh, false);
  assert.equal(evaluateManifestFreshness({ generatedAt: "2026-10-12T12:00:01.000Z" }, now).fresh, false);
  assert.equal(evaluateManifestFreshness({}, now).fresh, false);
});
