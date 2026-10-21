const SHOPIFY_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/i;
const API_VERSION_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeShopifyStoreDomain(raw) {
  const domain = String(raw ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!SHOPIFY_HOST_RE.test(domain)) {
    throw new Error("SHOPIFY_STORE_DOMAIN must be a Shopify-managed *.myshopify.com hostname, without a path. No catalog file was changed.");
  }
  return domain.toLowerCase();
}

export function validateShopifyApiVersion(raw) {
  const version = String(raw ?? "").trim();
  if (!API_VERSION_RE.test(version)) {
    throw new Error("SHOPIFY_API_VERSION must use YYYY-MM format with a valid month.");
  }
  return version;
}
