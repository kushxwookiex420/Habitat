import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";
import { runTick } from "../scripts/nexus-tick.mjs";

/**
 * Mission 14 — complete-system acceptance.
 *
 * This suite mounts the real composition root (`registerDeviceCommandBridge`), so every component
 * below is the production implementation:
 *   HTTP routes, both credentials, the durable message channel, the command engine, the NEXUS
 *   runtime tick, the read-only adapter, evidence, the objective lifecycle, budget reservation and
 *   settlement, the scheduler lease, autonomy, the security audit log and the notification inbox.
 *
 * Simulated: the model transport only. `fetchImpl` answers Chat Completions with a fixed plan and
 * stores everything else in node:sqlite through a D1-shaped transport. No OpenAI account, no D1 and
 * no Render service is involved, so this is LOCAL evidence, not staging evidence.
 */

const COMMAND_TOKEN = "axcmd_" + "c".repeat(30);
const BRIDGE_TOKEN = "axbridge_" + "b".repeat(30);
const NEXUS_TOKEN = "axnexus_" + "n".repeat(30);
const OPENAI_KEY = "sk-mock-" + "0".repeat(32);
const OWNER_DEVICE = "owner-s26-ultra";

const quiet = { log() {}, warn() {}, error() {} };

function envFor(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: "acct-m14",
    HABITAT_D1_DATABASE_ID: "db-m14-e2e",
    HABITAT_D1_API_TOKEN: "d1_token_m14_" + "x".repeat(16),
    HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN,
    HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN,
    AX_NEXUS_TOKEN: NEXUS_TOKEN,
    HABITAT_OWNER_DEVICE_IDS: OWNER_DEVICE,
    NEXUS_RUNTIME_ENABLED: "true",
    OPENAI_API_KEY: OPENAI_KEY,
    AX_PROVIDER: "openai",
    AX_ORCHESTRATOR_ENABLED: "true",
    AX_RUN_DEADLINE_MS: "8000",
    AX_POLL_MS: "10",
    AX_MAX_STEPS: "3",
    AX_MAX_CORRECTIONS: "1",
    AX_RUN_BUDGET_USD: "0.05",
    AX_FAILED_CALL_COST_USD: "0.005",
    AX_RECONCILE_AFTER_MS: "0",
    ...overrides
  };
}

function d1Fetch({ db, plan }) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/chat/completions")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: JSON.stringify({ steps: plan }) } }],
            usage: { prompt_tokens: 800, completion_tokens: 150 }
          };
        }
      };
    }
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const statement = db.prepare(sql);
    const rows = /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)
      ? statement.all(...params)
      : (statement.run(...params), []);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); },
    use() {}
  };
}

function recorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "registered route: " + key);
  const res = recorder();
  const request = { headers: {}, query: {}, params: {}, body: {}, ...req };
  for (const handler of handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const axAuth = { authorization: "Bearer " + COMMAND_TOKEN };
const nexusAuth = { "x-nexus-token": NEXUS_TOKEN };

async function mountBridge({ db, plan, envOverrides = {} } = {}) {
  const env = envFor(envOverrides);
  const fetchImpl = d1Fetch({ db, plan });
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env,
    fetchImpl,
    handleSignals: false,
    exitOnSignal: false,
    log: quiet
  });
  const init = await bridge.initialize({ startWorker: false });
  assert.equal(init.ok, true, JSON.stringify(init));
  return { app, bridge, env, fetchImpl };
}

async function submitMessage(app, body) {
  return invoke(app, "POST /ax/command/messages", { headers: axAuth, body });
}

async function tickScheduler(app) {
  return invoke(app, "POST /ax/command/scheduler/tick", {
    headers: axAuth,
    body: { trigger: "mission-14-e2e" }
  });
}

const PLAN = [{ objective: "report runtime health", adapter: "runtime.health" }];

// ------------------------------------------------------------------ 1. the 15-point exchange

test("Ax and NEXUS complete an authenticated, persisted, idempotent exchange end to end", async () => {
  const db = new DatabaseSync(":memory:");
  const first = await mountBridge({ db, plan: PLAN });
  const correlationId = "mission14-e2e-exchange";

  // 1. Ax submits a harmless test task.
  const submitted = await submitMessage(first.app, {
    kind: "task",
    body: "Harmless acceptance probe",
    objective: "report runtime health",
    adapter: "runtime.health",
    correlationId,
    idempotencyKey: "mission14-e2e-1"
  });
  assert.equal(submitted.statusCode, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.message.status, "queued");
  assert.equal(submitted.body.message.from, "ax");
  const messageId = submitted.body.message.id;

  // 2. Habitat persisted it (durable read through the same store the routes use).
  const stored = await first.app.routes.get("GET /ax/command/messages/:id")
    && await invoke(first.app, "GET /ax/command/messages/:id", { headers: axAuth, params: { id: messageId } });
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.body.message.correlationId, correlationId);

  // 3. Unauthorized submission is rejected before storage.
  const anonymous = await invoke(first.app, "POST /ax/command/messages", {
    body: { kind: "note", body: "no credential", idempotencyKey: "mission14-e2e-anon" }
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.body.code, "invalid_token");

  // 4. Duplicate submission does not queue a second execution.
  const duplicate = await submitMessage(first.app, {
    kind: "task",
    body: "Harmless acceptance probe",
    objective: "report runtime health",
    adapter: "runtime.health",
    correlationId,
    idempotencyKey: "mission14-e2e-1"
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.replayed, true);
  assert.equal(duplicate.body.message.id, messageId);

  // 5. Ax can never act as NEXUS: the acknowledgement surface refuses Ax's credential.
  const spoofed = await invoke(first.app, "POST /ax/nexus/messages/:id/acknowledge", {
    headers: axAuth,
    params: { id: messageId }
  });
  assert.equal(spoofed.statusCode, 401);
  assert.equal(spoofed.body.code, "invalid_nexus_token");

  // 6. NEXUS receives it: the scheduler's autonomy pass acknowledges and dispatches it.
  const autonomyTick = await tickScheduler(first.app);
  assert.equal(autonomyTick.statusCode, 200, JSON.stringify(autonomyTick.body));
  assert.equal(autonomyTick.body.ok, true);
  assert.equal(autonomyTick.body.autonomy?.messages?.submitted, 1);

  const working = await invoke(first.app, "GET /ax/command/messages/:id", { headers: axAuth, params: { id: messageId } });
  assert.equal(working.body.message.status, "working");
  assert.match(working.body.message.taskId, /^cmd_/);

  // 7. NEXUS executes it: the real runtime tick claims the task and runs the read-only adapter.
  const execution = await runTick({ env: first.env, fetchImpl: first.fetchImpl, log: quiet });
  assert.equal(execution.exitCode, 0, JSON.stringify(execution.report));
  assert.equal(execution.report.tick.claimed, 1);

  const task = await invoke(first.app, "GET /ax/command/tasks/:id", {
    headers: axAuth,
    params: { id: working.body.message.taskId }
  });
  assert.equal(task.statusCode, 200);
  assert.equal(task.body.task.status, "done");
  assert.ok((task.body.task.result?.evidence || []).length > 0, "the adapter produced evidence");

  // 8. The next autonomy pass settles the message from the task's own evidence.
  const settleTick = await tickScheduler(first.app);
  assert.equal(settleTick.body.ok, true);
  assert.equal(settleTick.body.autonomy?.messages?.completed, 1);

  // 9. Ax retrieves the result by correlation id.
  const thread = await invoke(first.app, "GET /ax/command/messages/thread/:correlationId", {
    headers: axAuth,
    params: { correlationId }
  });
  assert.equal(thread.statusCode, 200);
  assert.equal(thread.body.count, 1);
  assert.equal(thread.body.terminal[0].status, "completed");
  assert.ok(thread.body.terminal[0].result.evidence.length > 0);
  assert.equal(thread.body.awaitingDecision.length, 0);

  // 10. The whole exchange is visible in the audit history.
  const audit = await invoke(first.app, "GET /ax/command/security/events", { headers: axAuth, query: { limit: 200 } });
  assert.equal(audit.statusCode, 200);
  const categories = (audit.body.events || []).map(event => event.category);
  assert.ok(categories.includes("ax.message.submitted"), "submission is audited");
  assert.ok(categories.includes("ax.message.completed"), "completion is audited");
  assert.ok(categories.includes("auth.failure"), "the refused submission is audited");

  // 11. Process restart: a brand-new bridge over the same durable database.
  const second = await mountBridge({ db, plan: PLAN });
  const afterRestart = await invoke(second.app, "GET /ax/command/messages/thread/:correlationId", {
    headers: axAuth,
    params: { correlationId }
  });
  assert.equal(afterRestart.statusCode, 200);

  // 12. State is reconstructed, not remembered.
  assert.equal(afterRestart.body.terminal[0].status, "completed");
  assert.equal(afterRestart.body.messages[0].id, messageId);

  // 13. Duplicate execution is still prevented after the restart.
  const replayAfterRestart = await submitMessage(second.app, {
    kind: "task",
    body: "Harmless acceptance probe",
    objective: "report runtime health",
    adapter: "runtime.health",
    correlationId,
    idempotencyKey: "mission14-e2e-1"
  });
  assert.equal(replayAfterRestart.body.replayed, true);
  const idleTick = await tickScheduler(second.app);
  assert.equal(idleTick.body.autonomy?.messages?.examined, 0, "nothing is claimable");
  const secondTick = await runTick({ env: second.env, fetchImpl: second.fetchImpl, log: quiet });
  assert.equal(secondTick.report.tick.claimed, 0, "no second execution");

  const list = await invoke(second.app, "GET /ax/command/messages", { headers: axAuth, query: { limit: 50 } });
  assert.equal(list.body.count, 1, "exactly one message exists");
  const tasks = await invoke(second.app, "GET /ax/command/tasks", { headers: axAuth, query: { limit: 50 } });
  assert.equal(tasks.body.tasks.length, 1, "exactly one task exists");
});

// ------------------------------------------------- 2. autonomous objective execution

test("NEXUS advances a low-risk planned objective without an owner in the loop", async () => {
  const db = new DatabaseSync(":memory:");
  const h = await mountBridge({ db, plan: PLAN });

  const created = await invoke(h.app, "POST /ax/command/objectives", {
    headers: axAuth,
    body: {
      objective: "Report the runtime health of the command engine",
      key: "mission14-autonomy",
      budgetUsd: 0.05,
      criteria: ["runtime evidence is recorded", "the run budget is settled"]
    }
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  const objectiveId = created.body.objective.id;

  const understood = await invoke(h.app, "POST /ax/command/objectives/:id/understand", {
    headers: axAuth,
    params: { id: objectiveId },
    body: { summary: "read runtime health", constraints: ["read-only"], missingInformation: [] }
  });
  assert.equal(understood.body.ok, true);

  const planned = await invoke(h.app, "POST /ax/command/objectives/:id/plan", {
    headers: axAuth,
    params: { id: objectiveId },
    body: {
      steps: [{ objective: "report runtime health", agent: "operations", adapter: "runtime.health" }],
      risk: "low",
      permissions: [],
      estimatedCostUsd: 0.01
    }
  });
  assert.equal(planned.body.ok, true);
  assert.equal(planned.body.objective.approval.required, false);

  // One scheduler tick starts and dispatches it; the same tick's autonomy pass did the work.
  const tick = await tickScheduler(h.app);
  assert.equal(tick.statusCode, 200, JSON.stringify(tick.body));
  assert.equal(tick.body.autonomy?.objectives?.advanced?.length, 1);
  assert.equal(tick.body.autonomy.objectives.advanced[0].ok, true);

  const after = await invoke(h.app, "GET /ax/command/objectives/:id", { headers: axAuth, params: { id: objectiveId } });
  assert.equal(after.statusCode, 200);
  assert.equal(after.body.objective.status, "executing");
  assert.ok(after.body.objective.execution.tasks.length >= 1, "the run's task is attached to the objective");
  assert.ok(after.body.objective.evidence.length >= 1, "adapter evidence reached the objective");
  assert.ok(after.body.accounting.spentUsd > 0, "the reservation was settled against real cost");
  assert.equal(after.body.accounting.executions[0].status, "settled");

  // The same tick twice must not dispatch a second run.
  const again = await tickScheduler(h.app);
  assert.equal(again.body.ok, true);
  const secondTick = await runTick({ env: h.env, fetchImpl: h.fetchImpl, log: quiet });
  assert.equal(secondTick.report.tick.claimed, 0);
  const runs = await invoke(h.app, "GET /ax/command/runs", { headers: axAuth, query: { limit: 20 } });
  assert.equal(runs.body.runs.length, 1, "one objective produced one run");
});

// ------------------------------------------------- 3. approval boundaries stay enforced

test("an approval-gated objective is never started autonomously and the command token cannot approve it", async () => {
  const db = new DatabaseSync(":memory:");
  const h = await mountBridge({ db, plan: PLAN });

  const created = await invoke(h.app, "POST /ax/command/objectives", {
    headers: axAuth,
    body: {
      objective: "Deploy the new release to production",
      key: "mission14-gated",
      budgetUsd: 0.05,
      criteria: ["production deployment is refused without owner approval"]
    }
  });
  const objectiveId = created.body.objective.id;

  await invoke(h.app, "POST /ax/command/objectives/:id/understand", {
    headers: axAuth,
    params: { id: objectiveId },
    body: { summary: "production deployment", constraints: [], missingInformation: [] }
  });
  const planned = await invoke(h.app, "POST /ax/command/objectives/:id/plan", {
    headers: axAuth,
    params: { id: objectiveId },
    body: {
      steps: [{ objective: "deploy", agent: "operations", adapter: null, requiresApproval: true }],
      risk: "high",
      permissions: ["production.deploy"]
    }
  });
  assert.equal(planned.body.ok, true);
  assert.equal(planned.body.objective.approval.required, true);

  // Autonomy must leave it alone: high risk, approval-gated, prohibited permission.
  const tick = await tickScheduler(h.app);
  assert.equal(tick.body.ok, true);
  assert.equal(tick.body.autonomy?.objectives?.advanced?.length || 0, 0);
  const untouched = await invoke(h.app, "GET /ax/command/objectives/:id", { headers: axAuth, params: { id: objectiveId } });
  assert.equal(untouched.body.objective.status, "planned");

  // Starting it is refused without owner approval.
  const start = await invoke(h.app, "POST /ax/command/objectives/:id/start", { headers: axAuth, params: { id: objectiveId } });
  assert.equal(start.statusCode, 409);
  assert.equal(start.body.code, "approval_required");

  // Ax cannot approve its own objective. The command token is refused structurally, before any
  // device check; the device-capable bridge token still needs a real device proof and is refused at
  // that step instead.
  const asCommand = await invoke(h.app, "POST /ax/command/objectives/:id/authorize", {
    headers: { authorization: "Bearer " + COMMAND_TOKEN, "x-owner-device-id": OWNER_DEVICE, "x-owner-device-token": "guess" },
    params: { id: objectiveId },
    body: { approvalId: "self-issued" }
  });
  assert.equal(asCommand.statusCode, 403);
  assert.equal(asCommand.body.code, "command_token_cannot_approve");

  const asBridge = await invoke(h.app, "POST /ax/command/objectives/:id/authorize", {
    headers: { authorization: "Bearer " + BRIDGE_TOKEN, "x-owner-device-id": OWNER_DEVICE, "x-owner-device-token": "guess" },
    params: { id: objectiveId },
    body: { approvalId: "self-issued" }
  });
  assert.equal(asBridge.statusCode, 401);
  assert.equal(asBridge.body.code, "owner_invalid");

  // And the objective is still not running.
  const final = await invoke(h.app, "GET /ax/command/objectives/:id", { headers: axAuth, params: { id: objectiveId } });
  assert.equal(final.body.objective.status, "planned");
  assert.equal(final.body.accounting.spentUsd, 0);
});
