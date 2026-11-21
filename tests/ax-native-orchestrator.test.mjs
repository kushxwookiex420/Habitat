import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";
import { createD1Query, createNexusWorker, NEXUS_HEARTBEAT_TABLE_SQL } from "../nexus-runtime.mjs";
import { createD1AxRunRepository } from "../d1-ax-run-repository.mjs";
import { READ_ONLY_ADAPTER_NAMES } from "../nexus-adapter-registration.mjs";
import {
  createAxOrchestrator,
  createOpenAiPlanner,
  resolveAxOrchestratorConfig,
  redact,
  verifyResult
} from "../ax-orchestrator.mjs";
import { runTick } from "../scripts/nexus-tick.mjs";

/**
 * Habitat-native Ax, end to end through real code:
 *
 *   HTTP route → orchestrator → real command engine → real task rows → real NEXUS tick
 *   → real adapter evidence → verification → run record → HTTP answer
 *
 * The ONLY stub is the model transport: `mockModel` below answers the /chat/completions request with
 * a canned plan, exactly as a real response would, and its credential is a fake. No OpenAI account is
 * contacted, so this is a simulated *model*, not a simulated integration. Every task, execution and
 * verification is real application code writing to SQLite through the D1 HTTP shape.
 */

const COMMAND_TOKEN = "ax_command_" + "c".repeat(28);
const OPENAI_KEY = "sk-mock-" + "0".repeat(32);

const CREDS = {
  CLOUDFLARE_ACCOUNT_ID: "acct-native",
  HABITAT_D1_DATABASE_ID: "db-native-0001",
  HABITAT_D1_API_TOKEN: "d1_token_native_" + "x".repeat(20),
  NEXUS_RUNTIME_ENABLED: "true",
  HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN,
  OPENAI_API_KEY: OPENAI_KEY,
  AX_ORCHESTRATOR_ENABLED: "true",
  AX_MODEL: "gpt-6-luna",
  AX_RUN_DEADLINE_MS: "8000",
  AX_POLL_MS: "20",
  AX_MAX_STEPS: "4",
  AX_MAX_CORRECTIONS: "1",
  AX_RUN_BUDGET_USD: "0.05"
};

const quiet = { log() {}, warn() {}, error() {} };

function planPayload(steps, { prompt = 900, completion = 220 } = {}) {
  return {
    choices: [{ message: { content: JSON.stringify({ steps }) } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion }
  };
}

function harness({ replies = [], env = CREDS } = {}) {
  const db = new DatabaseSync(":memory:");
  const modelRequests = [];
  const queued = [...replies];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/chat/completions")) {
      modelRequests.push({ url: target, headers: init.headers || {}, body: JSON.parse(init.body || "{}") });
      const next = queued.shift();
      if (!next) throw new Error("no model reply queued");
      if (next.status && next.status !== 200) {
        return { ok: false, status: next.status, async json() { return { error: { message: "upstream said no" } }; } };
      }
      return { ok: true, status: 200, async json() { return next.payload; } };
    }
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
  const tasks = createD1CommandTaskRepository({
    accountId: CREDS.CLOUDFLARE_ACCOUNT_ID,
    databaseId: CREDS.HABITAT_D1_DATABASE_ID,
    apiToken: CREDS.HABITAT_D1_API_TOKEN,
    fetchImpl
  });
  const runs = createD1AxRunRepository({
    accountId: CREDS.CLOUDFLARE_ACCOUNT_ID,
    databaseId: CREDS.HABITAT_D1_DATABASE_ID,
    apiToken: CREDS.HABITAT_D1_API_TOKEN,
    fetchImpl
  });
  const execute = async () => {
    const result = await runTick({ env: { ...env }, fetchImpl, log: quiet });
    return { claimed: result.report?.tick?.claimed || 0, ok: result.report?.tick?.ok };
  };
  return { db, fetchImpl, tasks, runs, execute, modelRequests, queued };
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
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

const auth = { authorization: "Bearer " + COMMAND_TOKEN };

function mount({ h, orchestrator = null, provider = null, env = CREDS }) {
  const app = makeApp();
  const commandApi = registerUniversalCommandRoutes(app, {
    env,
    fetchImpl: h.fetchImpl,
    repository: h.tasks,
    orchestratorProvider: provider || (() => orchestrator)
  });
  return { app, commandApi };
}

function buildOrchestrator({ h, commandApi, env = CREDS, overrides = {}, execute = null }) {
  const config = { ...resolveAxOrchestratorConfig(env), ...overrides };
  return createAxOrchestrator({
    engine: commandApi.engine,
    execute: execute || h.execute,
    planner: createOpenAiPlanner({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      fetchImpl: h.fetchImpl,
      prices: config.prices,
      maxSteps: config.maxSteps
    }),
    runs: h.runs,
    adapters: READ_ONLY_ADAPTER_NAMES,
    config,
    log: quiet
  });
}

// ---------------------------------------------------------------- the acceptance sequence

test("AX receives an objective, plans, submits, NEXUS executes, AX verifies and reports", async () => {
  const h = harness({ replies: [{ payload: planPayload([{ objective: "report runtime health", adapter: "runtime.health" }]) }] });
  const orchestrator = buildOrchestrator({ h, commandApi: mount({ h }).commandApi });
  // Re-mount with the orchestrator now that it exists.
  const { app } = mount({ h, orchestrator });

  const res = await invoke(app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "verify the runtime is healthy" }
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const run = res.body.run;
  assert.equal(res.body.ok, true);
  assert.equal(run.status, "completed");
  assert.equal(run.verified, true);

  // 1. AX received the objective and created a plan.
  assert.equal(run.objective, "verify the runtime is healthy");
  assert.equal(run.plan.length, 1);
  assert.equal(run.plan[0].adapter, "runtime.health");

  // 2. AX submitted the task; NEXUS acknowledged it with an id.
  assert.equal(run.steps.length, 1);
  const taskId = run.steps[0].taskId;
  assert.match(taskId, /^cmd_/);

  // 3+4. NEXUS executed it, and AX retrieved the stored result.
  const stored = await h.tasks.get(taskId);
  assert.equal(stored.status, "done");
  assert.equal(stored.requestedBy, "ax");
  assert.equal(stored.role, "ax");
  assert.ok(stored.result.evidence.some(line => line.startsWith("runtime:")), "adapter evidence exists");

  // 5. AX verified the evidence against the worker's own signature.
  assert.equal(run.steps[0].verified, true);
  assert.deepEqual(run.steps[0].evidence, stored.result.evidence);
  assert.equal(run.steps[0].verifyReason, null);
  assert.match(stored.result.verifiedBy, /^nexus-/);

  // 6. AX reported completion with the evidence and the cost it incurred.
  assert.ok(run.evidence.length > 0);
  assert.ok(run.costUsd > 0, "the run reports what the model calls cost");
  assert.deepEqual(run.usage, { input_tokens: 900, output_tokens: 220 });

  // The same run is readable afterwards through the API the owner monitors.
  const fetched = await invoke(app, "GET /ax/command/runs/:id", { headers: auth, params: { id: run.id } });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.body.run.id, run.id);
  assert.equal(fetched.body.run.status, "completed");

  const listed = await invoke(app, "GET /ax/command/runs", { headers: auth });
  assert.equal(listed.body.runs.length, 1);

  // The task is visible on the normal surfaces too, not only inside the run.
  const task = await invoke(app, "GET /ax/command/tasks/:id", { headers: auth, params: { id: taskId } });
  assert.equal(task.body.task.status, "done");
  const feed = await invoke(app, "GET /ax/command/events", { headers: auth, query: { since: "1970-01-01T00:00:00.000Z" } });
  assert.ok(feed.body.events.some(event => event.taskId === taskId && event.type === "task.completed"));
});

test("the plan request uses the mock credential and no record ever contains it", async () => {
  const h = harness({ replies: [{ payload: planPayload([{ objective: "report runtime health", adapter: "runtime.health" }]) }] });
  const { app, commandApi } = mount({ h, orchestrator: null });
  const orchestrator = buildOrchestrator({ h, commandApi });
  const mounted = mount({ h, orchestrator });

  const res = await invoke(mounted.app, "POST /ax/command/runs", { headers: auth, body: { objective: "check health" } });
  assert.equal(res.statusCode, 201);

  const request = h.modelRequests[0];
  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer " + OPENAI_KEY);
  assert.equal(request.body.model, "gpt-6-luna");
  assert.equal(request.body.response_format.type, "json_schema");

  const runText = JSON.stringify(res.body);
  const task = await h.tasks.get(res.body.run.steps[0].taskId);
  assert.equal(runText.includes(OPENAI_KEY), false, "the API key is not in the response");
  assert.equal(JSON.stringify(task).includes(OPENAI_KEY), false, "the API key is not in a task record");
  const stored = await h.runs.get(res.body.run.id);
  assert.equal(JSON.stringify(stored).includes(OPENAI_KEY), false, "the API key is not in the run record");
});

// ---------------------------------------------------------------- failure and repair

test("a failed step is repaired once through the planner and then verified", async () => {
  const h = harness({
    replies: [
      { payload: planPayload([{ objective: "report runtime health", adapter: "runtime.health" }]) },
      { payload: planPayload([{ objective: "report runtime health again", adapter: "runtime.health" }]) }
    ]
  });
  const base = mount({ h });
  await h.tasks.initialize();
  const d1Query = createD1Query({
    accountId: CREDS.CLOUDFLARE_ACCOUNT_ID,
    databaseId: CREDS.HABITAT_D1_DATABASE_ID,
    apiToken: CREDS.HABITAT_D1_API_TOKEN,
    fetchImpl: h.fetchImpl
  });
  await d1Query(NEXUS_HEARTBEAT_TABLE_SQL);

  // A real worker whose single read-only adapter fails exactly once. The failure and the retry are
  // produced by the production execution path; only the adapter's verdict is scripted.
  let calls = 0;
  const worker = createNexusWorker({
    repository: h.tasks,
    engine: base.commandApi.engine,
    query: d1Query,
    maxAttempts: 1,
    log: quiet,
    adapters: {
      "runtime.health": async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, error: "synthetic adapter failure" }
          : { ok: true, summary: "runtime healthy", evidence: ["runtime: ok@test"] };
      }
    }
  });

  const orchestrator = buildOrchestrator({ h, commandApi: base.commandApi, execute: () => worker.tick() });
  const { app } = mount({ h, orchestrator });

  const res = await invoke(app, "POST /ax/command/runs", { headers: auth, body: { objective: "inspect the runtime" } });
  const run = res.body.run;

  assert.equal(run.status, "completed", JSON.stringify({ status: run.status, error: run.error }));
  assert.equal(run.corrections, 1);
  assert.equal(run.steps.length, 2);

  const failed = run.steps[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.verified, false);
  assert.ok(failed.correctedBy, "the failure names the corrective task");

  const repaired = run.steps[1];
  assert.equal(repaired.corrective, true);
  assert.equal(repaired.verified, true);
  assert.equal(run.steps.find(step => step.taskId === failed.correctedBy).status, "done");

  assert.equal(h.modelRequests.length, 2, "exactly one repair call was made");
});

test("a plan that names an adapter the worker does not have is refused before anything is queued", async () => {
  const h = harness({ replies: [{ payload: planPayload([{ objective: "delete the database", adapter: "repo.destroy" }]) }] });
  const { app, commandApi } = mount({ h });
  const orchestrator = buildOrchestrator({ h, commandApi });
  const mounted = mount({ h, orchestrator });

  const res = await invoke(mounted.app, "POST /ax/command/runs", { headers: auth, body: { objective: "do something unsafe" } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "plan_invalid");
  assert.equal(res.body.run.status, "error");
  assert.match(res.body.run.error, /not registered/);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0, "no task was created");
});

test("a run that would exceed its budget stops before another plan call", async () => {
  const h = harness({ replies: [{ payload: planPayload([{ objective: "report runtime health", adapter: "runtime.health" }]) }] });
  const { commandApi } = mount({ h });
  const orchestrator = buildOrchestrator({ h, commandApi, overrides: { budgetUsd: 0.000001 } });
  const { app } = mount({ h, orchestrator });

  const res = await invoke(app, "POST /ax/command/runs", { headers: auth, body: { objective: "expensive" } });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "budget_exceeded");
  assert.equal(res.body.run.status, "budget_exceeded");
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0);
});

test("a plan step that needs the owner is reported, never submitted and never approved", async () => {
  const h = harness({
    replies: [{ payload: planPayload([{ objective: "publish the release", adapter: "runtime.health", needsApproval: true }]) }]
  });
  const { app, commandApi } = mount({ h });
  const orchestrator = buildOrchestrator({ h, commandApi });
  const mounted = mount({ h, orchestrator });

  const res = await invoke(mounted.app, "POST /ax/command/runs", { headers: auth, body: { objective: "publish" } });
  const run = res.body.run;
  assert.equal(run.status, "needs_approval");
  assert.equal(run.steps[0].taskId, null);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0, "nothing was queued behind the owner's back");
});

test("a model transport failure is reported without leaking the credential", async () => {
  const h = harness({ replies: [{ status: 500 }] });
  const { app, commandApi } = mount({ h });
  const orchestrator = buildOrchestrator({ h, commandApi });
  const mounted = mount({ h, orchestrator });

  const res = await invoke(mounted.app, "POST /ax/command/runs", { headers: auth, body: { objective: "anything" } });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "plan_failed");
  assert.equal(res.body.run.status, "error");
  assert.match(res.body.run.error, /openai_http_500/);
  assert.equal(JSON.stringify(res.body).includes(OPENAI_KEY), false);
});

test("redact removes credential shapes from a message", () => {
  const message = `call failed: Authorization: Bearer ${OPENAI_KEY} and key ${OPENAI_KEY}`;
  const safe = redact(message);
  assert.equal(safe.includes(OPENAI_KEY), false);
  assert.match(safe, /\[redacted\]/);
});

// ---------------------------------------------------------------- availability

test("the run routes answer 503 when the agent is disabled or unconfigured", async () => {
  const h = harness();
  const disabled = mount({
    h,
    provider: () => ({ enabled: false, code: "orchestrator_disabled", error: "Habitat-native Ax is disabled." })
  });
  const res = await invoke(disabled.app, "POST /ax/command/runs", { headers: auth, body: { objective: "x" } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "orchestrator_disabled");
  assert.equal(res.body.schemaVersion, 1);

  const noKey = resolveAxOrchestratorConfig({ AX_ORCHESTRATOR_ENABLED: "true" });
  assert.equal(noKey.enabled, false);
  assert.equal(noKey.code, "openai_unconfigured");

  const noFlag = resolveAxOrchestratorConfig({ OPENAI_API_KEY: OPENAI_KEY });
  assert.equal(noFlag.enabled, false);
  assert.equal(noFlag.code, "orchestrator_disabled");

  const missing = await invoke(disabled.app, "GET /ax/command/runs/:id", { headers: auth, params: { id: "nope" } });
  assert.equal(missing.statusCode, 503, "a disabled agent cannot be probed for runs");
});

test("an objective is required before any model call", async () => {
  const h = harness();
  const { app, commandApi } = mount({ h });
  const orchestrator = buildOrchestrator({ h, commandApi });
  const mounted = mount({ h, orchestrator });

  const res = await invoke(mounted.app, "POST /ax/command/runs", { headers: auth, body: { objective: "   " } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_objective");
  assert.equal(h.modelRequests.length, 0);
});

// ---------------------------------------------------------------- verification semantics

test("verifyResult never trusts a done task without worker evidence", () => {
  assert.deepEqual(verifyResult(null), { verified: false, reason: "not_done" });
  assert.equal(verifyResult({ status: "working" }).verified, false);
  assert.equal(verifyResult({ status: "done", result: { evidence: [], verifiedBy: "nexus-1" } }).reason, "no_evidence");
  assert.equal(verifyResult({ status: "done", result: { evidence: ["x"], verifiedBy: "ax" } }).reason, "not_executed_by_nexus");
  assert.equal(verifyResult({ status: "done", result: { evidence: ["runtime: ok"], verifiedBy: "nexus-1" } }).verified, true);
  assert.equal(verifyResult({ status: "needs_approval" }).reason, "needs_approval");
});
