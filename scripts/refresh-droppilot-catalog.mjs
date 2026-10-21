#!/usr/bin/env node
/**
 * Refresh a read-only snapshot of active Shopify catalog data.
 *
 * This script never edits products, prices, inventory, listings, or publishes
 * content. Supplier shipping, platform fees, demand, and supplier reliability
 * are deliberately not inferred from Shopify catalog fields.
 *
 * Required environment:
 *   SHOPIFY_STORE_DOMAIN (e.g. example.myshopify.com)
 *   SHOPIFY_ADMIN_ACCESS_TOKEN (read_products scope; read_inventory may be
 *     needed by the shop's configuration for inventory quantities)
 *
 * Usage:
 *   node scripts/refresh-droppilot-catalog.mjs
 *   node scripts/refresh-droppilot-catalog.mjs --out dist/catalog.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeShopifyStoreDomain, validateShopifyApiVersion } from "../shopify-store-domain.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const rawDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim();
const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
const rawApiVersion = process.env.SHOPIFY_API_VERSION?.trim() || "2026-07";
const outputPath = arg("--out", "data/droppilot-active-product-video-manifest.json");

if (!rawDomain || !token) {
  console.error("Catalog refresh requires SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN. No catalog file was changed.");
  process.exit(2);
}
let domain;
let apiVersion;
try {
  domain = normalizeShopifyStoreDomain(rawDomain);
  apiVersion = validateShopifyApiVersion(rawApiVersion);
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(2);
}

const endpoint = `https://${domain}/admin/api/${apiVersion}/graphql.json`;
async function graphql(query, variables = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length || !body.data) {
    const messages = (body.errors || []).map(e => e.message).join("; ");
    throw new Error(`Shopify GraphQL request failed (HTTP ${response.status})${messages ? ": " + messages : ""}`);
  }
  return body.data;
}

const query = `
query ActiveProducts($cursor: String) {
  products(first: 100, after: $cursor, query: "status:active", sortKey: TITLE) {
    nodes {
      id title handle vendor status productType tags totalInventory
      variants(first: 250) {
        nodes { id title price inventoryQuantity inventoryPolicy sku }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const products = [];
let cursor = null;
let pages = 0;
do {
  const data = await graphql(query, { cursor });
  const connection = data.products;
  for (const p of connection.nodes) {
    if (p.variants.pageInfo.hasNextPage) {
      throw new Error(`Product "${p.title}" has more than 250 variants; refusing to write an incomplete catalog snapshot.`);
    }
    const variants = p.variants.nodes.map(v => ({
      shopifyVariantId: v.id,
      title: v.title,
      price: Number(v.price),
      currency: "USD",
      inventoryQuantity: Number.isFinite(v.inventoryQuantity) ? v.inventoryQuantity : null,
      inventoryPolicy: v.inventoryPolicy,
      sku: v.sku || null
    }));
    const prices = variants.map(v => v.price).filter(n => Number.isFinite(n) && n > 0);
    products.push({
      shopifyProductId: p.id,
      title: p.title,
      handle: p.handle,
      productUrl: `https://${domain}/products/${p.handle}`,
      vendor: p.vendor,
      status: p.status,
      productType: p.productType || "",
      tags: p.tags,
      totalInventory: Number.isFinite(p.totalInventory) ? p.totalInventory : null,
      minVariantPrice: prices.length ? Math.min(...prices) : null,
      maxVariantPrice: prices.length ? Math.max(...prices) : null,
      currency: "USD",
      variantsCount: variants.length,
      variants
    });
  }
  pages += 1;
  cursor = connection.pageInfo.endCursor;
  if (!connection.pageInfo.hasNextPage) break;
  if (!cursor) throw new Error("Shopify reported another product page but supplied no cursor; refusing to write an incomplete snapshot.");
} while (pages < 100);

if (pages >= 100) throw new Error("Catalog pagination safety limit reached; refusing to write a potentially incomplete snapshot.");
if (!products.length) throw new Error("Shopify returned zero active products; refusing to replace the existing catalog with an empty snapshot.");

const manifest = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  store: "DropPilot",
  storeUrl: `https://${domain}`,
  note: "Live read-only Shopify snapshot. Prices, product status, and inventory are point-in-time values. Supplier costs, supplier shipping, platform/payment fees, demand, demo potential, and supplier reliability are not inferred; every product must pass the separate evidence-based economics gate.",
  activeProductCount: products.length,
  variantCount: products.reduce((sum, p) => sum + p.variantsCount, 0),
  products
};

const dir = path.dirname(outputPath);
await fs.mkdir(dir, { recursive: true });
const tempPath = `${outputPath}.tmp`;
await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
await fs.rename(tempPath, outputPath);
console.log(JSON.stringify({
  refreshed: true,
  outputPath,
  generatedAt: manifest.generatedAt,
  activeProductCount: manifest.activeProductCount,
  variantCount: manifest.variantCount,
  note: "Catalog data refreshed only; no products or content were published."
}, null, 2));
