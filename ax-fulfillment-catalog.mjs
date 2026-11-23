/**
 * Fulfillment catalog.
 *
 * Distinguishes four things that are routinely conflated: a supplier, a fulfiller/3PL, an
 * automation layer and a channel. Getting this wrong is how a "supplier integration" turns out to be
 * a dashboard that forwards orders to somebody else.
 *
 * Every entry is static data in this repository. `freeFirst` is true and `externalCallPerformed` is
 * always false: nothing here contacts a provider, opens OAuth, creates an order or spends money.
 */

export const FULFILLMENT_LAYERS = Object.freeze(["supplier", "fulfiller", "automation", "channel", "marketplace"]);

export const ORDER_MODELS = Object.freeze([
  "single_unit",
  "wholesale_moq",
  "print_on_demand",
  "seller_owned_3pl",
  "marketplace_owned"
]);

/** How reachable a provider's ordering API actually is, from research rather than marketing. */
export const API_STATES = Object.freeze(["public_api", "account_api", "partner_only", "mcp_only", "none", "unverified"]);

export const SUPPLIER_CATALOG = Object.freeze([
  Object.freeze({
    id: "alibaba",
    name: "Alibaba",
    layer: "supplier",
    isSupplier: true,
    orderModel: "wholesale_moq",
    singleUnitEligible: "selected_offers_only",
    countries: ["CN"],
    apiState: "partner_only",
    apiDetail: "Alibaba Open Platform access needs an approved app; the Dropshipping Center covers selected single-unit offers only.",
    paymentModel: "trade_assurance_or_offline",
    verification: "unverified",
    notes: "Predominantly wholesale with MOQ. Treat a 'dropshipping' listing as a selected offer, not the platform default."
  }),
  Object.freeze({
    id: "aliexpress",
    name: "AliExpress",
    layer: "supplier",
    isSupplier: true,
    orderModel: "single_unit",
    singleUnitEligible: "yes",
    countries: ["CN"],
    apiState: "public_api",
    apiDetail: "Official Dropshipping API requires an approved app, Dropshipping Center enrollment and buyer OAuth.",
    paymentModel: "platform_escrow",
    verification: "unverified",
    notes: "Ordering needs an approved app and an OAuth-connected buyer account; neither exists in this deployment."
  }),
  Object.freeze({
    id: "cjdropshipping",
    name: "CJdropshipping",
    layer: "supplier",
    isSupplier: true,
    orderModel: "single_unit",
    singleUnitEligible: "yes",
    countries: ["CN", "US"],
    apiState: "account_api",
    apiDetail: "API v2 with an account API token; balance-funded payment.",
    paymentModel: "account_balance",
    verification: "unverified",
    notes: "Acts as both sourcing agent and fulfiller. Product quality and dispatch times vary by warehouse."
  }),
  Object.freeze({
    id: "zendrop",
    name: "Zendrop",
    layer: "supplier",
    isSupplier: true,
    orderModel: "single_unit",
    singleUnitEligible: "yes",
    countries: ["CN", "US"],
    apiState: "mcp_only",
    apiDetail: "A developer/MCP beta exists; order-creation support is unverified.",
    paymentModel: "subscription_plus_wallet",
    verification: "unverified",
    notes: "Free plan is limited; paid plans start at a monthly fee. No paid plan is authorized here."
  }),
  Object.freeze({
    id: "spocket",
    name: "Spocket",
    layer: "supplier",
    isSupplier: true,
    orderModel: "single_unit",
    singleUnitEligible: "yes",
    countries: ["US", "EU"],
    apiState: "none",
    apiDetail: "No public ordering API was found.",
    paymentModel: "subscription",
    verification: "unverified",
    notes: "Trial then paid subscription from roughly $39.99/month. Unusable without a paid plan the owner has not approved."
  }),
  Object.freeze({
    id: "syncee",
    name: "Syncee",
    layer: "automation",
    isSupplier: false,
    orderModel: "single_unit",
    singleUnitEligible: "depends_on_connected_supplier",
    countries: [],
    apiState: "partner_only",
    apiDetail: "Connector API is available on request with an active paid subscription.",
    paymentModel: "subscription",
    verification: "unverified",
    notes: "A marketplace/connector of suppliers, not a supplier. Free tier is browse-only."
  }),
  Object.freeze({
    id: "dsers",
    name: "DSers",
    layer: "automation",
    isSupplier: false,
    orderModel: "single_unit",
    singleUnitEligible: "depends_on_connected_supplier",
    countries: [],
    apiState: "mcp_only",
    apiDetail: "Official AliExpress/Alibaba/1688 partner. MCP with OAuth 2.1 + PKCE; no general public REST confirmed.",
    paymentModel: "subscription",
    verification: "unverified",
    notes: "Order automation in front of AliExpress/Alibaba. It never owns inventory and cannot be treated as a supplier."
  }),
  Object.freeze({
    id: "printful",
    name: "Printful",
    layer: "fulfiller",
    isSupplier: false,
    orderModel: "print_on_demand",
    singleUnitEligible: "yes",
    countries: ["US", "EU", "MX"],
    apiState: "public_api",
    apiDetail: "API v2 with an account token. Some catalog products are excluded from the API.",
    paymentModel: "per_order",
    verification: "unverified",
    notes: "Print-on-demand fulfiller with no inventory risk, but per-unit cost is higher than wholesale."
  }),
  Object.freeze({
    id: "amazon_mcf",
    name: "Amazon Multi-Channel Fulfillment",
    layer: "fulfiller",
    isSupplier: false,
    orderModel: "seller_owned_3pl",
    singleUnitEligible: "yes",
    countries: ["US"],
    apiState: "partner_only",
    apiDetail: "SP-API Fulfillment Outbound with an approved seller app and refresh token.",
    paymentModel: "per_order_fee",
    verification: "unverified",
    notes: "Fulfils seller-owned FBA inventory for off-Amazon orders. It is not a sourcing channel and cannot supply goods."
  }),
  Object.freeze({
    id: "tiktok_fbt",
    name: "Fulfilled by TikTok",
    layer: "marketplace",
    isSupplier: false,
    orderModel: "seller_owned_3pl",
    singleUnitEligible: "yes",
    countries: ["US"],
    apiState: "unverified",
    apiDetail: "Seller-owned inventory handed to TikTok's fulfilment network; program availability is account-specific.",
    paymentModel: "per_order_fee",
    verification: "unverified",
    notes: "Does not permit an international third-party supplier to ship directly to a US buyer."
  })
]);

const byId = new Map(SUPPLIER_CATALOG.map(entry => [entry.id, entry]));

export function listSuppliers({ layer = null, orderModel = null, country = null } = {}) {
  const wantedCountry = String(country || "").trim().toUpperCase();
  return SUPPLIER_CATALOG
    .filter(entry => (layer ? entry.layer === String(layer) : true))
    .filter(entry => (orderModel ? entry.orderModel === String(orderModel) : true))
    .filter(entry => (wantedCountry ? entry.countries.includes(wantedCountry) : true))
    .map(entry => ({ ...entry }));
}

export function getSupplier(id) {
  const entry = byId.get(String(id || "").trim().toLowerCase());
  return entry ? { ...entry } : null;
}

export function catalogSummary() {
  const byLayer = {};
  const byOrderModel = {};
  const byVerification = {};
  for (const entry of SUPPLIER_CATALOG) {
    byLayer[entry.layer] = (byLayer[entry.layer] || 0) + 1;
    byOrderModel[entry.orderModel] = (byOrderModel[entry.orderModel] || 0) + 1;
    byVerification[entry.verification] = (byVerification[entry.verification] || 0) + 1;
  }
  return {
    ok: true,
    count: SUPPLIER_CATALOG.length,
    byLayer,
    byOrderModel,
    byVerification,
    suppliers: SUPPLIER_CATALOG.filter(entry => entry.isSupplier).length,
    automationLayers: SUPPLIER_CATALOG.filter(entry => entry.layer === "automation").length,
    connected: 0,
    externalCalls: false,
    note: "Static catalog. No provider is connected, authenticated or contacted."
  };
}

const REFUSAL = reasons => ({ ok: false, code: "supplier_fit_refused", reasons, externalCallPerformed: false, orderSubmitted: false });

/**
 * Read-only fit check for one supplier and one prospective order. It never creates a quote and
 * never contacts the provider; the furthest it goes is naming what a live quote would need.
 */
export function evaluateSupplierFit({
  supplierId,
  quantity = 1,
  destinationCountry = null,
  inventoryOwnership = "unknown",
  unitCostUsd = null,
  shippingUsd = null
} = {}) {
  const supplier = getSupplier(supplierId);
  const reasons = [];
  if (!supplier) return REFUSAL(["unknown_supplier"]);
  if (supplier.isSupplier !== true) reasons.push("automation_or_fulfiller_not_a_supplier");
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) reasons.push("invalid_quantity");
  if (supplier.orderModel === "wholesale_moq" && supplier.singleUnitEligible !== "yes" && qty < 2) {
    reasons.push("moq_requires_selected_dropshipping_offer");
  }
  if (supplier.orderModel === "seller_owned_3pl" && String(inventoryOwnership).toLowerCase() !== "seller_owned") {
    reasons.push("seller_owned_inventory_required");
  }
  const destination = String(destinationCountry || "").trim().toUpperCase();
  if (destination && supplier.countries.length && !supplier.countries.includes(destination) && supplier.layer === "fulfiller") {
    reasons.push("destination_not_served");
  }
  if (reasons.length) return REFUSAL([...new Set(reasons)]);

  return {
    ok: true,
    code: "REQUIRES_LIVE_QUOTE",
    supplierId: supplier.id,
    supplierLayer: supplier.layer,
    orderModel: supplier.orderModel,
    apiState: supplier.apiState,
    quoteRequest: {
      supplierId: supplier.id,
      quantity: qty,
      destinationCountry: destination || null,
      requestedFields: ["itemsTotal", "shippingTotal", "dispatchEstimate", "currency", "quoteExpiresAt"],
      unitCostUsd: Number.isFinite(Number(unitCostUsd)) ? Number(unitCostUsd) : null,
      shippingUsd: Number.isFinite(Number(shippingUsd)) ? Number(shippingUsd) : null
    },
    externalCallPerformed: false,
    orderSubmitted: false,
    requiresOwnerApproval: true,
    requiresLiveQuote: true,
    note: "A live quote has not been fetched. Purchasing additionally requires an owner approval bound to that exact quote."
  };
}
