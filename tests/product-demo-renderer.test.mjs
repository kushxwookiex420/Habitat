import test from "node:test";
import assert from "node:assert/strict";
import { registerProductDemoRenderer } from "../product-demo-renderer.mjs";

function makeHarness() {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set("GET " + path, handler); },
    post(path, handler) { routes.set("POST " + path, handler); }
  };
  registerProductDemoRenderer(app);
  const handler = routes.get("POST /product-demo/render");
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  return { handler, response };
}

const baseBody = {
  productName: "HOTO AutoCare Air Duster & Vacuum",
  voiceover: "See how this compact cleaner tackles small messes in your car and around your desk.",
  clips: [
    { url: "https://media.example.com/vacuum.mp4", startSeconds: 0, endSeconds: 5, permissionConfirmed: true, action: "vacuuming", sourceTitle: "Vacuum demo" },
    { url: "https://media.example.com/blower.mp4", startSeconds: 0, endSeconds: 5, permissionConfirmed: true, action: "blowing", sourceTitle: "Blower demo" }
  ]
};

test("product demo rejects footage without an explicit real-action label", async () => {
  const { handler, response } = makeHarness();
  const body = structuredClone(baseBody);
  delete body.clips[0].action;
  await handler({ body }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /action: vacuuming, blowing, or attachments-in-use/i);
});

test("product demo rejects repeated single-action footage", async () => {
  const { handler, response } = makeHarness();
  const body = structuredClone(baseBody);
  body.clips[1].action = "vacuuming";
  await handler({ body }, response);
  assert.equal(response.statusCode, 422);
  assert.match(response.payload.error, /at least two distinct real product actions/i);
});

test("product demo rejects footage without confirmed commercial reuse permission", async () => {
  const { handler, response } = makeHarness();
  const body = structuredClone(baseBody);
  body.clips[1].permissionConfirmed = false;
  await handler({ body }, response);
  assert.equal(response.statusCode, 403);
  assert.match(response.payload.error, /confirmed commercial reuse permission/i);
});


test("product demo rejects a missing product name before downloading media", async () => {
  const { handler, response } = makeHarness();
  const body = structuredClone(baseBody);
  body.productName = "   ";
  await handler({ body }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /productName is required/i);
});

test("product demo rejects narration too short to support a complete sales message", async () => {
  const { handler, response } = makeHarness();
  const body = structuredClone(baseBody);
  body.voiceover = "Buy it now.";
  await handler({ body }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /fact-checked voiceover of at least 40 characters/i);
});

test("product demo rejects more clips than the renderer's safety limit", async () => {
  const { handler, response } = makeHarness();
  const body = structuredClone(baseBody);
  body.clips = [...body.clips, ...body.clips, ...body.clips];
  await handler({ body }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /supply 1 to 4 direct video clips/i);
});
