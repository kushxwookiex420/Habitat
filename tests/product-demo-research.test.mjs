import test from "node:test";
import assert from "node:assert/strict";
import { parseDuckDuckGo, parseBing, isProductRelevant } from "../product-demo-research.mjs";

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


test("unwraps Bing redirect URLs to the actual destination", () => {
  const target = "https://www.youtube.com/watch?v=demo123";
  const encoded = "a1" + Buffer.from(target).toString("base64url");
  const rows = parseBing(`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}">Sink splash guard demo</a></h2><p>Silicone sink splash guard in use</p></li>`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, target);
});

test("rejects unrelated search results as product evidence", () => {
  assert.equal(isProductRelevant("Silicone Sink Splash Guard", "DailySale", "", {
    title: "Citi Online Banking", url: "https://www.citi.com/", snippet: "Manage your bank account"
  }), false);
  assert.equal(isProductRelevant("Silicone Sink Splash Guard", "DailySale", "", {
    title: "Silicone Sink Splash Guard Product Demo", url: "https://example.com/demo", snippet: "See it in use"
  }), true);
});
