import { createHash } from "node:crypto";

const MAX_QUOTE_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_TERMINAL_REQUEST_STATES = new Set(["rejected", "cancelled"]);

function hold(...reasons) {
  return { ready: false, decision: "HOLD", reasons, idempotencyKey: null, sideEffectsPerformed: false };
}

function freshTimestamp(value, now) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 5 * 60 * 1000 && now - time <= MAX_QUOTE_AGE_MS;
}

function money(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Read-only preflight for a potential supplier fulfillment request.
 * This function never submits an order. Its output is a readiness decision only.
 */
export function evaluateFulfillmentReadiness({
  order,
  supplierQuote,
  priorRequests,
  now = Date.now()
} = {}) {
  const reasons = [];
  if (!order || typeof order !== "object") return hold("order_missing");
  if (!String(order.id ?? "").trim()) reasons.push("order_id_missing");
  if (String(order.financialStatus ?? "").toLowerCase() !== "paid") reasons.push("order_not_confirmed_paid");
  if (String(order.fulfillmentStatus ?? "").toLowerCase() !== "unfulfilled") reasons.push("order_not_unfulfilled");
  if (!Array.isArray(order.lineItems) || order.lineItems.length === 0) {
    reasons.push("order_line_items_missing");
  } else {
    for (const [index, item] of order.lineItems.entries()) {
      if (!String(item?.id ?? "").trim()) reasons.push("line_item_" + index + "_id_missing");
      if (!String(item?.supplierVariantId ?? "").trim()) reasons.push("line_item_" + index + "_supplier_variant_unmapped");
      if (!Number.isInteger(item?.quantity) || item.quantity < 1) reasons.push("line_item_" + index + "_quantity_invalid");
    }
  }

  if (!supplierQuote || typeof supplierQuote !== "object") {
    reasons.push("supplier_quote_missing");
  } else {
    if (supplierQuote.verified !== true) reasons.push("supplier_quote_not_verified");
    if (!freshTimestamp(supplierQuote.checkedAt, now)) reasons.push("supplier_quote_stale_or_invalid");
    if (!money(supplierQuote.itemsTotal) || !money(supplierQuote.shippingTotal)) {
      reasons.push("supplier_quote_costs_missing_or_invalid");
    }
    if (!money(order.supplierItemsTotal) || !money(order.supplierShippingTotal)) {
      reasons.push("expected_supplier_costs_missing_or_invalid");
    } else if (money(supplierQuote.itemsTotal) && money(supplierQuote.shippingTotal)) {
      if (Math.abs(supplierQuote.itemsTotal - order.supplierItemsTotal) > 0.01) reasons.push("supplier_item_cost_mismatch");
      if (Math.abs(supplierQuote.shippingTotal - order.supplierShippingTotal) > 0.01) reasons.push("supplier_shipping_cost_mismatch");
    }
    if (!String(supplierQuote.supplierId ?? "").trim()) reasons.push("supplier_identity_missing");
  }

  if (!Array.isArray(priorRequests)) {
    reasons.push("prior_request_history_unavailable");
  } else {
    const unsafePrior = priorRequests.some(request =>
      !request || typeof request !== "object" ||
      !SAFE_TERMINAL_REQUEST_STATES.has(String(request.status ?? "").toLowerCase())
    );
    if (unsafePrior) reasons.push("possible_duplicate_or_unresolved_supplier_request");
  }

  if (reasons.length) return hold(...[...new Set(reasons)]);

  const canonicalItems = [...order.lineItems]
    .map(item => ({
      id: String(item.id).trim(),
      supplierVariantId: String(item.supplierVariantId).trim(),
      quantity: item.quantity
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = JSON.stringify({
    orderId: String(order.id).trim(),
    supplierId: String(supplierQuote.supplierId).trim(),
    items: canonicalItems
  });
  const idempotencyKey = "habitat-fulfillment-" +
    createHash("sha256").update(fingerprint).digest("hex").slice(0, 40);

  return {
    ready: true,
    decision: "READY_FOR_APPROVAL",
    reasons: [],
    idempotencyKey,
    supplierId: String(supplierQuote.supplierId).trim(),
    quoteCheckedAt: new Date(Date.parse(supplierQuote.checkedAt)).toISOString(),
    sideEffectsPerformed: false,
    requiresExplicitApproval: true,
    note: "Read-only readiness check. Re-fetch order and supplier request history immediately before submission; use this idempotency key if the supplier API supports it."
  };
}
