import test from "node:test";
import assert from "node:assert/strict";
import { parseDuckDuckGo, parseBing, isProductRelevant, buildResearchQueries, hasVideoSignal } from "../product-demo-research.mjs";

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


test("research queries exclude noisy Shopify productType categories", () => {
  const queries = buildResearchQueries({
    productName: "Bamboo Expandable Drawer Dividers",
    brand: "",
    model: "",
    category: "ALUBK289ASX"
  });
  assert.equal(queries.length, 6);
  assert.ok(queries.every(query => !query.includes("ALUBK289ASX")));
  assert.ok(queries.some(query => query.includes("Bamboo Expandable Drawer Dividers")));
  const broadCategory = buildResearchQueries({
    productName: "The 5 Elements Bamboo Large Kitchen Utensils Set",
    category: "Home Decor"
  });
  assert.ok(broadCategory.every(query => !query.includes("Home Decor")));
});


test("generic lawn-care guides are not treated as reusable makeup-pad demos", () => {
  const product = "12PC Reusable Cotton Pads Makeup Remover Pads Washable Round Bamboo Make Up Pads Cloth Nursing Pads Skin Care Tool Skin Cleaning";
  assert.equal(isProductRelevant(product, "", "", {
    title: "How to Make Grass Thicker & Fuller (Complete Guide)",
    url: "https://yardthyme.com/lawn-care/how-to-make-grass-thicker-greener-and-fuller/",
    snippet: "Tips for a greener lawn"
  }), false);
});

test("generic egg-cooking videos are not treated as egg-holder product demos", () => {
  const product = "Egg Container Holder for Refrigerator Double Layer Egg Storage Box Organizer Bin Tray Rack";
  assert.equal(isProductRelevant(product, "", "", {
    title: "How To Cook Perfect Eggs Every Time - YouTube",
    url: "https://m.youtube.com/watch?v=video123",
    snippet: "Learn to cook eggs perfectly"
  }), false);
  assert.equal(isProductRelevant(product, "", "", {
    title: "Double Layer Egg Holder Storage Rack Demo",
    url: "https://www.youtube.com/watch?v=holder-demo",
    snippet: "A refrigerator egg holder in use"
  }), true);
});


test("generic publisher homepages are not product-specific video leads", () => {
  const trashCan = "Car Trash Can Organizer Garbage Holder Automobiles Storage Bag Accessories Auto Door Seat Back Visor Trash Bin Paper Dustbin Mini Bins Storage Bag Accessories Auto";
  const row = {
    title: "Car and Driver: New Car Reviews, Buying Advice and News",
    url: "https://www.caranddriver.com/",
    snippet: "Car reviews and automotive news"
  };
  assert.equal(isProductRelevant(trashCan, "", "", row), false);
  assert.equal(hasVideoSignal(row), false);
});

test("video classification requires an actual video signal rather than generic review wording", () => {
  assert.equal(hasVideoSignal({
    title: "Car and Driver: New Car Reviews, Buying Advice and News",
    url: "https://www.caranddriver.com/",
    snippet: "Read reviews"
  }), false);
  assert.equal(hasVideoSignal({
    title: "Trash can organizer product demo",
    url: "https://www.youtube.com/watch?v=example",
    snippet: "Watch the organizer in use"
  }), true);
  assert.equal(hasVideoSignal({
    title: "Product review",
    url: "https://example.com/blog/product-review",
    snippet: "A written review of the product"
  }), false);
});
