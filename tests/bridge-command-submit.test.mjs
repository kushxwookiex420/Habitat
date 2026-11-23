import test from "node:test";
import assert from "node:assert/strict";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";

/**
 * Exercises the real bridge + universal command engine with injected, in-memory repositories.
 * This is the submission half of the phone path: /chat calls submitCommandObjective, which reaches
 * the same engine the /ax/command routes use. It does NOT claim execution — only that a durable
 * queued task with a read-only adapter is created and that replay is idempotent.
 */

function fakeApp() {
  const routes = new Map();
  const add = method => (path, ...handlers) => routes.set(method + " " + path, handlers);
  return { get: add("GET"), post: add("POST"), use() {}, set() {}, routes };
}

function commandRepository() {
  const rows = new Map();
  return {
    durable: true,
    async initialize() {},
    async healthCheck() { return { ok: true, durable: true }; },
    async create(task) { rows.set(task.id, { ...task }); return task; },
    async get(id) { return rows.get(id) ? { ...rows.get(id) } : null; },
    async update(id, task) { rows.set(id, { ...task }); return task; },
    async transition(id, { next }) { rows.set(id, { ...next }); return next; },
    async list() { return [...rows.values()]; }
  };
}

function deviceRepository() {
  return {
    durable: true,
    async initialize() {},
    async listDevices() { return []; },
    async verifyDeviceToken() { return false; },
    async seedBootstrapPairing() {}
  };
}

test("Bridge chat submit reaches the universal engine and creates a queued task", async () => {
  const app = fakeApp();
  const taskRepository = commandRepository();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "bridge_token_for_test_only", NEXUS_RUNTIME_ENABLED: "false" },
    fetchImpl: async () => { throw new Error("test must not use the network"); },
    repository: deviceRepository(),
    taskRepository,
    log: { warn() {}, error() {}, log() {} }
  });

  const initialized = await bridge.initialize({ startWorker: false });
  assert.equal(initialized.ok, true);

  const submitted = await bridge.submitCommandObjective({
    objective: "inspect the repository state",
    requestedBy: "bridge-chat",
    role: "ax",
    adapter: "repo.inspect",
    idempotencyKey: "bridge-chat:test-1"
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.replayed, false);
  assert.match(submitted.task.id, /^cmd_/);
  assert.equal(submitted.task.status, "queued");
  assert.equal(submitted.task.adapter, "repo.inspect");
  assert.equal(submitted.task.requestedBy, "bridge-chat");

  const read = await bridge.getCommandTask(submitted.task.id);
  assert.equal(read.ok, true);
  assert.equal(read.task.objective, "inspect the repository state");

  const replay = await bridge.submitCommandObjective({
    objective: "inspect the repository state",
    requestedBy: "bridge-chat",
    role: "ax",
    adapter: "repo.inspect",
    idempotencyKey: "bridge-chat:test-1"
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, submitted.task.id);
});

test("Bridge submit fails closed when no command store is configured", async () => {
  const app = fakeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: { NEXUS_RUNTIME_ENABLED: "false" },
    fetchImpl: async () => { throw new Error("test must not use the network"); },
    repository: deviceRepository(),
    log: { warn() {}, error() {}, log() {} }
  });
  await bridge.initialize({ startWorker: false });
  const submitted = await bridge.submitCommandObjective({ objective: "inspect the repository state" });
  assert.equal(submitted.ok, false);
  assert.match(submitted.error, /storage is not configured/i);
});
