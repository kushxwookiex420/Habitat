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
  const rows = [];
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
    rows,
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
    async registerDevice({ deviceId, tokenHash, createdAt }) {
      devices.set(deviceId, tokenHash);
      const row = rows.find(entry => entry.device_id === deviceId);
      if (row) row.revoked_at = null;
      else rows.push({ device_id: deviceId, created_at: createdAt, last_seen_at: null, revoked_at: null, device_json: null });
      return true;
    },
    async verifyDeviceToken(token, deviceId) {
      return devices.get(deviceId) === digest(token);
    },
    async touchDevice(deviceId, seenAt) {
      const row = rows.find(entry => entry.device_id === deviceId);
      if (row) row.last_seen_at = seenAt;
      return true;
    },
    async updateDeviceInfo(deviceId, seenAt, details) {
      this.lastHeartbeat = { deviceId, seenAt, details };
      const row = rows.find(entry => entry.device_id === deviceId);
      if (row) {
        row.last_seen_at = seenAt;
        row.device_json = JSON.stringify(details);
      }
      return true;
    },
    async listDevices() { return rows.slice(); }
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

test("the Control Center page exposes the pairing-code generator", async () => {
  const { renderConsole } = await import("../home-bridge-console.mjs");
  const html = renderConsole();
  // Without these controls the owner has no way to mint the code the Bridge asks for.
  assert.match(html, /id="pair-create"/);
  assert.match(html, /id="pair-device"/);
  assert.match(html, /id="pair-value"/);
  assert.match(html, /\/bridge\/console\/pairing/);
  // A code is only ever written from the API response, never rendered into the page on the server.
  assert.match(html, /text\("pair-value",r\.pairing\.code\)/);
  assert.equal(/id="pair-value"[^>]*>\s*[A-Za-z0-9_-]{20,}/.test(html), false);
});

test("the dashboard reports the registered phone and its confirmed timestamp without leaking secrets", async () => {
  const { app } = await setup([{ code: CODE, expiresAt: future() }]);
  const minted = await invoke(app, "POST /bridge/console/pairing", {
    ...tokenHeaders(OPERATOR),
    body: { deviceId: "launcher-a" }
  });
  assert.equal(minted.statusCode, 201);
  const code = minted.body.pairing.code;

  const before = await invoke(app, "GET /bridge/console/dashboard", tokenHeaders(OPERATOR));
  assert.equal(before.statusCode, 200);
  assert.equal(before.body.devices.link, "UNPAIRED");
  assert.equal(before.body.devices.count, 0);

  const paired = await invoke(app, "POST /device/pair", { body: { deviceId: "launcher-a", code } });
  assert.equal(paired.statusCode, 200);
  const token = paired.body.token;

  const heartbeat = await invoke(app, "POST /device/heartbeat", {
    headers: { authorization: "Bearer " + token },
    body: { deviceId: "launcher-a", details: { model: "Pixel" } }
  });
  assert.equal(heartbeat.statusCode, 200);

  const after = await invoke(app, "GET /bridge/console/dashboard", tokenHeaders(OPERATOR));
  assert.equal(after.statusCode, 200);
  assert.equal(after.body.devices.link, "LIVE");
  assert.equal(after.body.devices.device.deviceId, "launcher-a");
  assert.ok(after.body.devices.device.pairedAt, "paired timestamp is reported");
  assert.equal(after.body.devices.device.lastSeenAt, heartbeat.body.lastSeenAt);

  const serialized = JSON.stringify(after.body);
  assert.equal(serialized.includes(code), false, "pairing code is never echoed to the console");
  assert.equal(serialized.includes(token), false, "device token is never echoed to the console");
  assert.equal(serialized.includes(OPERATOR), false, "operator credential is never echoed");
});

test("a dedicated operator token opens the console while the bridge token no longer does", async () => {
  const BRIDGE = "ax_bridge_" + "b".repeat(40);
  const OPERATOR_ONLY = "operator_" + "c".repeat(40);
  const store = fakeStore();
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: BRIDGE, HABITAT_OPERATOR_TOKEN: OPERATOR_ONLY },
    fetchImpl: async () => { throw new Error("network disabled in this test"); },
    repository: store
  });
  await bridge.initialize();

  // Separating the credentials must not leave the bridge token able to open the console.
  const asBridge = await invoke(app, "POST /bridge/console/pairing", { ...tokenHeaders(BRIDGE), body: {} });
  assert.equal(asBridge.statusCode, 401);
  const bridgeCookie = await invoke(app, "POST /bridge/console/login", { body: { token: BRIDGE } });
  assert.equal(bridgeCookie.statusCode, 401);

  const login = await invoke(app, "POST /bridge/console/login", { body: { token: OPERATOR_ONLY } });
  assert.equal(login.statusCode, 200);
  const setCookie = String(login.headers["set-cookie"] || "");
  assert.match(setCookie, /^habitat_bridge_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const session = { headers: { cookie: setCookie.split(";")[0] } };
  const dashboard = await invoke(app, "GET /bridge/console/dashboard", session);
  assert.equal(dashboard.statusCode, 200);

  const minted = await invoke(app, "POST /bridge/console/pairing", { ...session, body: { deviceId: "launcher-a" } });
  assert.equal(minted.statusCode, 201);
  assert.equal(minted.headers["cache-control"], "no-store", "a short-lived code is never cached");
  const code = minted.body.pairing.code;
  assert.equal(code.length, 22, "16 random bytes encode to 22 base64url characters");
  const ttlSeconds = Math.round((Date.parse(minted.body.pairing.expiresAt) - Date.now()) / 1000);
  assert.ok(ttlSeconds > 590 && ttlSeconds <= 600, "the code expires in 600 seconds, got " + ttlSeconds);
  assert.equal(minted.body.pairing.singleUse, true);

  // The minted code exists only in that one response: not in the dashboard, not in the page.
  const afterMint = await invoke(app, "GET /bridge/console/dashboard", session);
  assert.equal(afterMint.statusCode, 200);
  assert.equal(JSON.stringify(afterMint.body).includes(code), false);
  assert.equal(JSON.stringify(afterMint.body).includes(OPERATOR_ONLY), false);
});
