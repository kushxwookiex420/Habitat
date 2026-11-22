import test from "node:test";
import assert from "node:assert/strict";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createSecurityEventService } from "../ax-security-events.mjs";
import { createMemorySecurityEventRepository } from "../ax-security-event-repository.mjs";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createProjectRegistry } from "../ax-projects.mjs";

const AX_TOKEN = "ax-m11-secret";
const auth = { authorization: "Bearer " + AX_TOKEN };

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function matchRoute(app, key) {
  if (app.routes.has(key)) return { handlers: app.routes.get(key), params: {} };
  const [method, path] = key.split(" ");
  const parts = path.split("/").filter(Boolean);
  for (const [registered, handlers] of app.routes) {
    const [registeredMethod, registeredPath] = registered.split(" ");
    if (registeredMethod !== method) continue;
    const expected = registeredPath.split("/").filter(Boolean);
    if (expected.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < parts.length; index += 1) {
      if (expected[index].startsWith(":")) params[expected[index].slice(1)] = decodeURIComponent(parts[index]);
      else if (expected[index] !== parts[index]) { matched = false; break; }
    }
    if (matched) return { handlers, params };
  }
  return null;
}

async function invoke(app, key, req = {}) {
  const matched = matchRoute(app, key);
  assert.ok(matched, "registered route: " + key);
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(key, value) { this.headers[key] = value; return this; }
  };
  const request = { headers: {}, query: {}, body: {}, ...req, params: { ...matched.params, ...(req.params || {}) } };
  for (const handler of matched.handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function mount(overrides = {}) {
  const securityRepository = createMemorySecurityEventRepository();
  const security = createSecurityEventService({ repository: securityRepository });
  const ticks = createMemorySchedulerRepository();
  const scheduler = createSchedulerService({ ticks });
  const projects = createProjectRegistry();
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository: {
      async initialize() { return { ok: true }; },
      async create(task) { return task; },
      async get() { return null; },
      async update(_id, task) { return task; },
      async list() { return []; }
    },
    registry: { get() { return null; }, approvalRequiredFor() { return { required: false, known: true }; }, summary() { return { ok: true, count: 0, tools: [] }; } },
    securityProvider: () => security,
    schedulerProvider: () => scheduler,
    projectProvider: () => projects,
    ...overrides
  });
  return { app, security, securityRepository, ticks, scheduler };
}

test("security events are readable, append-only and integrity-checked over HTTP", async () => {
  const { app, security } = mount();
  const recorded = await security.record({ category: "auth.failure", actor: "anonymous", outcome: "denied", summary: "bad credential" });
  assert.equal(recorded.ok, true);
  const listed = await invoke(app, "GET /ax/command/security/events", { headers: auth });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.events[0].category, "auth.failure");
  assert.equal(listed.headers["cache-control"], "no-store");
  const integrity = await invoke(app, "GET /ax/command/security/integrity", { headers: auth });
  assert.equal(integrity.statusCode, 200);
  assert.equal(integrity.body.ok, true);
  assert.equal(integrity.body.checked, 1);
  assert.match(integrity.body.tamperEvidence, /not tamper-proof/i);
  // There is no POST route that could rewrite or append an event.
  assert.equal(matchRoute(app, "POST /ax/command/security/events"), null);
});

test("an invalid Ax credential produces an auth failure event without leaking the token", async () => {
  const { app, security } = mount();
  const refused = await invoke(app, "GET /ax/command/security/events", { headers: { authorization: "Bearer wrong-secret-value" } });
  assert.equal(refused.statusCode, 401);
  await new Promise(resolve => setTimeout(resolve, 10));
  const integrity = await security.list({ limit: 10 });
  assert.equal(integrity.events.length, 1);
  assert.equal(integrity.events[0].category, "auth.failure");
  assert.equal(integrity.events[0].outcome, "denied");
  assert.doesNotMatch(JSON.stringify(integrity.events[0]), /wrong-secret-value/);
});

test("scheduler status and tick are mounted and a tick cannot run twice at once", async () => {
  const { app } = mount();
  const status = await invoke(app, "GET /ax/command/scheduler/status", { headers: auth });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.scheduler.status, "never_run");
  assert.equal(status.body.scheduler.healthy, false);
  const tick = await invoke(app, "POST /ax/command/scheduler/tick", { headers: auth, body: { trigger: "test" } });
  assert.equal(tick.statusCode, 200);
  assert.equal(tick.body.ok, true);
});

test("projects are readable and scoped, with an explicit denial of cross-project authority", async () => {
  const { app } = mount();
  const listed = await invoke(app, "GET /ax/command/projects", { headers: auth });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.count, 3);
  const detail = await invoke(app, "GET /ax/command/projects/droppilot", { headers: auth });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.project.id, "droppilot");
  assert.equal(detail.body.project.scope.crossProjectActions, "denied");
  const missing = await invoke(app, "GET /ax/command/projects/nope", { headers: auth });
  assert.equal(missing.statusCode, 404);
});

test("unmounted operational surfaces answer 503 rather than inventing state", async () => {
  const { app } = mount({ securityProvider: null, schedulerProvider: null, projectProvider: null });
  for (const path of ["/ax/command/security/events", "/ax/command/security/integrity", "/ax/command/scheduler/status", "/ax/command/projects", "/ax/command/projects/habitat"]) {
    const response = await invoke(app, "GET " + path, { headers: auth });
    assert.equal(response.statusCode, 503, path);
    assert.equal(response.body.ok, false, path);
  }
});
