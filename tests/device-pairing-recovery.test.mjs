import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";

/**
 * Pairing behaviour from Issue #90:
 * a code expires, a code is single use server-side, a lost response must not force the owner to
 * generate a new code, a wrong device must be refused, and LINKED is only truthful once an
 * authenticated heartbeat succeeds.
 */

const OPERATOR = "ax_bridge_" + "7".repeat(40);
const CODE = "pairing-code-" + "a".repeat(28);
const OWNER_ID = "owner-phone";
const OWNER_TOKEN = "owner-device-token";
const BREAK_GLASS = "break-glass-" + "b".repeat(48);

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); },
    use() {}
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "route exists: " + key);
  const res = responseRecorder();
  const request = { method: key.split(" ")[0], headers: {}, query: {}, body: {}, params: {}, ...req };
  for (const handler of handlers) {
    if (handler.length >= 3) {
      let advanced = false;
      await handler(request, res, () => { advanced = true; });
      if (advanced) continue;
      return res;
    }
    await handler(request, res);
    return res;
  }
  return res;
}

function fakeStore(seed = []) {
  const pairings = new Map();
  const devices = new Map();
  const owners = new Map();
  const revoked = new Set();
  for (const entry of seed) {
    pairings.set(digest(entry.code), {
      deviceId: entry.deviceId || "*",
      expiresAt: entry.expiresAt,
      consumedAt: entry.consumedAt || null,
      recoveryAt: entry.recoveryAt || null,
      ownerDeviceId: entry.ownerDeviceId || OWNER_ID
    });
  }
  const invalidatePairings = deviceId => {
    for (const [codeHash, row] of pairings) {
      if (row.deviceId === deviceId) pairings.delete(codeHash);
    }
  };
  return {
    pairings,
    devices,
    owners,
    revoked,
    audits: [],
    invalidatePairings,
    async initialize() { return { ok: true, durable: true }; },
    async createPairing({ codeHash, deviceId, expiresAt, ownerDeviceId = OWNER_ID }) {
      pairings.set(codeHash, { deviceId, expiresAt, consumedAt: null, recoveryAt: null, ownerDeviceId });
      return true;
    },
    async findPairing({ codeHash }) {
      const row = pairings.get(codeHash);
      return row ? { codeHash, deviceId: row.deviceId, expiresAt: row.expiresAt, consumedAt: row.consumedAt, recoveryAt: row.recoveryAt || null, ownerDeviceId: row.ownerDeviceId || null } : null;
    },
    async claimPairingRecovery({ codeHash, deviceId, recoveredAt, consumedAfter }) {
      const row = pairings.get(codeHash);
      if (!row || row.deviceId !== deviceId || !row.consumedAt || row.recoveryAt) return false;
      if (row.consumedAt < consumedAfter) return false;
      row.recoveryAt = recoveredAt;
      return true;
    },
    async consumePairing({ codeHash, deviceId, consumedAt }) {
      const row = pairings.get(codeHash);
      if (!row) return false;
      if (row.consumedAt) return false;
      if (!(row.deviceId === deviceId || row.deviceId === "*")) return false;
      if (Date.parse(row.expiresAt) <= Date.parse(consumedAt)) return false;
      row.deviceId = deviceId;
      row.consumedAt = consumedAt;
      return true;
    },
    async registerDevice({ deviceId, tokenHash, ownerDeviceId = null }) {
      if (ownerDeviceId) {
        if (!owners.has(deviceId)) owners.set(deviceId, ownerDeviceId);
        if (owners.get(deviceId) !== ownerDeviceId) return false;
      }
      // Registration never clears revocation, matching the D1 repository.
      devices.set(deviceId, tokenHash);
      return true;
    },
    async getDeviceOwner(deviceId) { return owners.get(deviceId) || null; },
    async revokeDeviceOwned(deviceId, ownerDeviceId) {
      if (!ownerDeviceId || owners.get(deviceId) !== ownerDeviceId) return false;
      return this.revokeDevice(deviceId);
    },
    async isDeviceRevoked(deviceId) {
      return revoked.has(deviceId);
    },
    async isDevicePaired(deviceId) {
      return devices.has(deviceId) && !revoked.has(deviceId);
    },
    async revokeDevice(deviceId) {
      revoked.add(deviceId);
      invalidatePairings(deviceId);
      for (const [codeHash, row] of pairings) if (row.ownerDeviceId === deviceId) pairings.delete(codeHash);
      return true;
    },
    async unrevokeDevice(deviceId, ownerDeviceId = null) {
      if (!ownerDeviceId || owners.get(deviceId) !== ownerDeviceId) return false;
      return this.recoverRevokedDevice(deviceId);
    },
    async unrevokeDeviceByBreakGlass(deviceId) {
      if (!owners.has(deviceId)) return false;
      return this.recoverRevokedDevice(deviceId);
    },
    async recoverRevokedDevice(deviceId) {
      if (!revoked.has(deviceId)) return false;
      revoked.delete(deviceId);
      devices.delete(deviceId);
      invalidatePairings(deviceId);
      for (const [codeHash, row] of pairings) if (row.ownerDeviceId === deviceId) pairings.delete(codeHash);
      return true;
    },
    async audit(entry) {
      this.audits.push(entry);
      return { ok: true };
    },
    async verifyDeviceToken(token, deviceId) {
      return !revoked.has(deviceId) && Boolean(devices.get(deviceId)) && devices.get(deviceId) === digest(token);
    },
    async touchDevice() { return true; },
    async updateDeviceInfo(deviceId, seenAt, details) {
      this.lastHeartbeat = { deviceId, seenAt, details };
      return true;
    }
  };
}

async function setup(seed = [], { owners = [OWNER_ID] } = {}) {
  const store = fakeStore(seed);
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: OPERATOR,
      HABITAT_OWNER_DEVICE_ID: owners[0] || "",
      HABITAT_OWNER_DEVICE_IDS: owners.join(","),
      HABITAT_BREAK_GLASS_TOKEN: BREAK_GLASS,
      NEXUS_RUNTIME_ENABLED: "false"
    },
    fetchImpl: async () => { throw new Error("network disabled in this test"); },
    repository: store
  });
  await bridge.initialize();
  // The owner is an active paired device in normal operation. Seed it for tests that exercise
  // owner-issued enrollment without turning every test into a two-step bootstrap setup.
  if (owners.includes(OWNER_ID)) store.devices.set(OWNER_ID, digest(OWNER_TOKEN));
  return { app, store };
}

const future = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60 * 1000).toISOString();
const tokenHeaders = token => ({ headers: { authorization: "Bearer " + token } });

test("a valid code exchanges once and the issued token passes heartbeat", async () => {
  const { app } = await setup([{ code: CODE, expiresAt: future() }]);
  const pair = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(pair.statusCode, 200);
  assert.equal(pair.body.recovered, false);
  const token = pair.body.token;
  assert.ok(token.length > 20);

  const heartbeat = await invoke(app, "POST /device/heartbeat", {
    ...tokenHeaders(token),
    body: { deviceId: "launcher-a", details: { model: "S26 Ultra", androidSdk: 34, batteryPercent: 90 } }
  });
  assert.equal(heartbeat.statusCode, 200);
  assert.equal(heartbeat.body.ok, true);

  const unverified = await invoke(app, "POST /device/heartbeat", {
    body: { deviceId: "launcher-a", details: { model: "S26 Ultra", androidSdk: 34 } }
  });
  assert.equal(unverified.statusCode, 401);
});

test("a lost first response is recovered instead of forcing a new code", async () => {
  const { app, store } = await setup([{ code: CODE, expiresAt: future() }]);
  const first = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(first.statusCode, 200);
  const firstToken = first.body.token;

  const retry = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.recovered, true);
  const secondToken = retry.body.token;
  assert.notEqual(secondToken, firstToken);

  // The token from the lost response no longer authenticates; the recovered one does.
  assert.equal(store.devices.get("launcher-a"), digest(secondToken));
  const heartbeat = await invoke(app, "POST /device/heartbeat", {
    ...tokenHeaders(secondToken),
    body: { deviceId: "launcher-a", details: { model: "S26 Ultra", androidSdk: 34 } }
  });
  assert.equal(heartbeat.statusCode, 200);
});

test("an expired code says it expired", async () => {
  const { app } = await setup([{ code: CODE, expiresAt: past() }]);
  const pair = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(pair.statusCode, 401);
  assert.equal(pair.body.code, "pairing_expired");
  assert.match(pair.body.error, /expired/i);
});

test("an unknown code is not confused with an expired one", async () => {
  const { app } = await setup();
  const pair = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: "x".repeat(32) } });
  assert.equal(pair.statusCode, 401);
  assert.equal(pair.body.code, "pairing_unknown");
});

test("a code consumed by another device is refused with 409", async () => {
  const { app } = await setup([{ code: CODE, expiresAt: future(), consumedAt: new Date().toISOString(), deviceId: "launcher-b" }]);
  const pair = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(pair.statusCode, 409);
  assert.equal(pair.body.code, "pairing_used_other_device");
});

test("a wildcard code binds to the first device and then excludes a second", async () => {
  const { app } = await setup([{ code: CODE, expiresAt: future(), deviceId: "*" }]);
  const first = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(first.statusCode, 200);
  const second = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-b", code: CODE } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, "pairing_used_other_device");
});

test("a short code and an invalid device id are rejected before touching storage", async () => {
  const { app, store } = await setup();
  const short = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: "too-short" } });
  assert.equal(short.statusCode, 400);
  const badId = await invoke(app, "POST /device/pair", { body: { deviceId: "bad id!", code: CODE } });
  assert.equal(badId.statusCode, 400);
  assert.equal(store.devices.has("launcher-a"), false);
});

test("two simultaneous submissions by the same device both succeed without corrupting the token", async () => {
  const { app, store } = await setup([{ code: CODE, expiresAt: future() }]);
  const [one, two] = await Promise.all([
    invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } }),
    invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } })
  ]);
  assert.equal(one.statusCode, 200);
  assert.equal(two.statusCode, 200);
  // The owner seed is present; the launcher gets exactly one valid token after one use and one
  // bounded lost-response recovery.
  assert.equal(store.devices.size, 2);
  const stored = store.devices.get("launcher-a");
  assert.ok([one.body.token, two.body.token].map(digest).includes(stored));
});

test("the Control Center can mint a fresh code, and only with its credential", async () => {
  const { app } = await setup();
  const anonymous = await invoke(app, "POST /bridge/console/pairing", { body: {} });
  assert.equal(anonymous.statusCode, 401);
  const wrong = await invoke(app, "POST /bridge/console/pairing", {
    headers: { authorization: "Bearer wrong" },
    body: {}
  });
  assert.equal(wrong.statusCode, 401);

  const minted = await invoke(app, "POST /bridge/console/pairing", {
    headers: { authorization: "Bearer " + OPERATOR },
    body: { deviceId: "launcher-a" }
  });
  assert.equal(minted.statusCode, 201);
  const code = minted.body.pairing.code;
  assert.ok(code.length >= 20);
  assert.equal(minted.body.pairing.deviceId, "launcher-a");

  const exchanged = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code } });
  assert.equal(exchanged.statusCode, 200);
});

test("H7 break-glass recovery is separately authenticated, audited, and requires fresh pairing", async () => {
  const { app, store } = await setup([{ code: CODE, expiresAt: future() }]);
  const first = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(first.statusCode, 200);
  await store.revokeDevice("launcher-a");

  const missing = await invoke(app, "POST /device/break-glass/devices/:deviceId/unrevoke", { params: { deviceId: "launcher-a" } });
  assert.equal(missing.statusCode, 401);
  assert.equal(store.revoked.has("launcher-a"), true);

  const wrong = await invoke(app, "POST /device/break-glass/devices/:deviceId/unrevoke", {
    headers: { "x-break-glass-token": "wrong" }, params: { deviceId: "launcher-a" }
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(store.revoked.has("launcher-a"), true);

  const restored = await invoke(app, "POST /device/break-glass/devices/:deviceId/unrevoke", {
    headers: { "x-break-glass-token": BREAK_GLASS },
    params: { deviceId: "launcher-a" },
    body: { reason: "owner phone lost" }
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.body.requiresPairing, true);
  assert.equal(restored.body.audit, true);
  assert.equal(store.revoked.has("launcher-a"), false);
  assert.equal(await store.verifyDeviceToken(first.body.token, "launcher-a"), false);
  assert.ok(store.audits.some(entry => entry.event === "device.break_glass.unrevoked" && entry.targetDeviceId === "launcher-a"));
  assert.ok(store.audits.some(entry => entry.event === "device.break_glass.denied"));

  const again = await invoke(app, "POST /device/break-glass/devices/:deviceId/unrevoke", {
    headers: { "x-break-glass-token": BREAK_GLASS }, params: { deviceId: "launcher-a" }
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.code, "device_not_revoked_or_unowned");
});

test("H5 codes issued by a revoked or inactive owner cannot enroll a device", async () => {
  const revoked = await setup([{ code: CODE, expiresAt: future(), ownerDeviceId: OWNER_ID }]);
  await revoked.store.revokeDevice(OWNER_ID);
  const oldCode = await invoke(revoked.app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(oldCode.statusCode, 401);
  assert.equal(oldCode.body.code, "pairing_unknown", "revocation removes every code issued by the owner");

  const mintForRevoked = await invoke(revoked.app, "POST /ax/device/pairings", {
    headers: { authorization: "Bearer " + OPERATOR },
    body: { deviceId: "launcher-b" }
  });
  assert.equal(mintForRevoked.statusCode, 409);
  assert.equal(mintForRevoked.body.code, "owner_inactive");

  const OWNER_B = "owner-phone-b";
  const inactiveSetup = await setup([], { owners: [OWNER_ID, OWNER_B] });
  const inactiveCode = "inactive-owner-" + "d".repeat(24);
  await inactiveSetup.store.createPairing({ codeHash: digest(inactiveCode), deviceId: "launcher-c", expiresAt: future(), ownerDeviceId: OWNER_B });
  const inactive = await invoke(inactiveSetup.app, "POST /device/pair", { body: { deviceId: "launcher-c", code: inactiveCode } });
  assert.equal(inactive.statusCode, 409);
  assert.equal(inactive.body.code, "owner_inactive");
});

test("H3 consumed-code recovery expires and is limited to one retry", async () => {
  const old = await setup([{ code: CODE, expiresAt: future(), deviceId: "launcher-a", consumedAt: new Date(Date.now() - 120000).toISOString() }]);
  const expired = await invoke(old.app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.body.code, "pairing_recovery_expired");

  const fresh = await setup([{ code: CODE, expiresAt: future() }]);
  assert.equal((await invoke(fresh.app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } })).statusCode, 200);
  assert.equal((await invoke(fresh.app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } })).body.recovered, true);
  const exhausted = await invoke(fresh.app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(exhausted.statusCode, 409);
  assert.equal(exhausted.body.code, "pairing_recovery_exhausted");
});

test("a revoked device cannot recover with a consumed code or a fresh code", async () => {
  const { app, store } = await setup([{ code: CODE, expiresAt: future() }]);
  const first = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(first.statusCode, 200);
  await store.revokeDevice("launcher-a");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const replay = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
    assert.equal(replay.statusCode, 403, "consumed-code recovery attempt " + attempt);
    assert.equal(replay.body.code, "device_revoked");
    assert.equal(store.revoked.has("launcher-a"), true, "revocation survives attempt " + attempt);
  }

  const fresh = await store.createPairing({
    codeHash: digest("fresh-code-" + "b".repeat(28)),
    deviceId: "launcher-a",
    expiresAt: future()
  });
  assert.equal(fresh, true);
  const freshPair = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: "fresh-code-" + "b".repeat(28) } });
  assert.equal(freshPair.statusCode, 403);
  assert.equal(freshPair.body.code, "device_revoked");
  assert.equal(store.revoked.has("launcher-a"), true);

  const heartbeat = await invoke(app, "POST /device/heartbeat", {
    ...tokenHeaders(first.body.token),
    body: { deviceId: "launcher-a", details: { model: "S26 Ultra", androidSdk: 34 } }
  });
  assert.equal(heartbeat.statusCode, 401, "the revoked device token must stop authenticating");
});

test("only a configured owner device can explicitly restore a revoked device", async () => {
  const { app, store } = await setup([{ code: CODE, expiresAt: future() }]);
  const first = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(first.statusCode, 200);
  await store.revokeDevice("launcher-a");

  const anonymous = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", { params: { deviceId: "launcher-a" } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(store.revoked.has("launcher-a"), true);

  store.devices.set(OWNER_ID, digest(OWNER_TOKEN));
  const nonOwner = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": "not-owner", authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(nonOwner.statusCode, 401);
  assert.equal(store.revoked.has("launcher-a"), true);

  const invalidToken = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer wrong-owner-token" },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(invalidToken.statusCode, 401);
  assert.equal(store.revoked.has("launcher-a"), true);

  const bridgeOnly = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { authorization: "Bearer " + OPERATOR },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(bridgeOnly.statusCode, 401);
  assert.equal(store.revoked.has("launcher-a"), true);

  const restored = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(store.revoked.has("launcher-a"), false);

  // Recovery never reactivates the old credential or an old pairing code.
  assert.equal(await store.verifyDeviceToken(first.body.token, "launcher-a"), false);
  const oldCode = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(oldCode.statusCode, 401);
  assert.equal(oldCode.body.code, "pairing_unknown");

  const freshCode = "fresh-code-" + "c".repeat(28);
  await store.createPairing({ codeHash: digest(freshCode), deviceId: "launcher-a", expiresAt: future() });
  const freshPair = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: freshCode } });
  assert.equal(freshPair.statusCode, 200);
  assert.notEqual(freshPair.body.token, first.body.token);
  assert.equal(await store.verifyDeviceToken(freshPair.body.token, "launcher-a"), true);
});

test("an owner cannot revoke its own only credential into a lockout", async () => {
  const { app, store } = await setup();
  const selfRevoke = await invoke(app, "POST /device/owner/devices/:deviceId/revoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: OWNER_ID }
  });
  assert.equal(selfRevoke.statusCode, 409);
  assert.equal(selfRevoke.body.code, "cannot_revoke_self");
  assert.equal(store.revoked.has(OWNER_ID), false);
  assert.equal(await store.verifyDeviceToken(OWNER_TOKEN, OWNER_ID), true);
});

test("recovery refuses a device that is not revoked", async () => {
  const { app, store } = await setup();
  store.devices.set(OWNER_ID, digest(OWNER_TOKEN));
  store.devices.set("launcher-a", digest("healthy-token"));
  store.owners.set("launcher-a", OWNER_ID);
  const res = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "device_not_revoked");
  assert.equal(await store.verifyDeviceToken("healthy-token", "launcher-a"), true);
});

test("one configured owner cannot restore or revoke another owner's device", async () => {
  const OWNER_B = "owner-phone-b";
  const OWNER_B_TOKEN = "owner-device-token-b";
  const { app, store } = await setup([], { owners: [OWNER_ID, OWNER_B] });
  store.devices.set(OWNER_ID, digest(OWNER_TOKEN));
  store.devices.set(OWNER_B, digest(OWNER_B_TOKEN));
  store.owners.set(OWNER_B, OWNER_B);
  await store.revokeDevice(OWNER_B);

  const byOtherOwner = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: OWNER_B }
  });
  assert.equal(byOtherOwner.statusCode, 403);
  assert.equal(store.revoked.has(OWNER_B), true, "another owner must not restore the device");

  const revokeByOtherOwner = await invoke(app, "POST /device/owner/devices/:deviceId/revoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: OWNER_B }
  });
  assert.equal(revokeByOtherOwner.statusCode, 403);
  assert.equal(store.revoked.has(OWNER_B), true);

  const pairForOtherOwner = await invoke(app, "POST /device/owner/pairings", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    body: { deviceId: OWNER_B }
  });
  assert.equal(pairForOtherOwner.statusCode, 403);
  assert.equal(pairForOtherOwner.body.code, "owner_mismatch");

  const byRevokedOwner = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_B, authorization: "Bearer " + OWNER_B_TOKEN },
    params: { deviceId: OWNER_B }
  });
  assert.equal(byRevokedOwner.statusCode, 401);
  assert.equal(store.revoked.has(OWNER_B), true);

  const byNonOwner = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": "intruder", authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: OWNER_B }
  });
  assert.equal(byNonOwner.statusCode, 401);
  assert.equal(store.revoked.has(OWNER_B), true);
});

test("recovery fails closed when no owner device is configured", async () => {
  const { app, store } = await setup([], { owners: [] });
  await store.revokeDevice("launcher-a");
  const res = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(res.statusCode, 503);
  assert.equal(store.revoked.has("launcher-a"), true);
});

test("pairing ownership is taken from the server record, not caller-supplied fields", async () => {
  const OWNER_B = "owner-phone-b";
  const OWNER_B_TOKEN = "owner-device-token-b";
  const { app, store } = await setup([{ code: CODE, expiresAt: future(), ownerDeviceId: OWNER_ID }], { owners: [OWNER_ID, OWNER_B] });
  store.devices.set(OWNER_ID, digest(OWNER_TOKEN));
  store.devices.set(OWNER_B, digest(OWNER_B_TOKEN));

  const paired = await invoke(app, "POST /device/pair", {
    body: { deviceId: "launcher-a", code: CODE, ownerDeviceId: OWNER_B }
  });
  assert.equal(paired.statusCode, 200);
  assert.equal(store.owners.get("launcher-a"), OWNER_ID, "the body must not choose the owner");

  await store.revokeDevice("launcher-a");
  const byOtherOwner = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_B, authorization: "Bearer " + OWNER_B_TOKEN },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(byOtherOwner.statusCode, 403);
  assert.equal(store.revoked.has("launcher-a"), true);

  const byRecordedOwner = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: "launcher-a" }
  });
  assert.equal(byRecordedOwner.statusCode, 200);
});

test("recovery fails closed when the target has no ownership record", async () => {
  const { app, store } = await setup();
  store.devices.set(OWNER_ID, digest(OWNER_TOKEN));
  store.devices.set("orphan-device", digest("orphan-token"));
  store.revoked.add("orphan-device");

  const res = await invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    params: { deviceId: "orphan-device" }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "ownership_missing");
  assert.equal(store.revoked.has("orphan-device"), true);

  const minted = await invoke(app, "POST /device/owner/pairings", {
    headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
    body: { deviceId: "orphan-device" }
  });
  assert.equal(minted.statusCode, 409);
  assert.equal(minted.body.code, "ownership_missing");
});

test("ambiguous multi-owner provisioning fails closed instead of choosing an owner", async () => {
  const { app, store } = await setup([], { owners: [OWNER_ID, "owner-phone-b"] });
  const minted = await invoke(app, "POST /ax/device/pairings", {
    headers: { authorization: "Bearer " + OPERATOR }, body: { deviceId: "launcher-a" }
  });
  assert.equal(minted.statusCode, 409);
  assert.equal(minted.body.code, "ownership_ambiguous");
  assert.equal(store.pairings.size, 0);
});

test("concurrent recovery and owner revocation never leave the old token usable", async () => {
  const { app, store } = await setup([{ code: CODE, expiresAt: future() }]);
  const paired = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  assert.equal(paired.statusCode, 200);
  store.devices.set(OWNER_ID, digest(OWNER_TOKEN));
  await store.revokeDevice("launcher-a");

  const [restored, revoked] = await Promise.all([
    invoke(app, "POST /device/owner/devices/:deviceId/unrevoke", {
      headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
      params: { deviceId: "launcher-a" }
    }),
    invoke(app, "POST /device/owner/devices/:deviceId/revoke", {
      headers: { "x-owner-device-id": OWNER_ID, authorization: "Bearer " + OWNER_TOKEN },
      params: { deviceId: "launcher-a" }
    })
  ]);
  assert.ok([200, 409].includes(restored.statusCode), "recovery result: " + restored.statusCode);
  assert.ok([200, 409].includes(revoked.statusCode), "revocation result: " + revoked.statusCode);
  assert.equal(await store.verifyDeviceToken(paired.body.token, "launcher-a"), false);
});

test("the pairing response never contains the operator credential", async () => {
  const { app } = await setup([{ code: CODE, expiresAt: future() }]);
  const pair = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } });
  const minted = await invoke(app, "POST /bridge/console/pairing", {
    headers: { authorization: "Bearer " + OPERATOR },
    body: {}
  });
  assert.equal(JSON.stringify(pair.body).includes(OPERATOR), false);
  assert.equal(JSON.stringify(minted.body).includes(OPERATOR), false);
  assert.equal(JSON.stringify(pair.body).includes(CODE), false);
});
