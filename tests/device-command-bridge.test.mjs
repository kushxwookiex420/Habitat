import test from "node:test";
import assert from "node:assert/strict";
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
    const handler = handlers[index];
    await handler(req, res, () => { called = true; next(); });
    if (!called) break;
  }
  return res;
}

test("bridge rejects missing credentials and only queues allowlisted read-only commands", async () => {
  const app = makeApp();
  const rows = new Map();
  const repository = {
    durable: true,
    async initialize() {},
    async enqueue(row) { rows.set(row.id, structuredClone(row)); },
    async claimNext(deviceId) {
      const row = [...rows.values()].find(x => x.deviceId === deviceId && x.status === "queued");
      if (!row) return null;
      row.status = "claimed";
      return structuredClone(row);
    },
    async complete({ id, deviceId, result, completedAt }) {
      const row = rows.get(id);
      if (!row || row.deviceId !== deviceId || row.status !== "claimed") return false;
      Object.assign(row, { status: "completed", result, completedAt });
      return true;
    },
    async get(id) { return rows.get(id) || null; }
  };
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "ax-secret", HABITAT_DEVICE_BRIDGE_TOKEN: "phone-secret" },
    repository
  });
  await bridge.initialize();

  const unauthorized = await invoke(app, "POST /ax/device/commands", {
    headers: {}, body: { deviceId: "s26", type: "device.status" }
  });
  assert.equal(unauthorized.statusCode, 401);

  const forbidden = await invoke(app, "POST /ax/device/commands", {
    headers: { authorization: "Bearer ax-secret" },
    body: { deviceId: "s26", type: "shell.exec" }
  });
  assert.equal(forbidden.statusCode, 400);

  const queued = await invoke(app, "POST /ax/device/commands", {
    headers: { authorization: "Bearer ax-secret" },
    body: { deviceId: "s26", type: "device.status" }
  });
  assert.equal(queued.statusCode, 202);
  const id = queued.body.command.id;

  const claimed = await invoke(app, "GET /device/commands/next", {
    headers: { authorization: "Bearer phone-secret" }, query: { deviceId: "s26" }
  });
  assert.equal(claimed.body.command.id, id);

  const completed = await invoke(app, "POST /device/commands/:id/result", {
    headers: { authorization: "Bearer phone-secret" }, params: { id },
    body: { deviceId: "s26", result: { ok: true, summary: "Device diagnostics collected." } }
  });
  assert.equal(completed.body.status, "completed");

  const readback = await invoke(app, "GET /ax/device/commands/:id", {
    headers: { authorization: "Bearer ax-secret" }, params: { id }
  });
  assert.equal(readback.body.command.status, "completed");
  assert.equal(readback.body.command.result.ok, true);
});
