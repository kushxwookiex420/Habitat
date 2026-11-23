import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";
import { validateDeviceCommand, DEVICE_COMMAND_TYPES } from "../device-commands.mjs";

const AX = "ax-token-value";
const OPERATOR = "operator-token-value";
const DEVICE = "android-s26";
const DEVICE_TOKEN = "device-token-" + "x".repeat(40);

function recorder() {
  return {
    statusCode: 200,
    body: null,
    sent: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.sent = body; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; }
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
async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "route exists: " + key);
  const res = recorder();
  let index = 0;
  while (index < handlers.length) {
    let called = false;
    await handlers[index](req, res, () => { called = true; index += 1; });
    if (!called) break;
  }
  return res;
}
const axHeaders = { authorization: "Bearer " + AX };
const deviceHeaders = { authorization: "Bearer " + DEVICE_TOKEN };

function fakeStore() {
  const devices = new Map([[DEVICE, {
    tokenHash: createHash("sha256").update(DEVICE_TOKEN).digest("hex"),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    revoked: false
  }]]);
  const commands = new Map();
  return {
    durable: true,
    async initialize() {},
    async isDevicePaired(deviceId) { return Boolean(devices.get(deviceId) && !devices.get(deviceId).revoked); },
    async verifyDeviceToken(token, deviceId) {
      const row = devices.get(deviceId);
      return Boolean(row && !row.revoked && row.tokenHash === createHash("sha256").update(String(token)).digest("hex"));
    },
    async touchDevice(deviceId, at) { const row = devices.get(deviceId); if (row) row.lastSeenAt = at; },
    async updateDeviceInfo(deviceId, at) { const row = devices.get(deviceId); if (row) row.lastSeenAt = at; },
    async enqueue(command) { commands.set(command.id, structuredClone(command)); return command; },
    async claimNext(deviceId) {
      for (const command of commands.values()) {
        if (command.deviceId === deviceId && command.status === "queued") {
          command.status = "claimed";
          command.claimedAt = new Date().toISOString();
          return structuredClone(command);
        }
      }
      return null;
    },
    async complete({ id, deviceId, result, completedAt }) {
      const command = commands.get(id);
      if (!command || command.deviceId !== deviceId || command.status !== "claimed") return false;
      command.status = "completed";
      command.result = result;
      command.completedAt = completedAt;
      return true;
    },
    async listDevices() { return [...devices.entries()].map(([device_id, row]) => ({ device_id, revoked_at: null, last_seen_at: row.lastSeenAt })); },
    async listCommands() { return [...commands.values()]; },
    async revokeDevice(deviceId) { const row = devices.get(deviceId); if (row) row.revoked = true; }
  };
}

function fakeScreenshots() {
  const rows = new Map();
  return {
    rows,
    async initialize() {},
    async save(row) { rows.set(row.id, row); return row; },
    async get(id) { return rows.get(id) || null; },
    async prune() { return true; }
  };
}

async function setup({ audit = null } = {}) {
  const store = fakeStore();
  const screenshots = fakeScreenshots();
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX, HABITAT_OPERATOR_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("network disabled in this test"); },
    repository: store,
    screenshotRepository: screenshots,
    securityRepository: audit
  });
  await bridge.initialize();
  return { app, store, screenshots };
}

async function queue(app, body) {
  return invoke(app, "POST /ax/device/commands", { headers: axHeaders, body });
}

// ---- contract ---------------------------------------------------------------

test("the command contract is stricter than the old single-command allowlist", () => {
  assert.deepEqual(DEVICE_COMMAND_TYPES, [
    "device.status", "device.screen", "device.screenshot",
    "device.tap", "device.swipe", "device.type", "device.key"
  ]);
  for (const type of ["device.status", "device.screen", "device.screenshot"]) {
    assert.equal(validateDeviceCommand(type, {}).ok, true);
    assert.equal(validateDeviceCommand(type, { x: 1 }).ok, false, "read-only commands take no payload");
  }
  assert.equal(validateDeviceCommand("device.tap", { x: 500, y: 500 }).ok, true);
  assert.equal(validateDeviceCommand("device.tap", { x: 500.5, y: 500 }).ok, false);
  assert.equal(validateDeviceCommand("device.tap", { x: 500, y: 500, extra: 1 }).ok, false);
  assert.equal(validateDeviceCommand("device.swipe", { x1: 0, y1: 0, x2: 9000, y2: 9000 }).ok, true);
  assert.equal(validateDeviceCommand("device.swipe", { x1: 0, y1: 0, x2: 9000, y2: 9000, durationMs: 9000 }).ok, false);
  assert.equal(validateDeviceCommand("device.type", { text: "hello" }).ok, true);
  assert.equal(validateDeviceCommand("device.type", { text: "" }).ok, false);
  assert.equal(validateDeviceCommand("device.type", { text: "a".repeat(501) }).ok, false);
  assert.equal(validateDeviceCommand("device.type", { text: "ok\u0007" }).ok, false);
  assert.equal(validateDeviceCommand("device.key", { name: "home" }).ok, true);
  assert.equal(validateDeviceCommand("device.key", { name: "power" }).ok, false);
  assert.equal(validateDeviceCommand("device.shell", {}).ok, false);
});

// ---- enqueue ----------------------------------------------------------------

test("read-only commands queue without approval and carry a normalized payload", async () => {
  const { app } = await setup();
  const queued = await queue(app, { deviceId: DEVICE, type: "device.status" });
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.body.command.type, "device.status");
  assert.equal(queued.body.command.sensitive, false);

  const claimed = await invoke(app, "GET /device/commands/next", { headers: deviceHeaders, query: { deviceId: DEVICE } });
  assert.equal(claimed.statusCode, 200);
  assert.deepEqual(claimed.body.command.payload, {});
});

test("tap, swipe, type and key are refused without explicit owner approval", async () => {
  const { app } = await setup();
  for (const [type, payload] of [
    ["device.tap", { x: 100, y: 200 }],
    ["device.swipe", { x1: 0, y1: 0, x2: 5000, y2: 5000 }],
    ["device.type", { text: "hello" }],
    ["device.key", { name: "back" }]
  ]) {
    const refused = await queue(app, { deviceId: DEVICE, type, payload });
    assert.equal(refused.statusCode, 400, type);
    assert.equal(refused.body.code, "owner_approval_required");
  }
  const approved = await queue(app, {
    deviceId: DEVICE, type: "device.tap", payload: { x: 100, y: 200 }, approved: true
  });
  assert.equal(approved.statusCode, 202);
  assert.equal(approved.body.command.sensitive, true);
});

test("an approved tap reaches the phone with its payload and completes a receipt", async () => {
  const audit = [];
  const { app } = await setup({
    audit: { async append(event) { audit.push(event); return event; } }
  });
  const queued = await queue(app, {
    deviceId: DEVICE, type: "device.tap", payload: { x: 1250, y: 8750 }, approved: true
  });
  assert.equal(queued.statusCode, 202);
  const id = queued.body.command.id;

  const claimed = await invoke(app, "GET /device/commands/next", { headers: deviceHeaders, query: { deviceId: DEVICE } });
  assert.deepEqual(claimed.body.command.payload, { x: 1250, y: 8750 });

  const completed = await invoke(app, "POST /device/commands/:id/result", {
    headers: deviceHeaders,
    query: { deviceId: DEVICE },
    params: { id },
    body: { deviceId: DEVICE, result: { ok: true, summary: "tapped", details: {} } }
  });
  assert.equal(completed.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audit.some((event) => event.category === "command.sensitive"), true);
  assert.equal(JSON.stringify(audit).includes("1250"), false, "coordinates are never audited");
});

test("an unpaired or unknown command is refused before anything is stored", async () => {
  const { app, store } = await setup();
  const unknown = await queue(app, { deviceId: DEVICE, type: "device.shell", payload: {} });
  assert.equal(unknown.statusCode, 400);
  const unpaired = await queue(app, { deviceId: "android-missing", type: "device.status" });
  assert.equal(unpaired.statusCode, 404);
  assert.equal((await store.listCommands()).length, 0);
});

// ---- screenshots ------------------------------------------------------------

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]).toString("base64");

test("a screenshot is device-uploaded, bounded, and readable by the operator without caching", async () => {
  const { app } = await setup();
  const uploaded = await invoke(app, "POST /device/screenshots", {
    headers: deviceHeaders,
    query: { deviceId: DEVICE },
    body: { deviceId: DEVICE, mime: "image/jpeg", data: JPEG, capturedAt: new Date().toISOString() }
  });
  assert.equal(uploaded.statusCode, 201);
  const id = uploaded.body.screenshot.id;

  const read = await invoke(app, "GET /bridge/console/screenshots/:id", {
    headers: { authorization: "Bearer " + OPERATOR },
    params: { id }
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["content-type"], "image/jpeg");
  assert.equal(read.headers["cache-control"], "no-store");
  assert.deepEqual(Buffer.from(read.sent), Buffer.from(JPEG, "base64"));

  const axRead = await invoke(app, "GET /ax/device/screenshots/:id", { headers: axHeaders, params: { id } });
  assert.equal(axRead.statusCode, 200);
});

test("screenshot upload refuses missing auth, wrong mime and oversize bodies", async () => {
  const { app } = await setup();
  const noAuth = await invoke(app, "POST /device/screenshots", {
    headers: {},
    query: { deviceId: DEVICE },
    body: { deviceId: DEVICE, mime: "image/jpeg", data: JPEG, capturedAt: new Date().toISOString() }
  });
  assert.equal(noAuth.statusCode, 401);

  const wrongMime = await invoke(app, "POST /device/screenshots", {
    headers: deviceHeaders,
    query: { deviceId: DEVICE },
    body: { deviceId: DEVICE, mime: "image/gif", data: JPEG, capturedAt: new Date().toISOString() }
  });
  assert.equal(wrongMime.statusCode, 415);

  const big = Buffer.alloc(1_500_001).toString("base64");
  const oversize = await invoke(app, "POST /device/screenshots", {
    headers: deviceHeaders,
    query: { deviceId: DEVICE },
    body: { deviceId: DEVICE, mime: "image/jpeg", data: big, capturedAt: new Date().toISOString() }
  });
  assert.equal(oversize.statusCode, 413);

  const badTime = await invoke(app, "POST /device/screenshots", {
    headers: deviceHeaders,
    query: { deviceId: DEVICE },
    body: { deviceId: DEVICE, mime: "image/jpeg", data: JPEG, capturedAt: "not-a-date" }
  });
  assert.equal(badTime.statusCode, 400);
});
