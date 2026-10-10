import test from "node:test";
import assert from "node:assert/strict";
import { parseDuckDuckGo } from "../product-demo-research.mjs";

test("parses standard DuckDuckGo result anchors and snippets", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="https://example.com/product-demo">Product demo video</a>
      <div class="result__snippet">Watch the product in action</div>
    </div>`;
  const rows = parseDuckDuckGo(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Product demo video");
  assert.equal(rows[0].url, "https://example.com/product-demo");
  assert.match(rows[0].snippet, /product in action/i);
});

test("decodes DuckDuckGo redirect URLs", () => {
  const target = encodeURIComponent("https://example.org/watch?id=123");
  const rows = parseDuckDuckGo(`<a class="result__a" href="https://duckduckgo.com/l/?uddg=${target}">Supplier video</a>`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://example.org/watch?id=123");
});

test("fallback parser accepts lite-layout result links", () => {
  const html = `
    <table><tr><td><a href="https://supplier.example/demo">Official product demonstration</a></td></tr></table>`;
  const rows = parseDuckDuckGo(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://supplier.example/demo");
});

test("ignores navigation links and duplicate result URLs", () => {
  const html = `
    <a href="https://duckduckgo.com/lite/">Next</a>
    <a href="https://example.com/demo">Demo one</a>
    <a href="https://example.com/demo">Demo duplicate</a>`;
  const rows = parseDuckDuckGo(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Demo one");
});
