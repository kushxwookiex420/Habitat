#!/usr/bin/env node
/**
 * Rank DropPilot products only when economics and demand evidence are supplied.
 *
 * This tool deliberately does not scrape Amazon or treat Amazon retail prices as
 * supplier costs. Populate data/droppilot-supplier-enrichment.json from permitted
 * research/API sources and verified supplier quotes before relying on rankings.
 *
 * Usage:
 *   node scripts/rank-droppilot-products.mjs
 *   node scripts/rank-droppilot-products.mjs --manifest path/to/manifest.json --enrichment path/to/enrichment.json --out dist/droppilot-ranked-products.json
 *
 * Enrichment schema:
 * {
 *   "products": [{
 *     "shopifyProductId": "gid://shopify/Product/...",
 *     "supplierCost": 8.50,
 *     "shippingCost": 2.00,
 *     "platformFeeRate": 0.08,
 *     "paymentFeeRate": 0.03,
 *     "otherPerOrderCosts": 0.50,
 *     "demandScore": 0-100,
 *     "demoScore": 0-100,
 *     "supplierReliabilityScore": 0-100,
 *     "evidenceUrl": "https://...",
 *     "evidenceCheckedAt": "ISO-8601 timestamp"
 *   }]
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const manifestPath = arg("--manifest", "data/droppilot-active-product-video-manifest.json");
const enrichmentPath = arg("--enrichment", "data/droppilot-supplier-enrichment.json");
const outputPath = arg("--out", "dist/droppilot-ranked-products.json");

export function normalizeCategory(title = "", productType = "") {
  const value = (String(title) + " " + String(productType)).toLowerCase();
  const groups = [
    ["home_storage", /storage|organizer|drawer|shelf|rack|cabinet|closet|pantry|under sink/],
    ["kitchen", /kitchen|spice|strainer|colander|cutting board|utensil|sink|food prep/],
    ["car_accessories", /car |automotive|vehicle|seat gap|trunk|windshield|detailing|vacuum cleaner|visor/],
    ["cleaning", /cleaner|cleaning|brush kit|mop|scrub|duster|squeegee/],
    ["bed_bath", /blanket|bedding|pillow|bathroom|shower|towel|mattress/],
    ["pet", /pet |dog |cat |litter|leash|aquarium/],
    ["electronics", /electronic|charger|cable|led |lamp|light|speaker|camera|power bank/],
    ["fitness_outdoors", /fitness|exercise|workout|camping|hiking|outdoor|bike|bicycle/],
    ["beauty_personal_care", /beauty|makeup|cosmetic|skin care|hair|manicure|vanity/],
  ];
  for (const [category, pattern] of groups) if (pattern.test(value)) return category;
  return "other_review_required";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function boundedScore(value) {
  return finite(value) && value >= 0 && value <= 100;
}
function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function evaluateProduct(product, enrichment) {
  const price = Number(product.minVariantPrice);
  const costFields = ["supplierCost", "shippingCost", "otherPerOrderCosts"];
  const missing = [];
  if (!Number.isFinite(price) || price <= 0) missing.push("verified selling price");
  for (const key of costFields) {
    if (!finite(enrichment?.[key]) || enrichment[key] < 0) missing.push(key);
  }
  for (const key of ["platformFeeRate", "paymentFeeRate"]) {
    if (!finite(enrichment?.[key]) || enrichment[key] < 0 || enrichment[key] >= 1) missing.push(key);
  }
  for (const key of ["demandScore", "demoScore", "supplierReliabilityScore"]) {
    if (!boundedScore(enrichment?.[key])) missing.push(key + " (0-100)");
  }
  if (!enrichment?.evidenceUrl || !/^https?:\/\//i.test(enrichment.evidenceUrl)) missing.push("evidenceUrl");
  if (!enrichment?.evidenceCheckedAt || !Number.isFinite(Date.parse(enrichment.evidenceCheckedAt))) missing.push("evidenceCheckedAt");

  const category = normalizeCategory(product.title, product.productType);
  const base = {
    shopifyProductId: product.shopifyProductId ?? null,
    title: product.title ?? "",
    productUrl: product.productUrl ?? null,
    category,
    price: Number.isFinite(price) ? price : null,
    status: product.status ?? "unknown",
    inventorySnapshot: Number.isFinite(Number(product.totalInventory)) ? Number(product.totalInventory) : null,
    evidenceUrl: enrichment?.evidenceUrl ?? null,
    evidenceCheckedAt: enrichment?.evidenceCheckedAt ?? null,
  };
  if (missing.length) return { ...base, eligibleForRanking: false, missing, decision: "HOLD_FOR_EVIDENCE" };

  const platformFees = price * enrichment.platformFeeRate;
  const paymentFees = price * enrichment.paymentFeeRate;
  const totalCost = enrichment.supplierCost + enrichment.shippingCost + enrichment.otherPerOrderCosts + platformFees + paymentFees;
  const profit = price - totalCost;
  const marginPercent = (profit / price) * 100;
  const inventory = Number(product.totalInventory);
  const inStock = Number.isFinite(inventory) && inventory > 0;
  // A weighted prioritization score, not a prediction of sales.
  const qualityScore =
    enrichment.demandScore * 0.35 +
    enrichment.demoScore * 0.25 +
    enrichment.supplierReliabilityScore * 0.20 +
    Math.max(0, Math.min(100, marginPercent * 2.5)) * 0.20;
  const decision = !inStock ? "HOLD_STOCK_CHECK"
    : profit <= 0 || marginPercent < 20 ? "REJECT_LOW_MARGIN"
    : "REVIEW_FOR_LISTING";
  return {
    ...base,
    eligibleForRanking: true,
    missing: [],
    supplierCost: money(enrichment.supplierCost),
    shippingCost: money(enrichment.shippingCost),
    platformFees: money(platformFees),
    paymentFees: money(paymentFees),
    otherPerOrderCosts: money(enrichment.otherPerOrderCosts),
    estimatedNetProfitPerOrder: money(profit),
    estimatedNetMarginPercent: money(marginPercent),
    demandScore: enrichment.demandScore,
    demoScore: enrichment.demoScore,
    supplierReliabilityScore: enrichment.supplierReliabilityScore,
    prioritizationScore: money(qualityScore),
    decision,
    disclaimer: "Estimate only; confirm live price, supplier quote, shipping, marketplace fees, taxes, returns, and stock before listing."
  };
}

export async function run() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const products = Array.isArray(manifest) ? manifest : manifest.products;
  if (!Array.isArray(products)) throw new Error("Manifest has no products array.");
  let enrichments = [];
  try {
    const raw = JSON.parse(await fs.readFile(enrichmentPath, "utf8"));
    enrichments = Array.isArray(raw) ? raw : raw.products;
    if (!Array.isArray(enrichments)) throw new Error("Enrichment file must contain a products array.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const byId = new Map(enrichments.filter(x => x.shopifyProductId).map(x => [String(x.shopifyProductId), x]));
  const ranked = products.map(product => evaluateProduct(product, byId.get(String(product.shopifyProductId)) ?? null));
  const eligible = ranked.filter(x => x.eligibleForRanking).sort((a, b) => b.prioritizationScore - a.prioritizationScore);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    store: manifest.store ?? "DropPilot",
    sourceManifest: path.basename(manifestPath),
    productCount: products.length,
    eligibleForRankingCount: eligible.length,
    heldForEvidenceCount: ranked.length - eligible.length,
    reviewForListingCount: ranked.filter(x => x.decision === "REVIEW_FOR_LISTING").length,
    rejectedLowMarginCount: ranked.filter(x => x.decision === "REJECT_LOW_MARGIN").length,
    products: [...eligible, ...ranked.filter(x => !x.eligibleForRanking).sort((a, b) => a.title.localeCompare(b.title))]
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    outputPath,
    productCount: report.productCount,
    eligibleForRankingCount: report.eligibleForRankingCount,
    heldForEvidenceCount: report.heldForEvidenceCount,
    reviewForListingCount: report.reviewForListingCount,
    rejectedLowMarginCount: report.rejectedLowMarginCount
  }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
