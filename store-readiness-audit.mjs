const ACTIVE = "ACTIVE";
const DRAFT = "DRAFT";

function isPositiveMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Pure, read-only audit of a normalized Shopify catalog snapshot.
 * Does not change products, collections, prices, inventory, or publication.
 */
export function auditStoreReadiness({ shop, products = [], collections = [] } = {}) {
  const findings = [];
  const add = (severity, code, message, details = {}) =>
    findings.push({ severity, code, message, ...details });

  if (!shop || !String(shop.domain || "").trim()) {
    add("HOLD", "shop_identity_missing", "Connected shop identity is missing.");
  }
  if (!Array.isArray(products)) {
    add("HOLD", "product_snapshot_invalid", "Product snapshot is not an array.");
    products = [];
  }
  if (!Array.isArray(collections)) {
    add("HOLD", "collection_snapshot_invalid", "Collection snapshot is not an array.");
    collections = [];
  }

  const handles = new Map();
  for (const p of products) {
    const id = String(p?.id || "");
    const title = String(p?.title || "").trim();
    const status = String(p?.status || "").toUpperCase();
    const inventory = Number(p?.inventory);
    const price = p?.price;
    const hasImage = p?.hasImage === true;
    const supplier = String(p?.supplier || "").trim();
    const supplierCostVerified = p?.supplierCostVerified === true;
    const netMarginVerified = p?.netMarginVerified === true;

    if (!id || !title) {
      add("HOLD", "product_identity_incomplete", "Product lacks an ID or title.", { productId: id || null });
      continue;
    }

    const handle = String(p?.handle || "").trim().toLowerCase();
    if (handle) {
      const previous = handles.get(handle);
      if (previous) add("WARN", "duplicate_handle", "Products share a handle.", { productIds: [previous, id], handle });
      else handles.set(handle, id);
    }

    if (!["ACTIVE", "DRAFT", "ARCHIVED"].includes(status)) {
      add("HOLD", "product_status_unknown", "Product status is missing or unsupported.", { productId: id, title });
    }
    if (status === ACTIVE && Number.isFinite(inventory) && inventory <= 0) {
      add("HOLD", "active_product_no_stock", "Active product reports zero or negative inventory.", { productId: id, title });
    }
    if (!isPositiveMoney(price)) {
      add("HOLD", "invalid_selling_price", "Selling price is missing or not positive.", { productId: id, title });
    }
    if (!hasImage) {
      add("WARN", "product_image_missing", "Product has no confirmed featured image.", { productId: id, title });
    }
    if (!supplier) {
      add("WARN", "supplier_mapping_missing", "Supplier identity is not confirmed.", { productId: id, title });
    }
    if (!supplierCostVerified || !netMarginVerified) {
      add("HOLD", "profitability_unverified", "Fresh supplier cost and net-margin evidence are required before promotion.", { productId: id, title });
    }
  }

  const collectionNames = new Set();
  for (const c of collections) {
    const name = String(c?.title || "").trim();
    const count = Number(c?.productCount);
    if (!name) {
      add("WARN", "collection_title_missing", "A collection has no confirmed title.");
      continue;
    }
    const key = name.toLowerCase();
    if (collectionNames.has(key)) add("WARN", "duplicate_collection_title", "Collection titles are duplicated.", { title: name });
    collectionNames.add(key);
    if (Number.isFinite(count) && count === 0) {
      add("WARN", "empty_collection", "Collection has no products.", { title: name });
    }
    if (c?.published === false) {
      add("WARN", "collection_not_published", "Collection is not confirmed published.", { title: name });
    }
  }

  const holds = findings.filter(x => x.severity === "HOLD").length;
  const warnings = findings.filter(x => x.severity === "WARN").length;
  return {
    decision: holds > 0 ? "HOLD" : warnings > 0 ? "REVIEW" : "PASS",
    productCount: products.length,
    collectionCount: collections.length,
    holdCount: holds,
    warningCount: warnings,
    findings
  };
}
