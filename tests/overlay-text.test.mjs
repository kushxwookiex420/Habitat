import test from "node:test";
import assert from "node:assert/strict";
import { wrapOverlayText } from "../overlay-text.mjs";

test("wraps long product names and CTAs without exceeding line limit", () => {
  for (const [value, limit] of [
    ["Portable Rechargeable Kitchen Countertop Food Chopper", 22],
    ["See product details at DropPilot AI and shop today", 40],
    ["SKU_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 12]
  ]) {
    const wrapped = wrapOverlayText(value, limit);
    assert.ok(wrapped.length > 0);
    assert.ok(wrapped.split("\\n").every(line => line.length <= limit));
  }
});

test("preserves readable words and text order", () => {
  const wrapped = wrapOverlayText("Small home kitchen helper", 10);
  assert.equal(wrapped.split("\\n").join(" "), "Small home kitchen helper");
});

test("handles empty copy and invalid width safely", () => {
  assert.equal(wrapOverlayText("", 20), "");
  assert.equal(wrapOverlayText("abcdef", 0), "a\\nb\\nc\\nd\\ne\\nf");
});
