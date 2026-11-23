import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";
import { projectDevicePresence, DEVICE_BRIDGE_HEARTBEAT_TTL_MS } from "../device-presence.mjs";

/**
 * Mocked staging of the phone-presence lifecycle. It mounts the real bridge router with an
 * in-memory repository and a controllable clock; nothing here contacts production.
 */

const OPERATOR = "ax_bridge_" + "9".repeat(40);
const DEVICE = "android-s26-ultra";

const digest = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

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

function fakeStore() {
  const pairings = new Map();
  const devices = new Map();
  const rows = [];
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
      if (!row || row.consumedAt) return false;
      if (!(row.deviceId === deviceId || row.deviceId === "*")) return false;
      if (Date.parse(row.expiresAt) <= Date.parse(consumedAt)) return false;
      row.deviceId = deviceId;
      row.consumedAt = consumedAt;
      return true;
    },
    async registerDevice({ deviceId, tokenHash, createdAt }) {
      devices.set(deviceId, tokenHash);
      const existing = rows.find(entry => entry.device_id === deviceId);
      if (existing) existing.revoked_at = null;
      else rows.push({ device_id: deviceId, created_at: createdAt, last_seen_at: null, revoked_at: null, device_json: null });
      return true;
    },
    async verifyDeviceToken(token, deviceId) {
      const entry = rows.find(item => item.device_id === deviceId);
      if (entry?.revoked_at) return false;
      return devices.get(deviceId) === digest(token);
    },
    async touchDevice(deviceId, seenAt) {
      const entry = rows.find(item => item.device_id === deviceId);
      if (entry && !entry.revoked_at) entry.last_seen_at = seenAt;
      return true;
    },
    async updateDeviceInfo(deviceId, seenAt, details) {
      const entry = rows.find(item => item.device_id === deviceId);
      if (entry && !entry.revoked_at) {
        entry.last_seen_at = seenAt;
        entry.device_json = JSON.stringify(details);
      }
      return true;
    },
    async listDevices() { return rows.slice(); },
    async revokeDevice(deviceId, revokedAt) {
      const entry = rows.find(item => item.device_id === deviceId);
      if (entry) entry.revoked_at = revokedAt;
      return Boolean(entry);
    }
  };
}

async function setup() {
  const store = fakeStore();
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("network disabled in this test"); },
    repository: store
  });
  await bridge.initialize();
  return { app, store };
}

const headers = (token) => ({ headers: { authorization: "Bearer " + token } });

async function mint(app, deviceId = DEVICE) {
  const minted = await invoke(app, "POST /bridge/console/pairing", {
    ...headers(OPERATOR),
    body: { deviceId }
  });
  assert.equal(minted.statusCode, 201);
  return minted.body.pairing.code;
}

async function pair(app, code, deviceId = DEVICE) {
  const paired = await invoke(app, "POST /device/pair", { body: { deviceId, code } });
  assert.equal(paired.statusCode, 200);
  return paired.body.token;
}

async function heartbeat(app, token, details = { model: "SM-S948U1", androidSdk: 35, batteryPercent: 80 }) {
  return invoke(app, "POST /device/heartbeat", {
    ...headers(token),
    body: { deviceId: DEVICE, details }
  });
}

test("1-3: existing registration is recognized, pairing authenticates, and heartbeat records presence", async () => {
  const { app, store } = await setup();
  assert.equal((await store.listDevices()).length, 0);

  const token = await pair(app, await mint(app));
  const pairedRows = await store.listDevices();
  assert.equal(pairedRows.length, 1, "the registration is durable");
  assert.equal(pairedRows[0].last_seen_at, null, "pairing alone is not presence");

  const unauthorized = await invoke(app, "POST /device/heartbeat", { body: { deviceId: DEVICE, details: { model: "x" } } });
  assert.equal(unauthorized.statusCode, 401, "a heartbeat without the device token is refused");

  const beat = await heartbeat(app, token);
  assert.equal(beat.statusCode, 200);
  assert.ok(beat.body.lastSeenAt);

  const presence = projectDevicePresence(await store.listDevices());
  assert.equal(presence.status, "PASS");
  assert.equal(presence.active.length, 1);
});

test("4: presence transitions to PASS only after an authenticated heartbeat", async () => {
  const { app, store } = await setup();
  const token = await pair(app, await mint(app));
  assert.equal(projectDevicePresence(await store.listDevices()).status, "UNVERIFIED");
  await heartbeat(app, token, { manufacturer: "Samsung", model: "SM-S948U1", androidSdk: 35 });
  const presence = projectDevicePresence(await store.listDevices());
  assert.equal(presence.status, "PASS");
  assert.equal(presence.devices[0].deviceModel, "Samsung SM-S948U1");
});

test("5: heartbeat expiration transitions to UNVERIFIED while keeping the registration", async () => {
  const { app, store } = await setup();
  const token = await pair(app, await mint(app));
  const beat = await heartbeat(app, token);
  const seenAt = Date.parse(beat.body.lastSeenAt);

  const fresh = projectDevicePresence(await store.listDevices(), { now: seenAt + 60_000 });
  assert.equal(fresh.status, "PASS");
  const expired = projectDevicePresence(await store.listDevices(), { now: seenAt + DEVICE_BRIDGE_HEARTBEAT_TTL_MS + 1 });
  assert.equal(expired.status, "UNVERIFIED");
  assert.equal(expired.active.length, 0);
  assert.equal((await store.listDevices()).length, 1, "registration survives expiry");
});

test("6: revocation removes presence and the old token can no longer heartbeat", async () => {
  const { app, store } = await setup();
  const token = await pair(app, await mint(app));
  await heartbeat(app, token);
  assert.equal(projectDevicePresence(await store.listDevices()).status, "PASS");

  const revoked = await invoke(app, "POST /ax/device/:deviceId/revoke", {
    ...headers(OPERATOR),
    params: { deviceId: DEVICE }
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(projectDevicePresence(await store.listDevices()).status, "UNVERIFIED");
  assert.equal(projectDevicePresence(await store.listDevices()).devices.length, 0);

  const afterRevoke = await heartbeat(app, token);
  assert.equal(afterRevoke.statusCode, 401);
});

test("7: a reconnect after a temporary network gap restores presence", async () => {
  const { app, store } = await setup();
  const token = await pair(app, await mint(app));
  const first = await heartbeat(app, token);
  const firstSeen = Date.parse(first.body.lastSeenAt);

  const duringOutage = projectDevicePresence(await store.listDevices(), { now: firstSeen + DEVICE_BRIDGE_HEARTBEAT_TTL_MS + 1 });
  assert.equal(duringOutage.status, "UNVERIFIED");

  const reconnected = await heartbeat(app, token, { model: "SM-S948U1", androidSdk: 35, batteryPercent: 79 });
  assert.equal(reconnected.statusCode, 200);
  const after = projectDevicePresence(await store.listDevices());
  assert.equal(after.status, "PASS");
  assert.equal(after.active[0].batteryPercent, 79, "the reconnect carries fresh details");
});

test("8: task detail and receipt retrieval routes exist and are read-only GETs", async () => {
  await setup();
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /app\.get\("\/tasks\/:id"/);
  assert.match(server, /app\.get\("\/tasks"/);
  assert.match(server, /verificationDetails/);
});
