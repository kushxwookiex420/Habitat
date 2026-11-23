import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPLIER_CATALOG,
  catalogSummary,
  evaluateSupplierFit,
  getSupplier,
  listSuppliers
} from "../ax-fulfillment-catalog.mjs";

test("DSers and Syncee are automation layers and are not treated as suppliers", () => {
  for (const id of ["dsers", "syncee"]) {
    const entry = getSupplier(id);
    assert.equal(entry.layer, "automation", id);
    assert.equal(entry.isSupplier, false, id);
    const fit = evaluateSupplierFit({ supplierId: id, quantity: 1, inventoryOwnership: "seller_owned" });
    assert.equal(fit.ok, false, id);
    assert.ok(fit.reasons.includes("automation_or_fulfiller_not_a_supplier"), id);
    assert.equal(fit.orderSubmitted, false);
  }
});

test("a fulfiller is not a supplier and MCF requires seller-owned inventory", () => {
  const printful = evaluateSupplierFit({ supplierId: "printful", quantity: 1, inventoryOwnership: "seller_owned" });
  assert.equal(printful.ok, false);
  assert.ok(printful.reasons.includes("automation_or_fulfiller_not_a_supplier"));

  const mcf = evaluateSupplierFit({ supplierId: "amazon_mcf", quantity: 1, inventoryOwnership: "third_party" });
  assert.equal(mcf.ok, false);
  assert.ok(mcf.reasons.includes("seller_owned_inventory_required"));
});

test("Alibaba wholesale MOQ refuses a single unit unless a selected offer applies", () => {
  const single = evaluateSupplierFit({ supplierId: "alibaba", quantity: 1, inventoryOwnership: "seller_owned", destinationCountry: "US" });
  assert.equal(single.ok, false);
  assert.ok(single.reasons.includes("moq_requires_selected_dropshipping_offer"));

  const bulk = evaluateSupplierFit({ supplierId: "alibaba", quantity: 25, inventoryOwnership: "seller_owned", destinationCountry: "US" });
  assert.equal(bulk.ok, true);
  assert.equal(bulk.code, "REQUIRES_LIVE_QUOTE");
});

test("a valid fit stops at a live quote and never submits an order", () => {
  const fit = evaluateSupplierFit({
    supplierId: "cjdropshipping",
    quantity: 1,
    inventoryOwnership: "seller_owned",
    destinationCountry: "US",
    unitCostUsd: 6.88,
    shippingUsd: 5.49
  });
  assert.equal(fit.ok, true);
  assert.equal(fit.code, "REQUIRES_LIVE_QUOTE");
  assert.equal(fit.externalCallPerformed, false);
  assert.equal(fit.orderSubmitted, false);
  assert.equal(fit.requiresOwnerApproval, true);
  assert.equal(fit.requiresLiveQuote, true);
  assert.deepEqual(fit.quoteRequest.requestedFields, ["itemsTotal", "shippingTotal", "dispatchEstimate", "currency", "quoteExpiresAt"]);
});

test("an unknown supplier and a bad quantity are refused", () => {
  assert.equal(evaluateSupplierFit({ supplierId: "nope" }).reasons[0], "unknown_supplier");
  const bad = evaluateSupplierFit({ supplierId: "aliexpress", quantity: 0 });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.includes("invalid_quantity"));
});

test("nothing in the catalog claims to be connected or verified", () => {
  const summary = catalogSummary();
  assert.equal(summary.connected, 0);
  assert.equal(summary.externalCalls, false);
  assert.equal(summary.count, SUPPLIER_CATALOG.length);
  assert.ok(summary.suppliers >= 5);
  assert.ok(summary.automationLayers >= 2);
  for (const entry of SUPPLIER_CATALOG) {
    assert.notEqual(entry.verification, "verified", entry.id);
    assert.ok(["supplier", "fulfiller", "automation", "channel", "marketplace"].includes(entry.layer), entry.id);
  }
});

test("filters narrow by layer and order model without inventing entries", () => {
  const single = listSuppliers({ orderModel: "single_unit" });
  assert.ok(single.length > 0);
  assert.ok(single.every(entry => entry.orderModel === "single_unit"));
  const automation = listSuppliers({ layer: "automation" });
  assert.deepEqual(automation.map(entry => entry.id).sort(), ["dsers", "syncee"]);
  assert.equal(getSupplier("missing"), null);
});
