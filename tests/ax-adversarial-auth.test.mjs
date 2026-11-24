import test from "node:test";
import assert from "node:assert/strict";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { createProjectRegistry } from "../ax-projects.mjs";

const BRIDGE = "bridge-token-for-adversarial-tests";
const COMMAND_ONLY = "command-only-token";

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

async function mount({ verifyDevice = async (token, deviceId) => token === "device-token" && deviceId === "owner-1", objectives = null } = {}) {
  const service = objectives || createObjectiveService({ repository: createMemoryObjectiveRepository() });
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: BRIDGE,
      HABITAT_AX_COMMAND_TOKEN: COMMAND_ONLY,
      HABITAT_OWNER_DEVICE_IDS: "owner-1"
    },
    repository: {
      async initialize() { return { ok: true }; },
      async create(task) { return task; },
      async get() { return null; },
      async update(_id, task) { return task; },
      async list() { return []; }
    },
    registry: { get() { return null; }, approvalRequiredFor() { return { required: false, known: true }; }, summary() { return { ok: true, count: 0, tools: [] }; } },
    objectiveProvider: () => service,
    projectProvider: () => createProjectRegistry({ objectives: service }),
    verifyDevice
  });
  const created = await service.create({ objective: "Owner gate test", criteria: ["owner only"], key: "auth-" + Math.random() });
  const id = created.objective.id;
  await service.understand(id, { summary: "Owner approval is required." });
  await service.plan(id, { steps: [{ objective: "inspect", agent: "engineering" }] });
  await service.requestApproval(id, { reason: "test" });
  return { app, service, id };
}

const bridge = { authorization: "Bearer " + BRIDGE };
const command = { authorization: "Bearer " + COMMAND_ONLY };
const owner = { "x-owner-device-id": "owner-1", "x-owner-device-token": "device-token" };

test("the command token cannot approve even with a valid owner device", async () => {
  const { app, service, id } = await mount();
  const res = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", {
    headers: { ...command, ...owner },
    body: { approvalId: "owner-approval:forged" }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "command_token_cannot_approve");
  const objective = await service.get(id);
  assert.equal(objective.approval.approvedAt, null);
});

test("a bridge token without an owner device proof is refused", async () => {
  const { app, service, id } = await mount();
  const res = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", { headers: bridge });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "owner_required");
  assert.equal((await service.get(id)).approval.approvedAt, null);
});

test("a revoked or expired device credential is refused and changes nothing", async () => {
  const { app, service, id } = await mount({ verifyDevice: async () => false });
  const res = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", {
    headers: { ...bridge, ...owner }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "owner_invalid");
  assert.equal((await service.get(id)).approval.approvedAt, null);
});

test("a valid device that is not a configured owner is refused", async () => {
  const { app, service, id } = await mount({ verifyDevice: async () => true });
  const res = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", {
    headers: { ...bridge, "x-owner-device-id": "stranger", "x-owner-device-token": "device-token" }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "not_owner");
  assert.equal((await service.get(id)).approval.approvedAt, null);
});

test("a body actor cannot forge the recorded approver, and a replay is idempotent", async () => {
  const { app, service, id } = await mount();
  const first = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", {
    headers: { ...bridge, ...owner },
    body: { by: "owner:evil", approvalId: "owner-approval:test" }
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.ok, true);
  const objective = await service.get(id);
  assert.equal(objective.approval.approvedBy, "owner:owner-1");
  assert.equal(objective.approval.approvalId, "owner-approval:test");

  const replay = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", {
    headers: { ...bridge, ...owner },
    body: { by: "owner:evil", approvalId: "owner-approval:test" }
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.replayed, true);
  const after = await service.get(id);
  assert.equal(after.approval.approvedBy, "owner:owner-1");
});

test("project scope denies cross-project authority", async () => {
  const registry = createProjectRegistry();
  assert.equal(registry.scopeAllows("droppilot", "vice-city-files"), false);
  assert.equal(registry.scopeAllows("habitat", "habitat"), true);
  assert.equal(registry.scopeAllows("Habitat", "droppilot"), false);
  assert.equal(registry.scopeAllows("", "habitat"), false);
});
