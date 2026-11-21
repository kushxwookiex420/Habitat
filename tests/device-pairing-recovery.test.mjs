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
  for (const entry of seed) {
    pairings.set(digest(entry.code), {
      deviceId: entry.deviceId || "*",
      expiresAt: entry.expiresAt,
      consumedAt: entry.consumedAt || null
    });
  }
  return {
    pairings,
    devices,
    async initialize() { return { ok: true, durable: true }; },
    async createPairing({ codeHash, deviceId, expiresAt }) {
      pairings.set(codeHash, { deviceId, expiresAt, consumedAt: null });
      return true;
    },
    async findPairing({ codeHash }) {
      const row = pairings.get(codeHash);
      return row ? { codeHash, deviceId: row.deviceId, expiresAt: row.expiresAt, consumedAt: row.consumedAt } : null;
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
    async registerDevice({ deviceId, tokenHash }) {
      devices.set(deviceId, tokenHash);
      return true;
    },
    async verifyDeviceToken(token, deviceId) {
      return devices.get(deviceId) === digest(token);
    },
    async touchDevice() { return true; },
    async updateDeviceInfo(deviceId, seenAt, details) {
      this.lastHeartbeat = { deviceId, seenAt, details };
      return true;
    }
  };
}

async function setup(seed = []) {
  const store = fakeStore(seed);
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("network disabled in this test"); },
    repository: store
  });
  await bridge.initialize();
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
  assert.equal(store.devices.size, 0);
});

test("two simultaneous submissions by the same device both succeed without corrupting the token", async () => {
  const { app, store } = await setup([{ code: CODE, expiresAt: future() }]);
  const [one, two] = await Promise.all([
    invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } }),
    invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code: CODE } })
  ]);
  assert.equal(one.statusCode, 200);
  assert.equal(two.statusCode, 200);
  // The last issued token is the valid one; exactly one token is stored for the device.
  assert.equal(store.devices.size, 1);
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
