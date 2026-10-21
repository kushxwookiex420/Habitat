import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShopifyStoreDomain, validateShopifyApiVersion } from "../shopify-store-domain.mjs";

test("normalizes valid Shopify-managed store hostnames", () => {
  assert.equal(normalizeShopifyStoreDomain("https://2tanuk-yx.myshopify.com/"), "2tanuk-yx.myshopify.com");
  assert.equal(normalizeShopifyStoreDomain("DEMO.myshopify.com"), "demo.myshopify.com");
});

test("rejects arbitrary hosts, paths, ports, credentials, and malformed domains", () => {
  for (const value of [
    "attacker.example",
    "example.myshopify.com.attacker.example",
    "example.myshopify.com/path",
    "example.myshopify.com:443",
    "user@example.myshopify.com",
    ".myshopify.com",
    "-bad.myshopify.com",
    "bad-.myshopify.com",
    ""
  ]) assert.throws(() => normalizeShopifyStoreDomain(value), /SHOPIFY_STORE_DOMAIN/);
});

test("accepts valid Shopify API version strings and rejects path injection or invalid months", () => {
  assert.equal(validateShopifyApiVersion("2026-07"), "2026-07");
  for (const value of ["2026-00", "2026-13", "2026-7", "2026-07/graphql.json", "../2026-07", ""]) {
    assert.throws(() => validateShopifyApiVersion(value), /SHOPIFY_API_VERSION/);
  }
});
