import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";
import { createD1DeviceCommandRepository } from "../d1-device-command-repository.mjs";
import { createD1Query } from "../nexus-runtime.mjs";
import { buildReadOnlyNexusAdapters, READ_ONLY_ADAPTER_NAMES } from "../nexus-adapter-registration.mjs";

/**
 * Integration tests through the real Habitat bridge mount:
 * real device-command-bridge -> real /ax/command routes -> real universal engine ->
 * real D1 repository code -> real Nexus worker -> real adapter -> real SQLite database.
 *
 * SQLite is the isolated storage engine (node:sqlite). It is reached through the repository's
 * production HTTP shape by a local D1 transport shim, so the repository and every SQL statement
 * run unchanged. This is NOT a live Cloudflare D1 test.
 */

const AX = "ax_bridge_" + "a".repeat(40);
const OWNER = "owner-s26";
const OWNER_TOKEN = "owner_token_" + "o".repeat(30);
const INTRUDER = "intruder-1";
const INTRUDER_TOKEN = "intruder_token_" + "i".repeat(30);

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    post(path, ...handlers) { routes.set("POST " + path, handlers); },
    get(path, ...handlers) { routes.set("GET " + path, handlers); }
  };
}

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function matchRoute(pattern, path) {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

async function invoke(app, key, req = {}) {
  const [method, path] = key.split(" ");
  let handlers = app.routes.get(key);
  let params = {};
  if (!handlers) {
    for (const [routeKey, candidate] of app.routes) {
      const [routeMethod, routePath] = routeKey.split(" ");
      if (routeMethod !== method) continue;
      const match = matchRoute(routePath, path);
      if (match) { handlers = candidate; params = match; break; }
    }
  }
  assert.ok(handlers, "route exists: " + key);
  if (Object.keys(params).length) req = { ...req, params: { ...params, ...(req.params || {}) } };
  const res = recorder();
  let index = 0;
  let called = true;
  while (index < handlers.length && called) {
    called = false;
    await handlers[index](req, res, () => { called = true; index += 1; });
  }
  return res;
}

function harness({ adapters = null, owner = OWNER, withOwnerToken = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const d1Fetch = async (_url, init) => {
    const { sql, params = [] } = JSON.parse(init.body);
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
  const deviceRepo = createD1DeviceCommandRepository({ accountId: "test", databaseId: "test", apiToken: "test", fetchImpl: d1Fetch });
  const taskRepo = createD1CommandTaskRepository({ accountId: "test", databaseId: "test", apiToken: "test", fetchImpl: d1Fetch });
  const query = createD1Query({ accountId: "test", databaseId: "test", apiToken: "test", fetchImpl: d1Fetch });
  const baseAdapters = buildReadOnlyNexusAdapters({
    rootDir: process.cwd(),
    allowedPrefixes: ["src", "tests", "docs", "app/src", "README.md", "package.json"],
    taskRepository: taskRepo,
    d1Query: query
  });
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX, HABITAT_OWNER_DEVICE_ID: owner },
    repository: deviceRepo,
    taskRepository: taskRepo,
    query,
    adapters: adapters ? adapters(baseAdapters) : baseAdapters,
    handleSignals: false,
    exitOnSignal: false,
    log: { log() {}, warn() {}, error() {} }
  });
  return { app, bridge, db, taskRepo, deviceRepo, adapters: baseAdapters, query };
}

async function seedDevice(deviceRepo, deviceId, token) {
  await deviceRepo.registerDevice({ deviceId, tokenHash: hash(token), createdAt: new Date().toISOString() });
}

async function submit(app, adapter = "runtime.health", key = "integration-" + Date.now()) {
  return invoke(app, "POST /ax/command/tasks", {
    headers: { authorization: "Bearer " + AX },
    body: { objective: "integration runtime health", role: "ax", adapter, idempotencyKey: key }
  });
}

test("1. Habitat imports the packaged runtime and adapter registration", () => {
  assert.equal(typeof registerDeviceCommandBridge, "function");
  assert.deepEqual([...READ_ONLY_ADAPTER_NAMES].sort(), ["repo.inspect", "runtime.health", "task.inspect"]);
  assert.equal(READ_ONLY_ADAPTER_NAMES.includes("repo.test"), false);
});

test("2/4/5. initialize starts the real worker exactly once and reports workerStarted", async () => {
  const h = harness();
  await h.deviceRepo.initialize();
  await seedDevice(h.deviceRepo, OWNER, OWNER_TOKEN);
  const first = await h.bridge.initialize();
  assert.equal(first.ok, true);
  assert.equal(first.nexus.started, true);
  assert.equal(first.nexus.worker, true);
  assert.equal(h.bridge.status().nexus.started, true);

  const second = await h.bridge.initialize();
  assert.equal(second.alreadyInitialized, true);
  const again = await h.bridge.nexus().worker.start();
  assert.equal(again.alreadyRunning, true, "a second start does not create another timer");

  const status = await invoke(h.app, "GET /nexus/runtime", { headers: { authorization: "Bearer " + AX } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.runtime.workerConfigured, true);
  assert.equal(status.body.runtime.workerStarted, true);
  assert.ok(status.body.runtime.liveWorkers >= 1);
  assert.equal(status.body.runtime.heartbeatVerified, true);
});

test("3. missing configuration fails closed and starts no worker", async () => {
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, { env: {}, handleSignals: false, log: { log() {}, warn() {}, error() {} } });
  const initialized = await bridge.initialize();
  assert.equal(initialized.ok, false);
  assert.equal(bridge.status().ready, false);
  assert.equal(bridge.status().nexus.configured, false);
  assert.equal(bridge.nexus(), null);
  assert.equal(app.routes.has("GET /nexus/runtime"), false, "no runtime route is mounted without storage");
});

test("6/7. an authorized task is claimed, runtime.health executes, and the result persists", async () => {
  const h = harness();
  await h.bridge.initialize();
  const submitted = await submit(h.app, "runtime.health", "integration-health-1");
  assert.equal(submitted.statusCode, 201);
  const taskId = submitted.body.task.id;

  await h.bridge.nexus().worker.tick();
  const stored = await h.taskRepo.get(taskId);
  assert.equal(stored.status, "done");
  assert.equal(stored.adapter, "runtime.health");
  assert.equal(stored.result.evidence.some(line => line.startsWith("runtime:")), true);
  assert.ok(stored.result.summary.length > 3);

  const read = await invoke(h.app, "GET /ax/command/tasks/" + taskId, { headers: { authorization: "Bearer " + AX } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.task.status, "done");
  assert.equal(read.body.task.result.evidence.some(line => line.startsWith("runtime:")), true);
});

test("8. adapters outside the three-name allowlist are rejected before storage", async () => {
  const h = harness();
  await h.bridge.initialize();
  for (const adapter of ["repo.test", "shell.exec", "RUNTIME.HEALTH", " runtime.health "]) {
    const rejected = await submit(h.app, adapter, "reject-" + adapter);
    assert.equal(rejected.statusCode, 400, adapter);
    assert.equal(rejected.body.code, "adapter_not_allowed", adapter);
  }
  const list = await invoke(h.app, "GET /ax/command/tasks", { headers: { authorization: "Bearer " + AX } });
  assert.equal(list.body.tasks.length, 0);
});

test("9. owner-device authentication remains enforced on approval routes", async () => {
  const h = harness();
  await h.deviceRepo.initialize();
  await seedDevice(h.deviceRepo, OWNER, OWNER_TOKEN);
  await seedDevice(h.deviceRepo, INTRUDER, INTRUDER_TOKEN);
  await h.bridge.initialize();

  const intruder = await invoke(h.app, "GET /device/command/approvals", {
    headers: { authorization: "Bearer " + INTRUDER_TOKEN }, query: { deviceId: INTRUDER }
  });
  assert.equal(intruder.statusCode, 403);

  const missingToken = await invoke(h.app, "GET /device/command/approvals", { query: { deviceId: OWNER } });
  assert.equal(missingToken.statusCode, 401);

  const owner = await invoke(h.app, "GET /device/command/approvals", {
    headers: { authorization: "Bearer " + OWNER_TOKEN }, query: { deviceId: OWNER }
  });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body.ok, true);
});

test("10. graceful shutdown drains an in-flight adapter and persists completion", async () => {
  let delayed = 0;
  const h = harness({
    adapters: base => ({
      ...base,
      "runtime.health": async task => {
        delayed += 1;
        await new Promise(resolve => setTimeout(resolve, 250));
        return base["runtime.health"](task);
      }
    })
  });
  await h.bridge.initialize();
  const submitted = await submit(h.app, "runtime.health", "integration-drain-1");
  const taskId = submitted.body.task.id;

  const tick = h.bridge.nexus().worker.tick();
  await new Promise(resolve => setTimeout(resolve, 60));
  const started = Date.now();
  const stopped = await h.bridge.shutdown("test-drain");
  const elapsed = Date.now() - started;
  await tick;

  assert.equal(stopped.ok, true);
  assert.ok(elapsed >= 150, "shutdown waited for the adapter instead of abandoning it");
  const stored = await h.taskRepo.get(taskId);
  assert.equal(stored.status, "done");
  assert.equal(delayed, 1);
  const second = await h.bridge.shutdown("test-drain-again");
  assert.equal(second.ok, true, "repeated shutdown is idempotent");
});

test("12. pairing and heartbeat still work through the mounted bridge", async () => {
  const h = harness();
  await h.bridge.initialize();

  const issued = await invoke(h.app, "POST /ax/device/pairings", {
    headers: { authorization: "Bearer " + AX }, body: { deviceId: "android-s26" }
  });
  assert.equal(issued.statusCode, 201);
  const paired = await invoke(h.app, "POST /device/pair", {
    headers: {}, body: { deviceId: "android-s26", code: issued.body.pairing.code }
  });
  assert.equal(paired.statusCode, 200);
  const token = paired.body.token;

  const beat = await invoke(h.app, "POST /device/heartbeat", {
    headers: { authorization: "Bearer " + token },
    body: { deviceId: "android-s26", details: { model: "Galaxy S26 Ultra", batteryPercent: 80 } }
  });
  assert.equal(beat.statusCode, 200);
  assert.equal(beat.body.ok, true);
  assert.equal(JSON.stringify(beat.body).includes(token), false);
});
