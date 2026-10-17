import test from "node:test";
import assert from "node:assert/strict";
import { createD1WorkspaceRepository, registerAxWorkspace } from "../ax-workspace.mjs";

function fakeFetch(records = []) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const sql = calls.at(-1).sql;
    const result = sql.startsWith("SELECT record_json")
      ? [{ results: records.map(record_json => ({ record_json })) }]
      : [{ results: [], meta: { changes: 1 } }];
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  return { fetchImpl, calls };
}

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set("GET " + path, handler); },
    post(path, handler) { routes.set("POST " + path, handler); }
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(authorization = "") {
  return { get(name) { return name.toLowerCase() === "authorization" ? authorization : ""; }, query: {}, body: {} };
}

test("Ax Workspace initializes durable tables and indexes", async () => {
  const mock = fakeFetch();
  const repo = createD1WorkspaceRepository({ accountId: "acct", databaseId: "db", apiToken: "secret", fetchImpl: mock.fetchImpl });
  const result = await repo.initialize();
  assert.equal(result.durable, true);
  assert.match(mock.calls[0].sql, /CREATE TABLE IF NOT EXISTS habitat_workspace_memories/);
  assert.match(mock.calls[1].sql, /CREATE INDEX IF NOT EXISTS habitat_workspace_project_updated/);
});

test("Ax Workspace validates memory and uses parameterized D1 writes", async () => {
  const mock = fakeFetch();
  const repo = createD1WorkspaceRepository({ accountId: "acct", databaseId: "db", apiToken: "secret", fetchImpl: mock.fetchImpl });
  const memory = await repo.upsert({ id: "decision-1", project: "DropPilot", category: "decision", content: "Require verified positive unit economics before promotion.", status: "verified", confidence: 1, sourceUrl: "https://github.com/example/decision" });
  assert.equal(memory.project, "DropPilot");
  assert.equal(memory.status, "verified");
  assert.equal(mock.calls[0].params[0], "decision-1");
  await assert.rejects(() => repo.upsert({ project: "DropPilot", content: "bad", category: "unknown" }), /category must be/);
  await assert.rejects(() => repo.upsert({ project: "DropPilot", content: "bad", sourceUrl: "javascript:alert(1)" }), /HTTP\(S\) URL/);
});

test("Ax Workspace lists only parsed records and applies project filtering", async () => {
  const record = { id: "mem-1", project: "Habitat", category: "fact", content: "CI passed", status: "verified", confidence: 1, createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", sourceUrl: null, expiresAt: null };
  const mock = fakeFetch([JSON.stringify(record), "{broken"]);
  const repo = createD1WorkspaceRepository({ accountId: "acct", databaseId: "db", apiToken: "secret", fetchImpl: mock.fetchImpl });
  const rows = await repo.list({ project: "Habitat", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "mem-1");
  assert.deepEqual(mock.calls[0].params, ["Habitat", 10]);
});

test("Ax Workspace fails closed when D1 rejects a request", async () => {
  const repo = createD1WorkspaceRepository({ accountId: "acct", databaseId: "db", apiToken: "secret", fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ success: false }) }) });
  await assert.rejects(() => repo.healthCheck(), /HTTP 403/);
});

test("memory reads reject missing and incorrect bearer tokens before querying storage", async () => {
  const mock = fakeFetch();
  const repository = createD1WorkspaceRepository({ accountId: "acct", databaseId: "db", apiToken: "secret", fetchImpl: mock.fetchImpl });
  const app = fakeApp();
  registerAxWorkspace(app, { repository, writeToken: "workspace-secret" });
  const handler = app.routes.get("GET /workspace/memories");

  const missingResponse = fakeResponse();
  await handler(request(), missingResponse);
  assert.equal(missingResponse.statusCode, 401);
  assert.equal(missingResponse.body.ok, false);

  const incorrectResponse = fakeResponse();
  await handler(request("Bearer wrong-token"), incorrectResponse);
  assert.equal(incorrectResponse.statusCode, 401);
  assert.equal(mock.calls.length, 0);
});

test("memory reads allow a valid bearer token and no-token configuration fails closed", async () => {
  const record = { id: "mem-1", project: "Habitat", category: "fact", content: "private context", status: "verified", confidence: 1, createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", sourceUrl: null, expiresAt: null };
  const mock = fakeFetch([JSON.stringify(record)]);
  const repository = createD1WorkspaceRepository({ accountId: "acct", databaseId: "db", apiToken: "secret", fetchImpl: mock.fetchImpl });
  const app = fakeApp();
  registerAxWorkspace(app, { repository, writeToken: "workspace-secret" });
  const handler = app.routes.get("GET /workspace/memories");
  const authorizedResponse = fakeResponse();
  await handler(request("Bearer workspace-secret"), authorizedResponse);
  assert.equal(authorizedResponse.statusCode, 200);
  assert.equal(authorizedResponse.body.memories[0].content, "private context");

  const unconfiguredApp = fakeApp();
  registerAxWorkspace(unconfiguredApp, { repository });
  const unconfiguredResponse = fakeResponse();
  await unconfiguredApp.routes.get("GET /workspace/memories")(request("Bearer workspace-secret"), unconfiguredResponse);
  assert.equal(unconfiguredResponse.statusCode, 503);
  assert.equal(unconfiguredResponse.body.ok, false);
  assert.equal(mock.calls.length, 1);
});
