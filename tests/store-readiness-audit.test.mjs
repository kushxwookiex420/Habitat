import test from "node:test";
import assert from "node:assert/strict";
import { auditStoreReadiness } from "../store-readiness-audit.mjs";

const product = {
  id: "p1", title: "Demo", handle: "demo", status: "ACTIVE",
  inventory: 5, price: "20.00", hasImage: true, supplier: "supplier",
  supplierCostVerified: true, netMarginVerified: true
};

test("returns PASS for complete evidence", () => {
  const result = auditStoreReadiness({
    shop: { domain: "demo.myshopify.com" },
    products: [product],
    collections: [{ title: "Home", productCount: 1, published: true }]
  });
  assert.equal(result.decision, "PASS");
});

test("holds active products with no inventory or unverified profit", () => {
  const result = auditStoreReadiness({
    shop: { domain: "demo.myshopify.com" },
    products: [
      { ...product, id: "p2", inventory: 0 },
      { ...product, id: "p3", netMarginVerified: false }
    ]
  });
  assert.equal(result.decision, "HOLD");
  assert.ok(result.findings.some(f => f.code === "active_product_no_stock"));
  assert.ok(result.findings.some(f => f.code === "profitability_unverified"));
});

test("warns on duplicate handles and empty collections", () => {
  const result = auditStoreReadiness({
    shop: { domain: "demo.myshopify.com" },
    products: [product, { ...product, id: "p2", hasImage: false, supplier: "" }],
    collections: [{ title: "Empty", productCount: 0, published: false }]
  });
  assert.ok(result.findings.some(f => f.code === "duplicate_handle"));
  assert.ok(result.findings.some(f => f.code === "product_image_missing"));
  assert.ok(result.findings.some(f => f.code === "supplier_mapping_missing"));
  assert.ok(result.findings.some(f => f.code === "empty_collection"));
});
