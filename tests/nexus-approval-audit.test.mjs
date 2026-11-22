import test from "node:test";
import assert from "node:assert/strict";
import { createNexusAuditRecorder } from "../device-command-bridge.mjs";
import { registerNexusRuntime } from "../nexus-runtime.mjs";
import { createSecurityEventService, eventHash, verifyEventChain } from "../ax-security-events.mjs";

/**
 * Approval and denial audit wiring.
 *
 * The NEXUS runtime emits `device.command.approved` / `device.command.denied`, which are not
 * accepted categories for the append-only log. These tests prove the bridge translates them into
 * allowlisted categories, keeps the original event name as evidence, produces a verifiable hash
 * chain, and that a failing audit sink cannot be reported as a successful audited decision.
 */

function chainRepository() {
  const events = [];
  return {
    events,
    async append(event) {
      const seq = events.length ? events[events.length - 1].seq + 1 : 1;
      const prevHash = events.length ? events[events.length - 1].hash : null;
      const stored = { ...event, seq, prevHash };
      stored.hash = eventHash(prevHash, stored);
      events.push(stored);
      return stored;
    },
    async list({ limit = 50 } = {}) {
      return events.slice(-limit).reverse();
    },
    async chain({ limit = 500 } = {}) {
      return events.slice(-limit);
    }
  };
}

const quiet = { log() {}, warn() {}, error() {} };

// ---------------------------------------------------------------- route harness
function makeApp() {
  const routes = new Map();
  const register = method => (routePath, ...handlers) => routes.set(method + " " + routePath, handlers);
  return { routes, get: register("GET"), post: register("POST"), use() {} };
}
function recorder() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function findRoute(app, method, requestPath) {
  for (const [key, handlers] of app.routes) {
    const [routeMethod, routePath] = key.split(" ");
    if (routeMethod !== method) continue;
    const wanted = requestPath.split("/");
    const pattern = routePath.split("/");
    if (wanted.length !== pattern.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i += 1) {
      if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = decodeURIComponent(wanted[i]);
      else if (pattern[i] !== wanted[i]) { matched = false; break; }
    }
    if (matched) return { handlers, params };
  }
  return null;
}
async function request(app, method, requestPath, { headers = {}, body = {}, query = {}, params = {} } = {}) {
  const route = findRoute(app, method, requestPath);
  assert.ok(route, "route exists: " + method + " " + requestPath);
  const res = recorder();
  await route.handlers[route.handlers.length - 1]({ method, headers, body, query, params: { ...route.params, ...params } }, res);
  return res;
}

const OWNER = "owner-s26";
const OWNER_TOKEN = "owner_token_" + "o".repeat(24);
const OTHER = "paired-not-owner";
const OTHER_TOKEN = "paired_token_" + "p".repeat(24);

function taskRecord(id, extra = {}) {
  return { id, objective: "inspect docs", status: "needs_approval", approvals: [{ state: "requested" }], attempts: 1, ...extra };
}

async function mountRuntime({ audit, tasks = [taskRecord("cmd_a"), taskRecord("cmd_b")] } = {}) {
  const records = new Map(tasks.map(task => [task.id, task]));
  const repository = {
    async initialize() { return { ok: true }; },
    async get(id) { const task = records.get(id); return task ? structuredClone(task) : null; }
  };
  const engine = {
    async approve(input) { return { ok: true, task: { id: input.taskId, status: "working" } }; },
    async deny(input) { return { ok: true, task: { id: input.taskId, status: "failed" } }; },
    async cancel(input) { return { ok: true, task: { id: input.taskId, status: "cancelled" } }; },
    async list() { return { ok: true, tasks: [] }; }
  };
  const app = makeApp();
  const runtime = registerNexusRuntime(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: "ax_bridge_" + "a".repeat(32) },
    repository,
    query: async () => [{ results: [] }],
    engine,
    verifyDevice: async (token, deviceId) =>
      (deviceId === OWNER && token === OWNER_TOKEN) || (deviceId === OTHER && token === OTHER_TOKEN),
    ownerDeviceId: OWNER,
    audit,
    handleSignals: false,
    log: quiet
  });
  await runtime.initialize({ startWorker: false });
  return { app, records };
}

function decideAs(app, taskId, approved, { token = OWNER_TOKEN, deviceId = OWNER } = {}) {
  return request(app, "POST", "/device/command/tasks/" + taskId + "/approval", {
    headers: { authorization: "Bearer " + token },
    body: { deviceId, approved },
    params: { id: taskId }
  });
}

function decide(app, taskId, approved) {
  return decideAs(app, taskId, approved);
}

function cancelTask(app, taskId) {
  return request(app, "POST", "/device/command/tasks/" + taskId + "/cancel", {
    headers: { authorization: "Bearer " + OWNER_TOKEN },
    body: { deviceId: OWNER },
    params: { id: taskId }
  });
}

// ------------------------------------------------- 1. mapping and hash chain
test("approval maps to approval.created and forms a valid chain", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const record = createNexusAuditRecorder(security);

  const result = await record({ event: "device.command.approved", actorDeviceId: OWNER, targetDeviceId: "cmd_a" });
  assert.equal(result.ok, true);
  assert.equal(repository.events.length, 1);
  assert.equal(repository.events[0].category, "approval.created");
  assert.equal(repository.events[0].outcome, "allowed");
  assert.equal(repository.events[0].taskId, "cmd_a");
  assert.equal(repository.events[0].deviceId, OWNER);
  const evidence = JSON.parse(repository.events[0].evidence);
  assert.equal(evidence.event, "device.command.approved", "original event name is preserved");
  assert.equal(evidence.taskId, "cmd_a");
  assert.equal(evidence.actorDeviceId, OWNER);
  assert.equal(verifyEventChain(repository.events).ok, true);
});

test("denial maps to owner.rejection and forms a valid chain", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const record = createNexusAuditRecorder(security);

  const result = await record({ event: "device.command.denied", actorDeviceId: OWNER, targetDeviceId: "cmd_b" });
  assert.equal(result.ok, true);
  assert.equal(repository.events[0].category, "owner.rejection");
  assert.equal(repository.events[0].outcome, "denied");
  assert.equal(repository.events[0].severity, "medium");
  const evidence = JSON.parse(repository.events[0].evidence);
  assert.equal(evidence.event, "device.command.denied");
  assert.equal(verifyEventChain(repository.events).ok, true);
});

test("approval and denial share one verifiable chain", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const record = createNexusAuditRecorder(security);

  await record({ event: "device.command.approved", actorDeviceId: OWNER, targetDeviceId: "cmd_a" });
  await record({ event: "device.command.denied", actorDeviceId: OWNER, targetDeviceId: "cmd_b" });
  const integrity = await security.integrity({});
  assert.equal(integrity.ok, true);
  assert.equal(integrity.checked, 2);
  assert.deepEqual(repository.events.map(event => event.seq), [1, 2]);
  assert.equal(repository.events[1].prevHash, repository.events[0].hash);
});

test("the audit entry carries no credential material", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const record = createNexusAuditRecorder(security);

  await record({ event: "device.command.approved", actorDeviceId: OWNER, targetDeviceId: "cmd_a" });
  const serialized = JSON.stringify(repository.events[0]);
  assert.equal(/authorization|bearer|token/i.test(serialized), false);
});

test("an unavailable security log is an audit failure, not a silent success", async () => {
  const record = createNexusAuditRecorder(null);
  const result = await record({ event: "device.command.approved", actorDeviceId: OWNER, targetDeviceId: "cmd_a" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "security_log_not_configured");
});

test("a rejected security event is propagated as an audit failure", async () => {
  const security = createSecurityEventService({
    repository: { async append() { throw new Error("storage unavailable"); } },
    log: quiet
  });
  const record = createNexusAuditRecorder(security);
  const result = await record({ event: "device.command.denied", actorDeviceId: OWNER, targetDeviceId: "cmd_b" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "security_store_unavailable");
});

// ------------------------------------- 2. route behaviour on audit outcome
test("an audited approval is recorded and reported as recorded", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const { app } = await mountRuntime({ audit: createNexusAuditRecorder(security) });

  const response = await decide(app, "cmd_a", true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.recorded, true);
  assert.equal(repository.events.length, 1);
  assert.equal(repository.events[0].category, "approval.created");
  assert.equal(verifyEventChain(repository.events).ok, true);
});

test("an audited denial is recorded and reported as recorded", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const { app } = await mountRuntime({ audit: createNexusAuditRecorder(security) });

  const response = await decide(app, "cmd_b", false);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.decision, "denied");
  assert.equal(repository.events[0].category, "owner.rejection");
  assert.equal(verifyEventChain(repository.events).ok, true);
});

function assertAuditFailure(response, decision, status) {
  assert.equal(response.statusCode, 502, "an unaudited decision must not return 200");
  assert.equal(response.body.ok, false);
  assert.equal(response.body.recorded, false);
  assert.equal(response.body.decision, decision, "the applied decision is still reported");
  assert.equal(response.body.status, status, "the applied task status is still reported");
  assert.match(response.body.error, /could not be recorded in the security audit log/);
}

// All four sink states are audit failures: absence, no result, explicit failure and a throw.
test("a missing audit callback cannot produce an apparently successful decision", async () => {
  const { app } = await mountRuntime(); // no audit option at all
  assertAuditFailure(await decide(app, "cmd_a", true), "approved", "working");
});

test("an audit callback returning undefined is not treated as success", async () => {
  const { app } = await mountRuntime({ audit: async () => undefined });
  assertAuditFailure(await decide(app, "cmd_a", true), "approved", "working");
});

test("an audit callback returning {ok:false} is not treated as success", async () => {
  const { app } = await mountRuntime({ audit: async () => ({ ok: false }) });
  assertAuditFailure(await decide(app, "cmd_b", false), "denied", "failed");
});

test("a throwing audit sink cannot produce an apparently successful decision", async () => {
  const { app } = await mountRuntime({ audit: async () => { throw new Error("audit transport down"); } });
  assertAuditFailure(await decide(app, "cmd_b", false), "denied", "failed");
});

test("an unrecognised audit result is not treated as success", async () => {
  const { app } = await mountRuntime({ audit: async () => ({ ok: "true" }) });
  assertAuditFailure(await decide(app, "cmd_a", true), "approved", "working");
});

// ------------------------------------------- 3. refused owner decisions
test("a non-owner decision is refused and audited as command.unauthorized", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const { app } = await mountRuntime({ audit: createNexusAuditRecorder(security) });

  const response = await decideAs(app, "cmd_a", true, { token: OTHER_TOKEN, deviceId: OTHER });
  assert.equal(response.statusCode, 403);
  assert.equal(repository.events.length, 1, "the refusal produced exactly one security event");
  const entry = repository.events[0];
  assert.equal(entry.category, "command.unauthorized");
  assert.equal(entry.outcome, "denied");
  assert.equal(entry.taskId, "cmd_a");
  const evidence = JSON.parse(entry.evidence);
  assert.equal(evidence.event, "device.command.owner_refused");
  assert.equal(evidence.reason, "not_owner");
  assert.equal(verifyEventChain(repository.events).ok, true);
  assert.equal(JSON.stringify(entry).includes(OTHER_TOKEN), false, "no credential in the audit entry");
  assert.equal(JSON.stringify(entry).includes(OWNER_TOKEN), false);
});

test("a decision with an invalid credential is refused and audited without a device identity", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const { app } = await mountRuntime({ audit: createNexusAuditRecorder(security) });

  const response = await decideAs(app, "cmd_b", false, { token: "wrong-token", deviceId: OWNER });
  assert.equal(response.statusCode, 401);
  assert.equal(repository.events[0].category, "command.unauthorized");
  const evidence = JSON.parse(repository.events[0].evidence);
  assert.equal(evidence.event, "device.command.owner_refused");
  assert.equal(evidence.actorDeviceId, null, "an unverified device id is never recorded as the actor");
  assert.equal(typeof evidence.reason, "string");
  assert.equal(verifyEventChain(repository.events).ok, true);
});

test("an audit outage on a refused decision leaves the refusal status intact", async () => {
  const { app } = await mountRuntime({ audit: async () => undefined });
  const response = await decideAs(app, "cmd_a", true, { token: OTHER_TOKEN, deviceId: OTHER });
  assert.equal(response.statusCode, 403, "a log outage cannot upgrade or hide the refusal");
  assert.equal(response.body.recorded, undefined, "no audit-success field is added when nothing was recorded");
});

test("a refusal-audit flood is bounded so bad tokens cannot exhaust the log", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const { app } = await mountRuntime({ audit: createNexusAuditRecorder(security) });

  for (let index = 0; index < 14; index += 1) {
    const response = await decideAs(app, "cmd_a", true, { token: "wrong-token", deviceId: OWNER });
    assert.equal(response.statusCode, 401, "every attempt is still refused");
  }
  assert.equal(repository.events.length, 10, "the refusal audit is capped per window");
  assert.equal(verifyEventChain(repository.events).ok, true);
});

// ------------------------------------------------- 4. cancellation audit
test("cancellation maps to work.stop_requested and forms a valid chain", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const record = createNexusAuditRecorder(security);

  const result = await record({ event: "device.command.cancelled", actorDeviceId: OWNER, targetDeviceId: "cmd_c" });
  assert.equal(result.ok, true);
  assert.equal(repository.events[0].category, "work.stop_requested");
  assert.equal(repository.events[0].summary, "NEXUS task cancelled by the owner");
  assert.equal(repository.events[0].taskId, "cmd_c");
  assert.equal(JSON.parse(repository.events[0].evidence).event, "device.command.cancelled");
  assert.equal(verifyEventChain(repository.events).ok, true);
});

test("an audited cancellation is recorded and reported as recorded", async () => {
  const repository = chainRepository();
  const security = createSecurityEventService({ repository, log: quiet });
  const { app } = await mountRuntime({ audit: createNexusAuditRecorder(security) });

  const response = await cancelTask(app, "cmd_a");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "cancelled");
  assert.equal(response.body.recorded, true);
  assert.equal(repository.events[0].category, "work.stop_requested");
  assert.equal(verifyEventChain(repository.events).ok, true);
});

test("an unauditable cancellation reports 502 while preserving the applied state", async () => {
  const { app } = await mountRuntime({ audit: async () => undefined });

  const response = await cancelTask(app, "cmd_a");
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.recorded, false);
  assert.equal(response.body.status, "cancelled");
  assert.match(response.body.error, /could not be recorded in the security audit log/);
});
