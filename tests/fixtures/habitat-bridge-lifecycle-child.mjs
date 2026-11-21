import { DatabaseSync } from "node:sqlite";
import { registerDeviceCommandBridge } from "../../device-command-bridge.mjs";
import { createD1CommandTaskRepository } from "../../d1-command-task-repository.mjs";
import { createD1DeviceCommandRepository } from "../../d1-device-command-repository.mjs";
import { createD1Query } from "../../nexus-runtime.mjs";
import { buildReadOnlyNexusAdapters } from "../../nexus-adapter-registration.mjs";

const db = new DatabaseSync(":memory:");
const fetchImpl = async (_url, init) => {
  const { sql, params = [] } = JSON.parse(init.body);
  const rows = db.prepare(sql).all(...params);
  return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
};
const accountId = "test", databaseId = "test", apiToken = "test";
const deviceRepo = createD1DeviceCommandRepository({ accountId, databaseId, apiToken, fetchImpl });
const taskRepo = createD1CommandTaskRepository({ accountId, databaseId, apiToken, fetchImpl });
const query = createD1Query({ accountId, databaseId, apiToken, fetchImpl });
await taskRepo.initialize();

const now = new Date().toISOString();
await taskRepo.create({
  id: "cmd_lifecycle_fixture", objective: "bridge lifecycle drain", role: "ax",
  adapter: "runtime.health", status: "queued", createdAt: now, updatedAt: now,
  attempts: 0, approvals: [], statusHistory: [], result: null, error: null
});

const base = buildReadOnlyNexusAdapters({
  rootDir: process.cwd(),
  allowedPrefixes: ["src", "tests", "docs", "app/src", "README.md", "package.json"],
  taskRepository: taskRepo,
  d1Query: query
});
const adapters = {
  ...base,
  "runtime.health": async task => {
    console.log("ADAPTER_START");
    await new Promise(resolve => setTimeout(resolve, 700));
    const result = await base["runtime.health"](task);
    console.log("ADAPTER_FINISHED");
    return result;
  }
};

const routes = new Map();
const app = {
  routes,
  post(path, ...handlers) { routes.set("POST " + path, handlers); },
  get(path, ...handlers) { routes.set("GET " + path, handlers); }
};
const bridge = registerDeviceCommandBridge(app, {
  env: {
    HABITAT_AX_BRIDGE_TOKEN: "fixture-ax-token",
    HABITAT_OWNER_DEVICE_ID: "owner-fixture",
    NEXUS_RUNTIME_ENABLED: "true"
  },
  repository: deviceRepo,
  taskRepository: taskRepo,
  query,
  adapters
});

bridge.initialize().then(result => {
  console.log("BRIDGE_INIT_DONE " + JSON.stringify({ started: Boolean(result?.nexus?.started) }));
}).catch(error => {
  console.error("BRIDGE_INIT_FAILED " + String(error?.message || error));
  process.exit(3);
});

// Keep the process alive while the worker timer is unref'd.
setInterval(() => {}, 1000);
