import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";
import { createD1CommandTaskRepository, d1DatabaseEndpoint } from "../d1-command-task-repository.mjs";
import { createD1Query } from "../nexus-runtime.mjs";

/**
 * Mainline integration properties.
 *
 * These are the properties the live `main` branch did not have and that the Nexus integration
 * must not regress:
 *   1. exactly one D1 endpoint builder — the API and the worker cannot address different databases;
 *   2. the bridge only ever talks to HABITAT_D1_DATABASE_ID, even when a second database id is
 *      present in the environment;
 *   3. no worker and no runtime route when D1 is incomplete (fail closed, not "best effort");
 *   4. an unknown adapter fails the task with an explicit error instead of fabricating completion.
 *
 * Storage is SQLite (node:sqlite) behind the repository's real D1 HTTP shape. This is NOT a live
 * Cloudflare D1 test and proves nothing about the deployed database.
 */

const AX = "ax_bridge_" + "a".repeat(40);
const API_TOKEN = "d1_api_token_" + "t".repeat(24);
const LIVE_DB = "db-mainline-0001";
const OTHER_DB = "db-nonproduction-0002";

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

/** A D1 transport shim: same request shape, SQLite as the engine. */
function sqliteTransport(database) {
  const databaseUrls = [];
  const fetched = [];
  const fetchImpl = async (url, init = {}) => {
    databaseUrls.push(String(url));
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    fetched.push({ sql, headers: init.headers || {} });
    const rows = database.prepare(sql).all(...params);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
  return { fetchImpl, databaseUrls, fetched };
}

test("the worker query and the task repository resolve the identical D1 endpoint", async () => {
  const db = new DatabaseSync(":memory:");
  const transport = sqliteTransport(db);
  const config = { accountId: "acct-1", databaseId: LIVE_DB, apiToken: API_TOKEN, fetchImpl: transport.fetchImpl };
  const repository = createD1CommandTaskRepository(config);
  const query = createD1Query(config);

  await repository.initialize();
  await query("SELECT 1 AS ok");

  const endpoints = new Set(transport.databaseUrls);
  assert.equal(endpoints.size, 1, "every request used one endpoint");
  assert.equal([...endpoints][0], d1DatabaseEndpoint({ accountId: "acct-1", databaseId: LIVE_DB }));
  assert.equal([...endpoints][0].includes(API_TOKEN), false, "the API token is never part of a URL");
});

test("the endpoint builder refuses a missing account or database id", () => {
  assert.throws(() => d1DatabaseEndpoint({ accountId: "acct", databaseId: "" }), /account id and a database id/);
  assert.throws(() => d1DatabaseEndpoint({ accountId: "", databaseId: LIVE_DB }), /account id and a database id/);
  assert.throws(() => d1DatabaseEndpoint(), /account id and a database id/);
});

test("a second database id in the environment is never contacted", async () => {
  const db = new DatabaseSync(":memory:");
  const transport = sqliteTransport(db);
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: AX,
      HABITAT_OWNER_DEVICE_ID: "owner-s26",
      NEXUS_RUNTIME_ENABLED: "true",
      CLOUDFLARE_ACCOUNT_ID: "acct-1",
      HABITAT_D1_DATABASE_ID: LIVE_DB,
      HABITAT_D1_API_TOKEN: API_TOKEN,
      // A production/nonproduction marker an operator might also set. Mainline must ignore it.
      HABITAT_PRODUCTION_D1_DATABASE_ID: OTHER_DB
    },
    fetchImpl: transport.fetchImpl,
    handleSignals: false,
    exitOnSignal: false,
    log: { log() {}, warn() {}, error() {} }
  });

  const initialized = await bridge.initialize({ startWorker: false });
  assert.equal(initialized.ok, true);
  assert.equal(initialized.nexus.configured, true);

  assert.ok(transport.databaseUrls.length > 0, "initialization actually reached D1");
  assert.ok(
    transport.databaseUrls.every(url => url.includes(LIVE_DB)),
    "every request addresses HABITAT_D1_DATABASE_ID"
  );
  assert.equal(
    transport.databaseUrls.some(url => url.includes(OTHER_DB)),
    false,
    "the other database id is never addressed"
  );
  assert.equal(
    transport.databaseUrls.some(url => url.includes(API_TOKEN)),
    false,
    "no credential appears in a request URL"
  );
  assert.equal(
    transport.fetched.some(call => String(call.headers.Authorization || "") === "Bearer " + API_TOKEN),
    true,
    "the token is presented only as a bearer credential"
  );
  await bridge.shutdown("test");
});

test("incomplete D1 configuration mounts no worker and no runtime route", async () => {
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX, NEXUS_RUNTIME_ENABLED: "true", CLOUDFLARE_ACCOUNT_ID: "acct-1" },
    handleSignals: false,
    log: { log() {}, warn() {}, error() {} }
  });
  const initialized = await bridge.initialize();
  assert.equal(initialized.ok, false);
  assert.equal(bridge.nexus(), null);
  assert.equal(bridge.status().nexus.configured, false);
  assert.equal(bridge.status().nexus.reason, "command_store_unavailable");
  assert.equal(app.routes.has("GET /nexus/runtime"), false);
  const started = await bridge.startNexusWorker();
  assert.equal(started.ok, false);
});

test("the runtime endpoint reports a non-secret database fingerprint", async () => {
  const db = new DatabaseSync(":memory:");
  const transport = sqliteTransport(db);
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: AX,
      NEXUS_RUNTIME_ENABLED: "true",
      CLOUDFLARE_ACCOUNT_ID: "acct-1",
      HABITAT_D1_DATABASE_ID: LIVE_DB,
      HABITAT_D1_API_TOKEN: API_TOKEN
    },
    fetchImpl: transport.fetchImpl,
    handleSignals: false,
    log: { log() {}, warn() {}, error() {} }
  });
  await bridge.initialize();

  const runtime = await invoke(app, "GET /nexus/runtime", { headers: { authorization: "Bearer " + AX } });
  assert.equal(runtime.statusCode, 200);
  const fingerprint = runtime.body.runtime.databaseFingerprint;
  assert.match(fingerprint, /^[a-f0-9]{12}$/);
  assert.equal(fingerprint, createHash("sha256").update(LIVE_DB).digest("hex").slice(0, 12));
  assert.equal(JSON.stringify(runtime.body).includes(LIVE_DB), false, "the raw database id is not returned");
  assert.equal(JSON.stringify(runtime.body).includes(API_TOKEN), false);

  const unauthenticated = await invoke(app, "GET /nexus/runtime", { headers: {} });
  assert.equal(unauthenticated.statusCode, 401);
  await bridge.shutdown("test");
});

test("an unregistered adapter fails the task instead of fabricating completion", async () => {
  const db = new DatabaseSync(":memory:");
  const transport = sqliteTransport(db);
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: AX,
      NEXUS_RUNTIME_ENABLED: "true",
      CLOUDFLARE_ACCOUNT_ID: "acct-1",
      HABITAT_D1_DATABASE_ID: LIVE_DB,
      HABITAT_D1_API_TOKEN: API_TOKEN
    },
    fetchImpl: transport.fetchImpl,
    handleSignals: false,
    log: { log() {}, warn() {}, error() {} }
  });
  await bridge.initialize();
  assert.ok(bridge.nexus(), "runtime mounted");
  assert.equal(bridge.status().nexus.started, true, "worker started");

  // Written straight into the store, the way another writer or a pre-upgrade row could appear:
  // the submit allowlist never accepts this name, so only the worker can meet it.
  const at = new Date().toISOString();
  const taskId = "cmd_unknown_adapter_0001";
  await createD1CommandTaskRepository({
    accountId: "acct-1", databaseId: LIVE_DB, apiToken: API_TOKEN, fetchImpl: transport.fetchImpl
  }).create({
    id: taskId,
    objective: "run a command nobody implements",
    role: "ax",
    requestedBy: "ax",
    status: "queued",
    adapter: "shell.exec",
    attempts: 0,
    createdAt: at,
    updatedAt: at,
    history: []
  });

  await bridge.nexus().worker.tick();

  const stored = await createD1CommandTaskRepository({
    accountId: "acct-1", databaseId: LIVE_DB, apiToken: API_TOKEN, fetchImpl: transport.fetchImpl
  }).get(taskId);
  assert.equal(stored.status, "failed");
  assert.equal(Boolean(stored.result), false, "no completion result was fabricated");
  assert.match(stored.error, /No adapter registered for "shell\.exec"/);
  await bridge.shutdown("test");
});
