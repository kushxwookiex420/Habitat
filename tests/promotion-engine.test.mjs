import test from "node:test";
import assert from "node:assert/strict";
import { buildPromotionPlan, registerPromotionEngine } from "../promotion-engine.mjs";

const base = {
  productName: "Universal Car Seat Gap Organizer",
  productUrl: "https://2tanuk-yx.myshopify.com/products/car-organizer",
  productStatus: "active",
  availableForSale: true,
  category: "Car organization",
  features: ["Multiple storage pockets", "Available in four colors"],
  networks: ["tiktok", "instagram", "facebook", "pinterest", "youtube", "x", "threads", "bluesky"]
};

test("builds distinct multi-network drafts with tracked links", () => {
  const plan = buildPromotionPlan(base);
  assert.equal(plan.count, 8);
  assert.equal(plan.publishing.status, "not_published");
  assert.equal(plan.publishing.humanReviewRequired, true);
  assert.equal(plan.campaignSummary.length, plan.count);
  assert.equal(plan.campaignSummary[0].requiresHumanApproval, true);
  for (const draft of plan.drafts) {
    const url = new URL(draft.trackedUrl);
    assert.equal(url.searchParams.get("utm_source"), draft.network);
    assert.equal(url.searchParams.get("utm_medium"), "social");
    assert.equal(url.searchParams.get("utm_campaign"), plan.campaign);
    assert.match(draft.caption, /DropPilotMarket/);
    assert.equal(draft.published, false);
  }
  assert.notEqual(plan.drafts[0].caption, plan.drafts[1].caption);
});

test("requires active and available products on the configured store domain", () => {
  assert.throws(() => buildPromotionPlan({ ...base, productStatus: "draft" }), /active/);
  assert.throws(() => buildPromotionPlan({ ...base, availableForSale: false }), /availableForSale/);
  assert.throws(() => buildPromotionPlan({ ...base, productUrl: "https://example.com/products/item" }), /configured DropPilot Shopify store domain/);
  assert.throws(() => buildPromotionPlan({ ...base, productUrl: "https://2tanuk-yx.myshopify.com/collections/all" }), /product page/);
});

test("validates platform-specific caption length", () => {
  assert.throws(() => buildPromotionPlan({ ...base, productName: "X".repeat(180), features: ["F".repeat(100), "G".repeat(100), "H".repeat(100)], networks: ["bluesky"] }), /Caption exceeds bluesky limit/);
});

test("rejects missing product name or URL and insecure destinations", () => {
  assert.throws(() => buildPromotionPlan({ productUrl: base.productUrl }), /productName is required/);
  assert.throws(() => buildPromotionPlan({ productName: "Item" }), /productUrl is required/);
  assert.throws(() => buildPromotionPlan({ productName: "Item", productUrl: "http://example.com/item" }), /HTTPS/);
});

test("rejects unsupported networks and deduplicates requested networks", () => {
  assert.throws(() => buildPromotionPlan({ ...base, networks: ["carrier-pigeon"] }), /Unsupported network/);
  const plan = buildPromotionPlan({ ...base, networks: ["tiktok", "tiktok"] });
  assert.equal(plan.count, 1);
});

test("uses only supplied factual features and bounds feature count", () => {
  const plan = buildPromotionPlan({ ...base, features: ["Fact one", "Fact two", "Fact three", "Fact four", "Fact five", "Fact six"] });
  assert.deepEqual(plan.product.features, ["Fact one", "Fact two", "Fact three", "Fact four", "Fact five"]);
  assert.match(plan.drafts[0].caption, /Fact one/);
  assert.doesNotMatch(plan.drafts[0].caption, /guaranteed|best-selling|clinically proven/i);
});

test("registers a draft-only API and exposes truthful publishing status", () => {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set("GET " + path, handler); },
    post(path, handler) { routes.set("POST " + path, handler); }
  };
  registerPromotionEngine(app);
  assert.equal(typeof routes.get("GET /promotion/status"), "function");
  assert.equal(typeof routes.get("POST /promotion/plan"), "function");
});
