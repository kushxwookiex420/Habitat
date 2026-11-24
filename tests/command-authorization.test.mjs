import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createChatCommandAuthorizer } from "../command-auth.mjs";

/**
 * Authorization is the boundary, not the rate limit. These tests pin the properties that matter:
 * an anonymous caller cannot submit, a wrong token cannot submit, a device token must match the
 * paired registry, and a signed request cannot be replayed or replayed with a different message.
 */

const BRIDGE = "bridge_test_token_0123456789";
const COMMAND = "command_test_token_0123456789";
const NOW = Date.parse("2026-11-23T20:00:00.000Z");
const MESSAGE = "inspect the repository state";

function deviceBridge(overrides = {}) {
  return {
    async verifyDevice({ deviceId, token }) {
      return deviceId === "dev_1" && token === "dev_token_1";
    },
    ...overrides
  };
}

function authorizer(options = {}) {
  return createChatCommandAuthorizer({
    env: {
      HABITAT_AX_BRIDGE_TOKEN: BRIDGE,
      HABITAT_AX_COMMAND_TOKEN: COMMAND
    },
    deviceBridge: deviceBridge(),
    now: () => NOW,
    log: { error() {} },
    ...options
  });
}

function signed({ token = BRIDGE, ts = new Date(NOW).toISOString(), nonce = "nonce_0123456789", message = MESSAGE } = {}) {
  const canonical = ["POST", "/chat", ts, nonce, createHash("sha256").update(message, "utf8").digest("hex")].join("\n");
  const signature = createHmac("sha256", token).update(canonical, "utf8").digest("base64");
  return {
    "x-habitat-timestamp": ts,
    "x-habitat-nonce": nonce,
    "x-habitat-signature": signature
  };
}

const req = (headers = {}) => ({ headers, message: MESSAGE });

test("anonymous command submission is refused", async () => {
  const result = await authorizer().authorize(req());
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_credential");
});

test("a wrong bearer token is refused, not downgraded to anonymous", async () => {
  const result = await authorizer().authorize(req({ authorization: "Bearer wrong_token_0123456789" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_credential");
});

test("the owner bridge token authorizes and is attributed", async () => {
  const result = await authorizer().authorize(req({ authorization: "Bearer " + BRIDGE }));
  assert.equal(result.ok, true);
  assert.equal(result.actor, "owner:bridge");
  assert.equal(result.authorization, "ax_bridge");
});

test("the command token also authorizes owner automation", async () => {
  const result = await authorizer().authorize(req({ authorization: "Bearer " + COMMAND }));
  assert.equal(result.ok, true);
  assert.equal(result.actor, "owner:bridge");
});

test("a paired-device credential authorizes only when the registry agrees", async () => {
  const good = await authorizer().authorize(req({
    "x-habitat-device-id": "dev_1",
    "x-habitat-device-token": "dev_token_1"
  }));
  assert.equal(good.ok, true);
  assert.equal(good.actor, "device:dev_1");
  assert.equal(good.authorization, "device_token");

  const bad = await authorizer().authorize(req({
    "x-habitat-device-id": "dev_1",
    "x-habitat-device-token": "stolen_or_wrong_token"
  }));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "device_token_invalid");
});

test("device verification failure fails closed as unavailable", async () => {
  const result = await authorizer({
    deviceBridge: deviceBridge({ async verifyDevice() { throw new Error("D1 unavailable"); } })
  }).authorize(req({ "x-habitat-device-id": "dev_1", "x-habitat-device-token": "dev_token_1" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "device_auth_unavailable");
});

test("a valid owner signature is accepted and attributed as signed", async () => {
  const result = await authorizer().authorize(req(signed()));
  assert.equal(result.ok, true);
  assert.equal(result.actor, "owner:bridge");
  assert.equal(result.authorization, "owner_signature");
});

test("a replayed nonce is refused even with a valid signature", async () => {
  const auth = authorizer();
  const headers = signed({ nonce: "nonce_replay_test_01" });
  const first = await auth.authorize(req(headers));
  assert.equal(first.ok, true);
  const second = await auth.authorize(req(headers));
  assert.equal(second.ok, false);
  assert.equal(second.code, "replayed_nonce");
});

test("a stale timestamp is refused", async () => {
  const stale = new Date(NOW - 10 * 60 * 1000).toISOString();
  const result = await authorizer().authorize(req(signed({ ts: stale, nonce: "nonce_stale_test_01" })));
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_signature");
});

test("a signature over a different message is refused", async () => {
  const headers = signed({ nonce: "nonce_tamper_test_01", message: "delete the database" });
  const result = await authorizer().authorize(req(headers)); // verifier hashes MESSAGE, not the signed text
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad_signature");
});

test("partial signature headers are refused without falling back to bearer", async () => {
  const result = await authorizer().authorize(req({
    authorization: "Bearer " + BRIDGE,
    "x-habitat-timestamp": new Date(NOW).toISOString(),
    "x-habitat-nonce": "nonce_partial_test_1"
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "incomplete_signature");
});

test("signing fails closed when no bridge token is configured", async () => {
  const result = await createChatCommandAuthorizer({
    env: {},
    deviceBridge: deviceBridge(),
    now: () => NOW,
    log: { error() {} }
  }).authorize(req(signed()));
  assert.equal(result.ok, false);
  assert.equal(result.code, "signing_unavailable");
});
