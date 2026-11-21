import test from "node:test";
import assert from "node:assert/strict";
import { createTaskAuthorizer, secretEqual } from "../task-authorizer.mjs";

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function middleware(overrides = {}) {
  return createTaskAuthorizer({
    internalToken: "internal-test-token",
    getAxToken: () => "ax-test-token",
    authorizeOwner: async () => ({ ok: false, status: 401, code: "owner_required", error: "owner required" }),
    ...overrides
  });
}

test("constant-time secret comparison rejects empty and different-length values", () => {
  assert.equal(secretEqual("abc", "abc"), true);
  assert.equal(secretEqual("", ""), false);
  assert.equal(secretEqual("abc", "abcd"), false);
  assert.equal(secretEqual(undefined, "abc"), false);
});

test("the internal loopback token authorizes /chat's own task calls", async () => {
  let called = false;
  await middleware()({ headers: { "x-habitat-internal-token": "internal-test-token" } }, fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test("the Ax bridge operator token authorizes task routes", async () => {
  let called = false;
  await middleware()({ headers: { authorization: "Bearer ax-test-token" } }, fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test("a verified owner device authorizes task routes", async () => {
  let called = false;
  const mw = middleware({ authorizeOwner: async () => ({ ok: true }) });
  await mw({ headers: { "x-owner-device-id": "dev_owner", authorization: "Bearer device-token" } }, fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test("missing, wrong, and unverified callers are rejected", async () => {
  for (const headers of [
    {},
    { "x-habitat-internal-token": "wrong" },
    { authorization: "Bearer wrong" },
    { "x-owner-device-id": "dev_owner", authorization: "Bearer wrong" }
  ]) {
    let called = false;
    const res = fakeRes();
    await middleware()({ headers }, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "owner_required");
  }
});

test("a store outage is surfaced as 503 instead of a misleading 401", async () => {
  const res = fakeRes();
  const mw = middleware({
    authorizeOwner: async () => ({ ok: false, status: 503, code: "owner_unavailable", error: "store unavailable" })
  });
  await mw({ headers: { "x-owner-device-id": "dev_owner", authorization: "Bearer token" } }, res, () => {});
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "owner_unavailable");
});
