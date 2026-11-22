import test from "node:test";
import assert from "node:assert/strict";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { createAgentRuntime } from "../ax-agents.mjs";
import { createIncidentService, createRecoveryService } from "../ax-recovery.mjs";
import { createMemoryIncidentRepository } from "../ax-incident-repository.mjs";
import { createProviderCircuitBreaker } from "../ax-providers.mjs";

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
  const res = responseRecorder();
  const request = { headers: {}, query: {}, body: {}, ...req, params: { ...matched.params, ...(req.params || {}) } };
  for (const handler of matched.handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function commandRepository() {
  const rows = new Map();
  return {
    async initialize() { return { ok: true }; },
    async create(task) { rows.set(task.id, structuredClone(task)); return structuredClone(task); },
    async get(id) { const task = rows.get(id); return task ? structuredClone(task) : null; },
    async update(id, task) { rows.set(id, structuredClone(task)); return structuredClone(task); },
    async list({ status = null, limit = 50 } = {}) {
      return [...rows.values()].filter(task => !status || task.status === status).slice(0, limit).map(task => structuredClone(task));
    }
  };
}

function registry() {
  return {
    get(name) { return name === "system.health" ? { name, roles: ["ax"], availability: { state: "available" } } : null; },
    approvalRequiredFor() { return { required: false, known: true }; },
    summary() { return { ok: true, count: 1, tools: [{ name: "system.health" }] }; }
  };
}

const CRITERIA = ["The regression suite exited zero", "The evidence file exists in the repository"];
const AX_TOKEN = "ax-test-secret";
const COMMAND_TOKEN = "command-only-secret";
const OWNER_ID = "owner-phone";
const OWNER_TOKEN = "owner-device-token";
const auth = { authorization: "Bearer " + AX_TOKEN };
const ownerAuth = { ...auth, "x-owner-device-id": OWNER_ID, "x-owner-device-token": OWNER_TOKEN };
const ownerVerifier = async (token, deviceId) => token === OWNER_TOKEN && deviceId === OWNER_ID;

function build(overrides = {}) {
  const objectiveRepository = createMemoryObjectiveRepository();
  const incidentRepository = createMemoryIncidentRepository();
  const objectives = createObjectiveService({ repository: objectiveRepository, now: () => new Date().toISOString() });
  const incidents = createIncidentService({ repository: incidentRepository, now: () => new Date().toISOString() });
  const recovery = createRecoveryService({
    monitor: {
      scan: async () => ({
        ok: true,
        observedAt: "2026-11-22T00:00:00.000Z",
        findings: [{ kind: "queue.age_exceeded", severity: "high", subject: "queue", title: "Queue is old", detail: "1200s", recommendation: "probe", safeAction: "probe_subsystems" }],
        summary: { total: 1, high: 1 },
        probes: { presence: "ok" }
      })
    },
    incidents,
    repairs: { probe_subsystems: async () => ({ ok: true, verified: true, detail: "probed database=reachable" }) }
  });
  const agents = createAgentRuntime({
    dependencies: {
      memory: { recall: async () => ({ ok: true, citations: [{ key: "decision:deploy", version: 1, source: "owner" }] }) }
    }
  });
  const memoryStore = {
    async list() {
      return [
        { key: "decision:deploy", kind: "decision", statement: "We deploy to Render production on Fridays", status: "active", confidence: 0.9, version: 1, provenance: { source: "owner", observedAt: new Date().toISOString() } },
        { key: "decision:deploy-stop", kind: "decision", statement: "We do not deploy to Render production on Fridays", status: "active", confidence: 0.6, version: 1, provenance: { source: "import", observedAt: new Date().toISOString() } }
      ];
    }
  };
  const app = makeApp();
  const mounted = registerUniversalCommandRoutes(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
      HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN,
      HABITAT_OWNER_DEVICE_ID: OWNER_ID
    },
    repository: commandRepository(),
    registry: registry(),
    verifyDevice: ownerVerifier,
    objectiveProvider: () => objectives,
    agentProvider: () => agents,
    incidentProvider: () => incidents,
    recoveryProvider: () => recovery,
    deviceStateProvider: async () => ({
      ok: true,
      device: { device_id: "phone-1", created_at: "2026-11-20T00:00:00.000Z", last_seen_at: new Date().toISOString(), revoked_at: null },
      commands: [{ id: "c1", status: "completed", result: { ok: true, verified: true } }],
      pairing: { device_id: "phone-1", expires_at: "2026-11-30T00:00:00.000Z", consumed_at: "2026-11-20T00:00:00.000Z" }
    }),
    circuitProvider: () => createProviderCircuitBreaker(),
    memoryProvider: () => memoryStore,
    ...overrides
  });
  return { app, mounted, objectiveRepository, objectives, incidents, agents };
}

test("objective and agent routes fail closed without the Ax credential", async () => {
  const { app } = build();
  const unauthorized = await invoke(app, "POST /ax/command/objectives", { headers: {}, body: {} });
  assert.equal(unauthorized.statusCode, 401);

  const empty = makeApp();
  registerUniversalCommandRoutes(empty, {
    env: { HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN },
    repository: commandRepository(),
    registry: registry()
  });
  const unmounted = await invoke(empty, "POST /ax/command/objectives", { headers: auth, body: { objective: "Test the objective route without a store", criteria: CRITERIA } });
  assert.equal(unmounted.statusCode, 503);
  assert.equal(unmounted.body.code, "objectives_not_configured");
});

test("a sensitive objective is planned, gated, authorized by the owner and verified end to end", async () => {
  const { app, objectiveRepository } = build();

  const created = await invoke(app, "POST /ax/command/objectives", {
    headers: auth,
    body: {
      objective: "Publish the approved release notes to the public site",
      criteria: CRITERIA,
      budgetUsd: 0.05,
      key: "mission-10-e2e"
    }
  });
  assert.equal(created.statusCode, 201);
  const id = created.body.objective.id;

  const understood = await invoke(app, "POST /ax/command/objectives/" + id + "/understand", {
    headers: auth,
    body: { summary: "Publish notes after the regression suite passes.", constraints: ["no unverified publish"] }
  });
  assert.equal(understood.statusCode, 200);

  const planned = await invoke(app, "POST /ax/command/objectives/" + id + "/plan", {
    headers: auth,
    body: {
      steps: [{ objective: "publish the release notes", agent: "content", requiresApproval: true }],
      provider: "openai",
      estimatedCostUsd: 0.004,
      permissions: ["publish.external"]
    }
  });
  assert.equal(planned.statusCode, 200);
  assert.equal(planned.body.objective.approval.required, true);

  const ungatedStart = await invoke(app, "POST /ax/command/objectives/" + id + "/start", { headers: auth });
  assert.equal(ungatedStart.statusCode, 409);
  assert.equal(ungatedStart.body.code, "approval_required");

  const requested = await invoke(app, "POST /ax/command/objectives/" + id + "/request-approval", { headers: auth, body: { reason: "publishing" } });
  assert.equal(requested.body.objective.status, "awaiting_approval");

  const commandApproval = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", {
    headers: { authorization: "Bearer " + COMMAND_TOKEN, "x-owner-device-id": OWNER_ID, "x-owner-device-token": OWNER_TOKEN },
    body: {}
  });
  assert.equal(commandApproval.statusCode, 403);
  assert.equal(commandApproval.body.code, "command_token_cannot_approve");

  const noDevice = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", { headers: auth, body: {} });
  assert.equal(noDevice.statusCode, 401);

  const authorized = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", { headers: ownerAuth, body: {} });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.body.objective.status, "authorized");
  assert.ok(authorized.body.objective.approval.approvedAt);
  const replay = await invoke(app, "POST /ax/command/objectives/" + id + "/authorize", { headers: ownerAuth, body: {} });
  assert.equal(replay.body.replayed, true);

  const started = await invoke(app, "POST /ax/command/objectives/" + id + "/start", { headers: auth });
  assert.equal(started.body.objective.status, "executing");

  const attached = await invoke(app, "POST /ax/command/objectives/" + id + "/tasks", {
    headers: auth,
    body: { taskId: "cmd_task_mission_10", agent: "content", step: 0 }
  });
  assert.equal(attached.statusCode, 200);
  const duplicate = await invoke(app, "POST /ax/command/objectives/" + id + "/tasks", {
    headers: auth,
    body: { taskId: "cmd_task_mission_10", agent: "content", step: 0 }
  });
  assert.equal(duplicate.body.replayed, true);

  const evidence = await invoke(app, "POST /ax/command/objectives/" + id + "/evidence", {
    headers: auth,
    body: { items: [{ summary: "suite exited 0", taskId: "cmd_task_mission_10", source: "engineering" }, { summary: "notes file exists", source: "engineering" }] }
  });
  assert.equal(evidence.body.objective.evidence.length, 2);
  const evidenceIds = evidence.body.objective.evidence.map(item => item.id);

  const premature = await invoke(app, "POST /ax/command/objectives/" + id + "/complete", { headers: auth, body: {} });
  assert.equal(premature.statusCode, 409);
  assert.equal(premature.body.code, "verification_required");

  const verified = await invoke(app, "POST /ax/command/objectives/" + id + "/verify", {
    headers: auth,
    body: { checks: [{ criterionId: "c1", passed: true, evidenceIds: [evidenceIds[0]] }, { criterionId: "c2", passed: true, evidenceIds: [evidenceIds[1]] }] }
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.body.verified, true);
  assert.equal(verified.body.objective.status, "verifying");

  const completed = await invoke(app, "POST /ax/command/objectives/" + id + "/complete", { headers: auth, body: { summary: "Verified" } });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.objective.status, "completed");
  assert.equal(completed.body.objective.verification.verified, true);
  assert.equal(completed.body.objective.costUsd, 0);

  // Reconstructable after a process restart: a fresh service over the same durable repository.
  const restarted = createObjectiveService({ repository: objectiveRepository });
  const recovered = await restarted.get(id);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.verification.verified, true);
  assert.equal(recovered.transitions.at(-1).to, "completed");
  assert.ok(recovered.transitions.some(entry => entry.to === "authorized" && entry.by.startsWith("owner:")));
});

test("owner cancellation is gated and terminal", async () => {
  const { app } = build();
  const created = await invoke(app, "POST /ax/command/objectives", {
    headers: auth,
    body: { objective: "A cancellable objective with real criteria", criteria: CRITERIA, key: "cancel-e2e" }
  });
  const id = created.body.objective.id;
  await invoke(app, "POST /ax/command/objectives/" + id + "/understand", { headers: auth, body: { summary: "Cancellation test." } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/plan", { headers: auth, body: { steps: [{ objective: "noop", adapter: null }] } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/start", { headers: auth });

  const withCommandToken = await invoke(app, "POST /ax/command/objectives/" + id + "/cancel", {
    headers: { authorization: "Bearer " + COMMAND_TOKEN, "x-owner-device-id": OWNER_ID, "x-owner-device-token": OWNER_TOKEN },
    body: {}
  });
  assert.equal(withCommandToken.statusCode, 403);

  const cancelled = await invoke(app, "POST /ax/command/objectives/" + id + "/cancel", { headers: ownerAuth, body: { reason: "owner cancelled" } });
  assert.equal(cancelled.body.objective.status, "cancelled");
  const listed = await invoke(app, "GET /ax/command/objectives", { headers: auth, query: { status: "cancelled" } });
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.objectives[0].status, "cancelled");
});

test("agents expose a capability matrix and delegate real bounded work", async () => {
  const { app } = build();
  const matrix = await invoke(app, "GET /ax/command/agents", { headers: auth });
  assert.equal(matrix.statusCode, 200);
  // Mission 17 added the Director and Verification roles, which are assigned by the work cycle
  // rather than auto-routed from keywords.
  assert.equal(matrix.body.agents.length, 9);
  assert.ok(matrix.body.agents.some(agent => agent.id === "memory" && agent.available));
  assert.ok(matrix.body.agents.some(agent => agent.id === "research" && !agent.available));

  const selected = await invoke(app, "POST /ax/command/agents/select", { headers: auth, body: { objective: "Fix the failing Kotlin build" } });
  assert.equal(selected.body.selection.agent, "engineering");

  const delegated = await invoke(app, "POST /ax/command/agents/delegate", {
    headers: auth,
    body: { objective: "Recall the accepted deployment decision", role: "memory" }
  });
  assert.equal(delegated.body.ok, true);
  assert.equal(delegated.body.review.accepted, true);
  assert.equal(delegated.body.envelope.citations.length, 1);

  const unavailable = await invoke(app, "POST /ax/command/agents/delegate", {
    headers: auth,
    body: { objective: "Research the Render pricing page", role: "research" }
  });
  assert.equal(unavailable.body.ok, false);
  assert.equal(unavailable.body.envelope.code, "capability_unavailable");
});

test("the device routes report separated states and real capabilities", async () => {
  const { app } = build();
  const state = await invoke(app, "GET /ax/command/device/state", { headers: auth });
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.state.states.registered.value, "yes");
  assert.equal(state.body.state.states.commandExecuted.value, "yes");
  assert.equal(state.body.state.states.commandVerified.value, "yes");
  assert.equal(state.body.state.states.installed.value, "unknown");
  assert.equal(state.body.pairing.stage, "consumed");

  const capabilities = await invoke(app, "GET /ax/command/device/capabilities", { headers: auth });
  assert.equal(capabilities.body.capabilities.find(item => item.id === "device.shell").implemented, false);
  assert.equal(capabilities.body.capabilities.find(item => item.id === "device.status").available, true);

  const audit = await invoke(app, "GET /ax/command/device/pairing/audit", { headers: auth });
  assert.equal(audit.body.audit.stage, "consumed");
  assert.match(audit.body.guidance, /registered/);
});

test("recovery scan records incidents and a verified repair resolves one", async () => {
  const { app } = build();
  const scanned = await invoke(app, "POST /ax/command/recovery/scan", { headers: auth });
  assert.equal(scanned.statusCode, 200);
  assert.equal(scanned.body.report.recorded.length, 1);

  const incidents = await invoke(app, "GET /ax/command/recovery/incidents", { headers: auth, query: { status: "open" } });
  assert.equal(incidents.body.count, 1);
  const incidentId = incidents.body.incidents[0].id;

  const unverifiedRepair = await invoke(app, "POST /ax/command/recovery/incidents/" + incidentId + "/recover", {
    headers: ownerAuth,
    body: { action: "reconcile_run" }
  });
  assert.equal(unverifiedRepair.body.code, "repair_not_registered");

  const resolved = await invoke(app, "POST /ax/command/recovery/incidents/" + incidentId + "/recover", {
    headers: ownerAuth,
    body: { action: "probe_subsystems" }
  });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.body.incident.status, "resolved");
});

test("memory insights surface conflicts without rewriting either record", async () => {
  const { app } = build();
  const insights = await invoke(app, "GET /ax/command/memory/insights", { headers: auth, query: { project: "habitat", q: "deploy" } });
  assert.equal(insights.statusCode, 200);
  assert.equal(insights.body.insights.conflicts.length, 1);
  assert.equal(insights.body.insights.conflicts[0].resolution, "owner_review_required");
  assert.equal(insights.body.insights.total, 2);
  assert.ok(insights.body.insights.ranking.length >= 1);
});

test("no response body ever contains a credential", async () => {
  const { app } = build();
  const bodies = await Promise.all([
    invoke(app, "GET /ax/command/agents", { headers: auth }),
    invoke(app, "GET /ax/command/device/state", { headers: auth }),
    invoke(app, "GET /ax/command/providers", { headers: auth }),
    invoke(app, "GET /ax/command/memory/insights", { headers: auth })
  ]);
  for (const response of bodies) {
    const text = JSON.stringify(response.body);
    assert.equal(/sk-[A-Za-z0-9]{8,}/.test(text), false, "no provider key material");
    assert.equal(text.includes(AX_TOKEN), false, "the Ax token is never echoed");
    assert.equal(text.includes(COMMAND_TOKEN), false, "the command token is never echoed");
    assert.equal(text.includes(OWNER_TOKEN), false, "the owner token is never echoed");
  }
});

test("an authorized objective dispatches through the existing Ax run path", async () => {
  const calls = [];
  const { app } = build({
    orchestratorProvider: () => ({
      enabled: true,
      async runObjective(input) {
        calls.push(input);
        return {
          ok: false,
          code: "failed",
          run: {
            id: "run_dispatch",
            steps: [{ index: 0, taskId: "cmd_task_dispatch", agent: "engineering" }],
            evidence: ["suite exited 0"]
          }
        };
      }
    })
  });
  const created = await invoke(app, "POST /ax/command/objectives", {
    headers: auth,
    body: { objective: "Dispatch a verified objective through Ax", criteria: CRITERIA, key: "dispatch-e2e" }
  });
  const id = created.body.objective.id;
  await invoke(app, "POST /ax/command/objectives/" + id + "/understand", { headers: auth, body: { summary: "Dispatch test." } });
  await invoke(app, "POST /ax/command/objectives/" + id + "/plan", { headers: auth, body: { steps: [{ objective: "run the suite", agent: "engineering", adapter: null }] } });

  const beforeStart = await invoke(app, "POST /ax/command/objectives/" + id + "/dispatch", { headers: auth });
  assert.equal(beforeStart.statusCode, 409);

  await invoke(app, "POST /ax/command/objectives/" + id + "/start", { headers: auth });
  const dispatched = await invoke(app, "POST /ax/command/objectives/" + id + "/dispatch", { headers: auth });
  assert.equal(dispatched.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runKey, "objective:" + id);
  assert.equal(dispatched.body.objective.execution.tasks[0].taskId, "cmd_task_dispatch");
  assert.equal(dispatched.body.objective.evidence.length, 1);
  assert.ok(dispatched.body.objective.checkpoints.at(-1).note.includes("run_dispatch"));
  assert.equal(dispatched.body.objective.status, "executing", "dispatch never completes an objective");
});
