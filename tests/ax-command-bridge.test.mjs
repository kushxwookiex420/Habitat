import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { registerNexusRuntime, createD1Query } from "../nexus-runtime.mjs";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";
import { runTick } from "../scripts/nexus-tick.mjs";

/**
 * The Ax communication bridge, exercised through the real route handlers, the real command engine,
 * the real D1-shaped repository and a real tick execution, with SQLite behind the D1 HTTP shape.
 *
 * This is a complete local round trip: Ax → route → task row → NEXUS tick → adapter evidence →
 * route → Ax. It is NOT a ChatGPT connection and proves nothing about a deployment.
 */

const COMMAND_TOKEN = "ax_command_" + "c".repeat(28);
const BRIDGE_TOKEN = "ax_bridge_" + "b".repeat(28);
const DEVICE_TOKEN = "device_token_" + "d".repeat(20);

const CREDS = {
  CLOUDFLARE_ACCOUNT_ID: "acct-ax",
  HABITAT_D1_DATABASE_ID: "db-ax-0001",
  HABITAT_D1_API_TOKEN: "d1_token_ax_" + "x".repeat(20),
  NEXUS_RUNTIME_ENABLED: "true"
};

const ENV = { ...CREDS, HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN, HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN };
const quiet = { log() {}, warn() {}, error() {} };

function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const fetchImpl = async (url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
  const repository = createD1CommandTaskRepository({
    accountId: CREDS.CLOUDFLARE_ACCOUNT_ID,
    databaseId: CREDS.HABITAT_D1_DATABASE_ID,
    apiToken: CREDS.HABITAT_D1_API_TOKEN,
    fetchImpl
  });
  return { db, fetchImpl, repository };
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "registered route: " + key);
  const res = responseRecorder();
  // One request object for the whole chain: a guard that records the verified role on the request
  // must hand that same request to the next handler, exactly as the real router does.
  const request = { headers: {}, query: {}, params: {}, body: {}, ...req };
  for (const handler of handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const ax = { authorization: "Bearer " + COMMAND_TOKEN };

async function mount({ env = ENV, repository, presenceProvider } = {}) {
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env,
    fetchImpl: repository?.fetchImpl,
    repository,
    presenceProvider
  });
  return app;
}

async function submit(app, body = {}) {
  return invoke(app, "POST /ax/command/tasks", {
    headers: ax,
    body: { objective: "report runtime health", adapter: "runtime.health", idempotencyKey: "ax-key-" + Math.random().toString(16).slice(2), ...body }
  });
}

// 1. Valid Ax authentication.
test("the command token alone authenticates the command surface", async () => {
  const d1 = sqliteD1();
  const app = await mount({ repository: d1.repository });
  const res = await submit(app, { idempotencyKey: "ax-auth-valid" });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.schemaVersion, 1);
  assert.equal(res.body.ok, true);
  assert.match(res.body.task.id, /^cmd_/);
  assert.equal(res.body.task.status, "queued");
  // The credential never reaches the task record.
  assert.equal(JSON.stringify(res.body).includes(COMMAND_TOKEN), false);
});

// 2. Invalid and missing tokens, and an unconfigured service that must fail closed.
test("missing, invalid and unconfigured credentials are refused", async () => {
  const d1 = sqliteD1();
  const app = await mount({ repository: d1.repository });

  const missing = await invoke(app, "GET /ax/command/tasks");
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.code, "invalid_token");
  assert.equal(missing.body.schemaVersion, 1);

  const wrong = await invoke(app, "GET /ax/command/tasks", { headers: { authorization: "Bearer not-the-token" } });
  assert.equal(wrong.statusCode, 401);

  // A real bridge token value is still needed: the command token must not be a prefix or a hash.
  const prefix = await invoke(app, "GET /ax/command/tasks", { headers: { authorization: "Bearer " + COMMAND_TOKEN.slice(0, 20) } });
  assert.equal(prefix.statusCode, 401);

  const unconfiguredApp = await mount({
    env: { ...CREDS },
    repository: d1.repository
  });
  const unconfigured = await invoke(unconfiguredApp, "GET /ax/command/tasks", { headers: ax });
  assert.equal(unconfigured.statusCode, 503, "no configured credential means no access, not open access");
  assert.equal(unconfigured.body.code, "command_auth_unconfigured");
});

// 3. Task submission.
test("submission stores the objective, the role and the idempotency key", async () => {
  const d1 = sqliteD1();
  const app = await mount({ repository: d1.repository });
  const res = await submit(app, { objective: "summarise the queue", idempotencyKey: "ax-submit-1" });

  assert.equal(res.statusCode, 201);
  const stored = await d1.repository.get(res.body.task.id);
  assert.equal(stored.objective, "summarise the queue");
  assert.equal(stored.requestedBy, "ax");
  assert.equal(stored.role, "ax");
  assert.deepEqual(stored.statusHistory.map(entry => entry.to), ["queued"]);
});

// 4. Acknowledgment: the same key must never create a second task.
test("a replayed idempotency key returns the original task and creates nothing", async () => {
  const d1 = sqliteD1();
  const app = await mount({ repository: d1.repository });

  const first = await submit(app, { idempotencyKey: "ax-replay-1" });
  const second = await submit(app, { idempotencyKey: "ax-replay-1" });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.task.id, first.body.task.id);
  assert.equal((await d1.repository.list({ limit: 50 })).length, 1, "exactly one row exists");
});

// 5 + 8. Progress, result and evidence, produced by a real tick.
test("progress and result come from an actual NEXUS execution, not from the request", async () => {
  const d1 = sqliteD1();
  const app = await mount({ repository: d1.repository });
  const submitted = await submit(app, { idempotencyKey: "ax-round-trip-1" });
  const id = submitted.body.task.id;

  const before = await invoke(app, "GET /ax/command/tasks/:id", { headers: ax, params: { id } });
  assert.equal(before.statusCode, 200);
  assert.equal(before.body.task.status, "queued");
  assert.equal(before.body.task.result ?? null, null);

  const tick = await runTick({ env: { ...ENV }, fetchImpl: d1.fetchImpl, log: quiet });
  assert.equal(tick.exitCode, 0, JSON.stringify(tick.report));
  assert.equal(tick.report.tick.completed, 1);

  const after = await invoke(app, "GET /ax/command/tasks/:id", { headers: ax, params: { id } });
  assert.equal(after.body.task.id, id, "the same id Ax was given");
  assert.equal(after.body.task.status, "done");
  assert.ok(after.body.task.result.evidence.some(line => line.startsWith("runtime:")), "evidence came from the adapter");
  assert.match(after.body.task.result.verifiedBy, /^nexus-/, "the worker id, not Ax, marked the result verified");

  const listed = await invoke(app, "GET /ax/command/tasks", { headers: ax, query: { status: "done" } });
  assert.equal(listed.body.tasks[0].id, id);
});

// 6. Event cursor pagination, including a same-millisecond tie.
test("the change feed pages with a stable (updatedAt, id) cursor and never repeats", async () => {
  const d1 = sqliteD1();
  await d1.repository.initialize();
  const tied = "2026-11-21T00:00:00.000Z";
  for (const id of ["cmd_tie_a", "cmd_tie_b", "cmd_tie_c"]) {
    await d1.repository.create({
      id, objective: "tied change", role: "ax", requestedBy: "ax",
      status: "queued", adapter: null, attempts: 0,
      createdAt: tied, updatedAt: tied, history: []
    });
  }
  const app = await mount({ repository: d1.repository });

  const first = await invoke(app, "GET /ax/command/events", { headers: ax, query: { since: "", limit: "2" } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.schemaVersion, 1);
  assert.equal(first.body.events.length, 2);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.events[0].taskId, "cmd_tie_a");
  assert.equal(first.body.events[0].type, "task.queued");

  const second = await invoke(app, "GET /ax/command/events", {
    headers: ax,
    query: { since: first.body.nextSince, afterId: first.body.nextAfterId, limit: "2" }
  });
  assert.equal(second.body.events.length, 1, "the third tied row is not skipped by the cursor");
  assert.equal(second.body.events[0].taskId, "cmd_tie_c");
  assert.equal(second.body.hasMore, false);

  const seen = [...first.body.events, ...second.body.events].map(event => event.taskId);
  assert.deepEqual(seen, ["cmd_tie_a", "cmd_tie_b", "cmd_tie_c"]);
  assert.equal(new Set(seen).size, 3, "no duplicates across pages");

  const invalid = await invoke(app, "GET /ax/command/events", { headers: ax, query: { since: "not-a-date" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, "invalid_since");
});

test("a task that needs approval appears in the feed as task.approval_required", async () => {
  const d1 = sqliteD1();
  const app = await mount({ repository: d1.repository });
  const submitted = await submit(app, { idempotencyKey: "ax-approval-feed" });
  const id = submitted.body.task.id;

  const requested = await invoke(app, "POST /ax/command/tasks/:id/approval", {
    headers: ax,
    params: { id },
    body: { reason: "publishing needs the owner" }
  });
  assert.equal(requested.statusCode, 200);
  assert.equal(requested.body.task.status, "needs_approval");

  const feed = await invoke(app, "GET /ax/command/events", { headers: ax, query: { since: "1970-01-01T00:00:00.000Z" } });
  const event = feed.body.events.find(entry => entry.taskId === id);
  assert.equal(event.type, "task.approval_required");
  assert.equal(event.requiresApproval, true);
  assert.ok(event.changes.some(change => change.to === "needs_approval"), "the transition is visible");
});

// 7. Presence.
test("presence reports the executor it was given, and admits when there is none", async () => {
  const d1 = sqliteD1();
  const mounted = await mount({
    repository: d1.repository,
    presenceProvider: async () => ({
      executor: { configured: true, started: true, state: "running" },
      heartbeat: { verified: true, liveWorkers: 1, asleep: false, lastHeartbeatAgeSeconds: 4 },
      queue: { ok: true, eligible: 0, blocked: 0, stale: false },
      canExecute: true
    })
  });
  const live = await invoke(mounted, "GET /ax/command/presence", { headers: ax });
  assert.equal(live.statusCode, 200);
  assert.equal(live.body.presence.reachable, true);
  assert.equal(live.body.presence.canExecute, true);
  assert.equal(live.body.presence.queue.eligible, 0);

  const bare = await invoke(await mount({ repository: d1.repository }), "GET /ax/command/presence", { headers: ax });
  assert.equal(bare.body.presence.canExecute, false);
  assert.equal(bare.body.presence.executor.state, "not_mounted");
  assert.equal(bare.body.presence.heartbeat.asleep, true);
});

test("a failing presence provider is reported as unavailable, not as healthy", async () => {
  const d1 = sqliteD1();
  const app = await mount({
    repository: d1.repository,
    presenceProvider: async () => { throw new Error("d1 down"); }
  });
  const res = await invoke(app, "GET /ax/command/presence", { headers: ax });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.presence.canExecute, false);
  assert.equal(res.body.presence.heartbeat.verified, false);
});

// 9. Owner approval enforcement.
test("the command token can request an approval but can never satisfy one", async () => {
  const d1 = sqliteD1();
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: ENV,
    fetchImpl: d1.fetchImpl,
    repository: d1.repository,
    verifyDevice: async () => true,
    ownerDeviceIds: "owner-device-1",
    presenceProvider: null
  });

  const submitted = await submit(app, { idempotencyKey: "ax-cannot-approve" });
  const id = submitted.body.task.id;
  await invoke(app, "POST /ax/command/tasks/:id/approval", { headers: ax, params: { id }, body: { reason: "needs owner" } });

  const ownerHeaders = { "x-owner-device-id": "owner-device-1", "x-owner-device-token": DEVICE_TOKEN };
  const asCommand = await invoke(app, "POST /ax/command/tasks/:id/approve", {
    headers: { ...ax, ...ownerHeaders },
    params: { id }
  });
  assert.equal(asCommand.statusCode, 403);
  assert.equal(asCommand.body.code, "command_token_cannot_approve");
  assert.equal((await d1.repository.get(id)).status, "needs_approval", "nothing changed");

  // Control: the same request with the device-capable bridge token and a verified device succeeds,
  // so the refusal above is about the command token, not about a broken route.
  const asBridge = await invoke(app, "POST /ax/command/tasks/:id/approve", {
    headers: { authorization: "Bearer " + BRIDGE_TOKEN, ...ownerHeaders },
    params: { id }
  });
  assert.equal(asBridge.statusCode, 200);
  assert.equal(asBridge.body.task.status, "working");
});

// 10. Prevention of unauthorized device actions.
test("the command token is refused by the device-capable runtime route", async () => {
  const d1 = sqliteD1();
  await runTick({ env: { ...ENV }, fetchImpl: d1.fetchImpl, log: quiet });

  const app = makeApp();
  registerNexusRuntime(app, {
    env: ENV,
    fetchImpl: d1.fetchImpl,
    repository: d1.repository,
    query: createD1Query({
      accountId: CREDS.CLOUDFLARE_ACCOUNT_ID,
      databaseId: CREDS.HABITAT_D1_DATABASE_ID,
      apiToken: CREDS.HABITAT_D1_API_TOKEN,
      fetchImpl: d1.fetchImpl
    }),
    worker: { lastTick: () => null },
    handleSignals: false,
    log: quiet
  });

  const asCommand = await invoke(app, "GET /nexus/runtime", { headers: ax });
  assert.equal(asCommand.statusCode, 401, "the command token has no operator or device powers");

  const asBridge = await invoke(app, "GET /nexus/runtime", { headers: { authorization: "Bearer " + BRIDGE_TOKEN } });
  assert.equal(asBridge.statusCode, 200);
  assert.equal(asBridge.body.runtime.workerConfigured, true);
});

// The schema ChatGPT imports: public, valid, and free of secrets.
test("the OpenAPI document is public, valid and carries no credential", async () => {
  const d1 = sqliteD1();
  const app = await mount({ repository: d1.repository });
  const res = await invoke(app, "GET /ax/command/openapi.json", { headers: { host: "habitat.example.test" } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.openapi, "3.1.0");
  assert.equal(res.body.schemaVersion, undefined, "the envelope must not corrupt the document");
  assert.deepEqual(Object.keys(res.body.paths).sort(), [
    "/ax/command/events",
    "/ax/command/presence",
    "/ax/command/tasks",
    "/ax/command/tasks/{id}",
    "/ax/command/tools"
  ]);
  assert.equal(res.body.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.equal(res.body.servers[0].url, "https://habitat.example.test");
  const text = JSON.stringify(res.body);
  assert.equal(text.includes(COMMAND_TOKEN), false);
  assert.equal(text.includes(BRIDGE_TOKEN), false);
  for (const path of Object.values(res.body.paths)) {
    for (const operation of Object.values(path)) {
      assert.ok(operation.description.length <= 300, "GPT Action description limit");
    }
  }
});
