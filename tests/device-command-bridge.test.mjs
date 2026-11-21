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
  const owners = new Map();
  return {
    durable: true,
    devices,
    owners,
    async initialize() {},
    async createPairing(row) { pairings.set(row.codeHash, { ...row, consumedAt: null, recoveryAt: null }); },
    async seedBootstrapPairing(row) { if (!pairings.has(row.codeHash)) pairings.set(row.codeHash, { ...row, deviceId: "*", consumedAt: null, recoveryAt: null }); },
    async findPairing({ codeHash }) { const row = pairings.get(codeHash); return row ? { ...row, codeHash } : null; },
    async consumePairing({ codeHash, deviceId, consumedAt }) {
      const row = pairings.get(codeHash);
      if (!row || (row.deviceId !== deviceId && row.deviceId !== "*") || row.consumedAt || row.expiresAt <= consumedAt) return false;
      row.deviceId = deviceId;
      row.consumedAt = consumedAt;
      return true;
    },
    async claimPairingRecovery({ codeHash, deviceId, recoveredAt, consumedAfter }) {
      const row = pairings.get(codeHash);
      if (!row || row.deviceId !== deviceId || !row.consumedAt || row.recoveryAt) return false;
      if (row.consumedAt < consumedAfter) return false;
      row.recoveryAt = recoveredAt;
      return true;
    },
    async registerDevice({ deviceId, tokenHash, createdAt, ownerDeviceId }) {
      if (ownerDeviceId) {
        if (!owners.has(deviceId)) owners.set(deviceId, ownerDeviceId);
        if (owners.get(deviceId) !== ownerDeviceId) return false;
      }
      devices.set(deviceId, { tokenHash, createdAt, lastSeenAt: null, revoked: false });
      return true;
    },
    async getDeviceOwner(deviceId) { return owners.get(deviceId) || null; },
    async revokeDeviceOwned(deviceId, ownerDeviceId) {
      if (!ownerDeviceId || owners.get(deviceId) !== ownerDeviceId) return false;
      const row = devices.get(deviceId); if (row) row.revoked = true; return true;
    },
    async verifyDeviceToken(token, deviceId) {
      const row = devices.get(deviceId);
      return Boolean(row && !row.revoked && row.tokenHash === createHash("sha256").update(token).digest("hex"));
    },
    async isDevicePaired(deviceId) { const row=devices.get(deviceId); return Boolean(row && !row.revoked); },
    async touchDevice(deviceId, seenAt) { const row=devices.get(deviceId); if(row && !row.revoked) row.lastSeenAt=seenAt; },
    async updateDeviceInfo(deviceId, seenAt, details) { const row=devices.get(deviceId); if(row && !row.revoked) { row.lastSeenAt=seenAt; row.deviceInfo=details; } },
    async listDevices() { return [...devices.entries()].map(([device_id,row]) => ({device_id,created_at:row.createdAt,last_seen_at:row.lastSeenAt,device_json:row.deviceInfo ? JSON.stringify(row.deviceInfo) : null,revoked_at:row.revoked ? "revoked" : null,owner_device_id: owners.get(device_id) || null})); },
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
    async get(id) { return commands.get(id) || null; },
    async audit() { return { ok: true }; }
  };
}

function seedOwner(repository, id = "owner-phone", token = "owner-token") {
  repository.devices.set(id, { tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: new Date().toISOString(), lastSeenAt: null, revoked: false });
  repository.owners.set(id, id);
}


test("bootstrap pairing is short-lived, single-use, and never exposes an Ax token", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  seedOwner(repository);
  const code = "habitat-bootstrap-" + "x".repeat(32);
  const codeHash = createHash("sha256").update(code).digest("hex");
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH: codeHash,
      HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      HABITAT_OWNER_DEVICE_ID: "owner-phone"
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
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.body.code, "pairing_used_other_device");
});

test("Bridge APK field aliases receive the same one-time credential response", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  seedOwner(repository);
  const bridge = registerDeviceCommandBridge(app, { env: { HABITAT_AX_BRIDGE_TOKEN: "ax-secret", HABITAT_OWNER_DEVICE_ID: "owner-phone" }, repository });
  await bridge.initialize();
  const issued = await invoke(app, "POST /ax/device/pairings", {
    headers: { authorization: "Bearer ax-secret" }, body: { deviceId: "android-s26" }
  });
  assert.equal(issued.statusCode, 201);
  const code = issued.body.pairing.code;
  const paired = await invoke(app, "POST /device/pair", {
    headers: { "content-type": "application/json" },
    body: { phoneId: "android-s26", pairingCode: code }
  });
  assert.equal(paired.statusCode, 200);
  assert.equal(paired.body.ok, true);
  assert.equal(paired.body.deviceId, "android-s26");
  assert.equal(paired.body.device.deviceId, "android-s26");
  assert.equal(paired.body.token, paired.body.device.token);
  assert.equal(paired.body.deviceToken, paired.body.device.token);
});

test("H1 device status is authenticated and scoped to the requesting owner", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  seedOwner(repository, "owner-phone", "owner-token");
  const seen = new Date().toISOString();
  repository.devices.set("owner-phone", { tokenHash: createHash("sha256").update("owner-token").digest("hex"), createdAt: seen, lastSeenAt: new Date(0).toISOString(), revoked: false });
  repository.owners.set("owner-phone", "owner-phone");
  repository.devices.set("owner-a-phone", { tokenHash: "a", createdAt: seen, lastSeenAt: seen, revoked: false });
  repository.owners.set("owner-a-phone", "owner-phone");
  repository.devices.set("owner-b-phone", { tokenHash: "b", createdAt: seen, lastSeenAt: new Date(Date.now() + 1000).toISOString(), revoked: false });
  repository.owners.set("owner-b-phone", "other-owner");
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_OWNER_DEVICE_ID: "owner-phone", NEXUS_RUNTIME_ENABLED: "false" },
    repository
  });
  await bridge.initialize();

  const anonymous = await bridge.authorizeOwnerRequest({ headers: {} });
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.status, 401);

  const owner = await bridge.authorizeOwnerRequest({ headers: { authorization: "Bearer owner-token", "x-owner-device-id": "owner-phone" } });
  assert.equal(owner.ok, true);
  assert.equal(owner.deviceId, "owner-phone");

  const status = await bridge.requestDeviceStatus({ ownerDeviceId: "owner-phone" });
  assert.equal(status.ok, true);
  assert.equal(status.deviceId, "owner-a-phone", "the newest device of another owner must not be selected");
  const foreign = await bridge.requestDeviceStatus({ ownerDeviceId: "owner-phone", targetDeviceId: "owner-b-phone" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, "target_not_owned_or_offline");
});

test("production runtime safeguards disable Nexus even when the flag is true", async () => {
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_OWNER_DEVICE_ID: "owner-phone",
      NEXUS_RUNTIME_ENABLED: "true",
      HABITAT_RUNTIME_ENV: "production"
    },
    repository: memoryRepository()
  });
  const init = await bridge.initialize();
  assert.equal(init.nexus.configured, false);
  assert.equal(init.nexus.reason, "disabled_environment");
  assert.equal(bridge.nexus(), null);
});

test("pairing codes are one-time and issue individual phone credentials", async () => {
  const app = makeApp();
  const repository = memoryRepository();
  seedOwner(repository);
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "ax-secret", HABITAT_OWNER_DEVICE_ID: "owner-phone" },
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
  let token = paired.body.device.token;
  assert.ok(token.length >= 40);

  const replay = await invoke(app, "POST /device/pair", {
    headers: {}, body: { deviceId: "s26", code }
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.recovered, true);
  token = replay.body.device.token;

  // Only one lost-response recovery is allowed. A third exchange is not a new token or a
  // permanent replayable credential.
  const exhausted = await invoke(app, "POST /device/pair", {
    headers: {}, body: { deviceId: "s26", code }
  });
  assert.equal(exhausted.statusCode, 409);
  assert.equal(exhausted.body.code, "pairing_recovery_exhausted");

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

  const heartbeat = await invoke(app, "POST /device/heartbeat", {
    headers: { authorization: "Bearer " + token },
    body: { deviceId: "s26", details: { manufacturer: "Samsung", model: "Galaxy S26 Ultra", batteryPercent: 83, charging: true, ignoredField: "must-not-be-stored" } }
  });
  assert.equal(heartbeat.body.ok, true);

  const inventory = await invoke(app, "GET /ax/device/devices", {
    headers: { authorization: "Bearer ax-secret" }
  });
  const s26 = inventory.body.devices.find(device => device.deviceId === "s26");
  assert.equal(s26.deviceId, "s26");
  assert.ok(s26.lastSeenAt);
  assert.deepEqual(s26.deviceInfo, {
    manufacturer: "Samsung", model: "Galaxy S26 Ultra", batteryPercent: 83, charging: true
  });
  assert.equal(JSON.stringify(inventory.body).includes(token), false);

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
