import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
function makeApp() {
  const routes = new Map();
  return {
    routes,
    post(path, ...handlers) { routes.set("POST " + path, handlers); },
    get(path, ...handlers) { routes.set("GET " + path, handlers); }
  };
}
async function invoke(app, key, req) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "route exists: " + key);
  const res = responseRecorder();
  let index = 0;
  const next = () => { index += 1; };
  while (index < handlers.length) {
    let called = false;
    await handlers[index](req, res, () => { called = true; next(); });
    if (!called) break;
  }
  return res;
}
function memoryRepository() {
  const commands = new Map();
  const pairings = new Map();
  const devices = new Map();
  return {
    durable: true,
    async initialize() {},
    async createPairing(row) { pairings.set(row.codeHash, { ...row, consumedAt: null }); },
    async seedBootstrapPairing(row) { if (!pairings.has(row.codeHash)) pairings.set(row.codeHash, { ...row, deviceId: "*", consumedAt: null }); },
    async consumePairing({ codeHash, deviceId, consumedAt }) {
      const row = pairings.get(codeHash);
      if (!row || (row.deviceId !== deviceId && row.deviceId !== "*") || row.consumedAt || row.expiresAt <= consumedAt) return false;
      row.deviceId = deviceId;
      row.consumedAt = consumedAt;
      return true;
    },
    async registerDevice({ deviceId, tokenHash, createdAt }) { devices.set(deviceId, { tokenHash, createdAt, lastSeenAt: null, revoked: false }); },
    async verifyDeviceToken(token, deviceId) {
      const row = devices.get(deviceId);
      return Boolean(row && !row.revoked && row.tokenHash === createHash("sha256").update(token).digest("hex"));
    },
    async isDevicePaired(deviceId) { const row=devices.get(deviceId); return Boolean(row && !row.revoked); },
    async touchDevice(deviceId, seenAt) { const row=devices.get(deviceId); if(row && !row.revoked) row.lastSeenAt=seenAt; },
    async listDevices() { return [...devices.entries()].map(([device_id,row]) => ({device_id,created_at:row.createdAt,last_seen_at:row.lastSeenAt,revoked_at:row.revoked ? "revoked" : null})); },
    async revokeDevice(deviceId) { const row=devices.get(deviceId); if(row) row.revoked=true; },
    async enqueue(row) { commands.set(row.id, structuredClone(row)); },
    async claimNext(deviceId) {
      const row = [...commands.values()].find(x => x.deviceId === deviceId && x.status === "queued");
      if (!row) return null;
      row.status = "claimed";
      return structuredClone(row);
    },
    async complete({ id, deviceId, result, completedAt }) {
      const row = commands.get(id);
      if (!row || row.deviceId !== deviceId || row.status !== "claimed") return false;
      Object.assign(row, { status: "completed", result, completedAt });
      return true;
    },
    async get(id) { return commands.get(id) || null; }
  };
}


test("bootstrap pairing is short-lived, single-use, and never exposes an Ax token", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  const code = "habitat-bootstrap-" + "x".repeat(32);
  const codeHash = createHash("sha256").update(code).digest("hex");
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH: codeHash,
      HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    },
    repository
  });
  await bridge.initialize();

  const paired = await invoke(app, "POST /device/pair", {
    headers: {}, body: { deviceId: "s26-ultra", code }
  });
  assert.equal(paired.statusCode, 200);
  assert.equal(paired.body.device.deviceId, "s26-ultra");
  assert.ok(paired.body.device.token);

  const replay = await invoke(app, "POST /device/pair", {
    headers: {}, body: { deviceId: "another-device", code }
  });
  assert.equal(replay.statusCode, 401);
});

test("pairing codes are one-time and issue individual phone credentials", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "ax-secret" },
    repository
  });
  await bridge.initialize();

  const unauthorized = await invoke(app, "POST /ax/device/pairings", {
    headers: {}, body: { deviceId: "s26" }
  });
  assert.equal(unauthorized.statusCode, 401);

  const pairing = await invoke(app, "POST /ax/device/pairings", {
    headers: { authorization: "Bearer ax-secret" }, body: { deviceId: "s26" }
  });
  assert.equal(pairing.statusCode, 201);
  assert.equal(pairing.body.pairing.singleUse, true);
  const code = pairing.body.pairing.code;

  const paired = await invoke(app, "POST /device/pair", {
    headers: {}, body: { deviceId: "s26", code }
  });
  assert.equal(paired.statusCode, 200);
  const token = paired.body.device.token;
  assert.ok(token.length >= 40);

  const replay = await invoke(app, "POST /device/pair", {
    headers: {}, body: { deviceId: "s26", code }
  });
  assert.equal(replay.statusCode, 401);

  const noSharedToken = await invoke(app, "GET /device/commands/next", {
    headers: { authorization: "Bearer phone-secret" }, query: { deviceId: "s26" }
  });
  assert.equal(noSharedToken.statusCode, 401);

  const unpairedQueue = await invoke(app, "POST /ax/device/commands", {
    headers: { authorization: "Bearer ax-secret" }, body: { deviceId: "other-phone", type: "device.status" }
  });
  assert.equal(unpairedQueue.statusCode, 404);

  const forbidden = await invoke(app, "POST /ax/device/commands", {
    headers: { authorization: "Bearer ax-secret" }, body: { deviceId: "s26", type: "shell.exec" }
  });
  assert.equal(forbidden.statusCode, 400);

  const queued = await invoke(app, "POST /ax/device/commands", {
    headers: { authorization: "Bearer ax-secret" }, body: { deviceId: "s26", type: "device.status" }
  });
  assert.equal(queued.statusCode, 202);
  const id = queued.body.command.id;

  const claimed = await invoke(app, "GET /device/commands/next", {
    headers: { authorization: "Bearer " + token }, query: { deviceId: "s26" }
  });
  assert.equal(claimed.body.command.id, id);

  const inventory = await invoke(app, "GET /ax/device/devices", {
    headers: { authorization: "Bearer ax-secret" }
  });
  assert.equal(inventory.body.devices[0].deviceId, "s26");
  assert.ok(inventory.body.devices[0].lastSeenAt);

  const completed = await invoke(app, "POST /device/commands/:id/result", {
    headers: { authorization: "Bearer " + token }, params: { id },
    body: { deviceId: "s26", result: { ok: true, summary: "Device diagnostics collected." } }
  });
  assert.equal(completed.body.status, "completed");

  const readback = await invoke(app, "GET /ax/device/commands/:id", {
    headers: { authorization: "Bearer ax-secret" }, params: { id }
  });
  assert.equal(readback.body.command.status, "completed");
  assert.equal(readback.body.command.result.ok, true);

  const revoked = await invoke(app, "POST /ax/device/:deviceId/revoke", {
    headers: { authorization: "Bearer ax-secret" }, params: { deviceId: "s26" }
  });
  assert.equal(revoked.body.revoked, true);

  const afterRevoke = await invoke(app, "GET /device/commands/next", {
    headers: { authorization: "Bearer " + token }, query: { deviceId: "s26" }
  });
  assert.equal(afterRevoke.statusCode, 401);
});
