import test from "node:test";
import assert from "node:assert/strict";
import { registerProductImageVideo, validatePublicImageUrl } from "../product-image-video.mjs";

function makeHarness() {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set("GET " + path, handler); },
    post(path, handler) { routes.set("POST " + path, handler); }
  };
  registerProductImageVideo(app);
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  return { routes, response };
}

test("product-picture video rejects a missing product name", async () => {
  const { routes, response } = makeHarness();
  await routes.get("POST /product-image-video/render")({ body: { imageUrl: "https://example.com/image.jpg" } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /productName is required/i);
});

test("product-picture video requires an image URL", async () => {
  const { routes, response } = makeHarness();
  await routes.get("POST /product-image-video/render")({ body: { productName: "Test product" } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /imageUrl is required/i);
});

test("product-picture video refuses unverified prices", async () => {
  const { routes, response } = makeHarness();
  await routes.get("POST /product-image-video/render")({
    body: { productName: "Test product", imageUrl: "https://example.com/image.jpg", price: "$19.99" }
  }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /priceVerified is true/i);
});

test("product-picture renderer only accepts HTTPS image URLs", async () => {
  await assert.rejects(() => validatePublicImageUrl("http://example.com/image.jpg"), /public HTTPS/i);
  await assert.rejects(() => validatePublicImageUrl("file:///etc/passwd"), /public HTTPS/i);
});

test("product-picture renderer rejects private and localhost hosts", async () => {
  await assert.rejects(() => validatePublicImageUrl("https://127.0.0.1/image.jpg"), /Private IP/i);
  await assert.rejects(() => validatePublicImageUrl("https://localhost/image.jpg"), /Private\/local/i);
});

test("product-picture renderer registers status, render, and artifact routes", () => {
  const { routes } = makeHarness();
  assert.ok(routes.has("GET /product-image-video/status"));
  assert.ok(routes.has("POST /product-image-video/render"));
  assert.ok(routes.has("GET /product-image-video/:id/artifact"));
});
