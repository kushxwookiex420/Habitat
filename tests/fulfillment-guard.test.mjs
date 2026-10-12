import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFulfillmentReadiness } from "../fulfillment-guard.mjs";

const now = Date.parse("2026-10-12T12:00:00.000Z");
const base = {
  order: {
    id: "1001",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    supplierItemsTotal: 6.88,
    supplierShippingTotal: 5.49,
    lineItems: [{ id: "line-1", supplierVariantId: "supplier-pink", quantity: 1 }]
  },
  supplierQuote: {
    verified: true,
    supplierId: "vip-digital-presence",
    itemsTotal: 6.88,
    shippingTotal: 5.49,
    checkedAt: "2026-10-12T11:45:00.000Z"
  },
  priorRequests: [],
  now
};

test("returns approval-only readiness and stable idempotency key for verified paid order", () => {
  const result = evaluateFulfillmentReadiness(base);
  assert.equal(result.ready, true);
  assert.equal(result.decision, "READY_FOR_APPROVAL");
  assert.equal(result.requiresExplicitApproval, true);
  assert.equal(result.sideEffectsPerformed, false);
  assert.match(result.idempotencyKey, /^habitat-fulfillment-[a-f0-9]{40}$/);
  assert.equal(evaluateFulfillmentReadiness(base).idempotencyKey, result.idempotencyKey);
});

test("holds unpaid, already fulfilled, missing, or malformed orders", () => {
  assert.ok(evaluateFulfillmentReadiness({ ...base, order: { ...base.order, financialStatus: "pending" } }).reasons.includes("order_not_confirmed_paid"));
  assert.ok(evaluateFulfillmentReadiness({ ...base, order: { ...base.order, fulfillmentStatus: "fulfilled" } }).reasons.includes("order_not_unfulfilled"));
  assert.ok(evaluateFulfillmentReadiness({ ...base, order: { ...base.order, lineItems: [] } }).reasons.includes("order_line_items_missing"));
  assert.equal(evaluateFulfillmentReadiness({ order: null }).decision, "HOLD");
});

test("holds stale quote, missing supplier mapping, and cost parity mismatches", () => {
  assert.ok(evaluateFulfillmentReadiness({ ...base, supplierQuote: { ...base.supplierQuote, checkedAt: "2026-10-10T00:00:00.000Z" } }).reasons.includes("supplier_quote_stale_or_invalid"));
  assert.ok(evaluateFulfillmentReadiness({ ...base, order: { ...base.order, lineItems: [{ ...base.order.lineItems[0], supplierVariantId: "" }] } }).reasons.includes("line_item_0_supplier_variant_unmapped"));
  assert.ok(evaluateFulfillmentReadiness({ ...base, supplierQuote: { ...base.supplierQuote, shippingTotal: 9.99 } }).reasons.includes("supplier_shipping_cost_mismatch"));
});

test("holds any unresolved or potentially accepted prior supplier request", () => {
  for (const status of ["pending", "accepted", "submitted", "unknown", ""]) {
    const result = evaluateFulfillmentReadiness({ ...base, priorRequests: [{ status }] });
    assert.equal(result.decision, "HOLD", status);
    assert.ok(result.reasons.includes("possible_duplicate_or_unresolved_supplier_request"));
  }
});

test("holds when prior supplier request history is missing or malformed", () => {
  const { priorRequests: _ignored, ...withoutHistory } = base;
  const omitted = evaluateFulfillmentReadiness(withoutHistory);
  assert.equal(omitted.decision, "HOLD");
  assert.ok(omitted.reasons.includes("prior_request_history_unavailable"));
  const unavailable = evaluateFulfillmentReadiness({ ...base, priorRequests: null });
  assert.equal(unavailable.decision, "HOLD");
  assert.ok(unavailable.reasons.includes("prior_request_history_unavailable"));
  const malformed = evaluateFulfillmentReadiness({ ...base, priorRequests: [null] });
  assert.equal(malformed.decision, "HOLD");
  assert.ok(malformed.reasons.includes("possible_duplicate_or_unresolved_supplier_request"));
});

test("allows retry only when prior requests are explicitly rejected or cancelled", () => {
  const result = evaluateFulfillmentReadiness({ ...base, priorRequests: [{ status: "rejected" }, { status: "cancelled" }] });
  assert.equal(result.ready, true);
});

test("changes the idempotency key when supplier, item, or quantity changes", () => {
  const first = evaluateFulfillmentReadiness(base).idempotencyKey;
  const changedQuantity = evaluateFulfillmentReadiness({ ...base, order: { ...base.order, lineItems: [{ ...base.order.lineItems[0], quantity: 2 }] } }).idempotencyKey;
  const changedSupplier = evaluateFulfillmentReadiness({ ...base, supplierQuote: { ...base.supplierQuote, supplierId: "other-supplier" } }).idempotencyKey;
  assert.notEqual(first, changedQuantity);
  assert.notEqual(first, changedSupplier);
});
