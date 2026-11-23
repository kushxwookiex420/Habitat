import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";
import { createD1AxRunRepository } from "../d1-ax-run-repository.mjs";
import { createD1Query, createNexusWorker, NEXUS_HEARTBEAT_TABLE_SQL } from "../nexus-runtime.mjs";
import { evidenceDigest, taskIdForKey } from "../universal-command-engine.mjs";
import { READ_ONLY_ADAPTER_NAMES } from "../nexus-adapter-registration.mjs";
import {
  createAxOrchestrator,
  createOpenAiPlanner,
  resolveAxOrchestratorConfig,
  verifyResult,
  redact,
  DEFAULT_PRICES
} from "../ax-orchestrator.mjs";
import { runTick } from "../scripts/nexus-tick.mjs";

/**
 * Adversarial lifecycle tests for the Habitat-native Ax orchestrator.
 *
 * Real routes, real engine, real worker, real SQLite behind the D1 HTTP shape. The model transport
 * is scripted; every other step is production code. Nothing here contacts OpenAI or a deployment.
 */

const TOKEN = "ax_command_" + "c".repeat(28);
const KEY = "sk-mock-" + "0".repeat(32);
const quiet = { log() {}, warn() {}, error() {} };

const CREDS = {
  CLOUDFLARE_ACCOUNT_ID: "acct-life",
  HABITAT_D1_DATABASE_ID: "db-life-0001",
  HABITAT_D1_API_TOKEN: "d1_token_life_" + "x".repeat(20),
  NEXUS_RUNTIME_ENABLED: "true"
};

function env(overrides = {}) {
  return {
    ...CREDS,
    HABITAT_AX_COMMAND_TOKEN: TOKEN,
    OPENAI_API_KEY: KEY,
    AX_ORCHESTRATOR_ENABLED: "true",
    AX_MODEL: "gpt-6-luna",
    AX_RUN_DEADLINE_MS: "5000",
    AX_POLL_MS: "20",
    AX_RECONCILE_AFTER_MS: "0",
    AX_RUN_BUDGET_USD: "0.05",
    ...overrides
  };
}

const auth = { authorization: "Bearer " + TOKEN };
const planReply = (steps, usage = { prompt_tokens: 900, completion_tokens: 220 }) => ({
  choices: [{ message: { content: JSON.stringify({ steps }) } }],
  usage
});

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

async function setup({ replies = [], envOverrides = {}, failRunWrites = false } = {}) {
  const cfg = env(envOverrides);
  const db = new DatabaseSync(":memory:");
  const modelRequests = [];
  const queued = [...replies];
  let failing = failRunWrites;
  let failingReads = false;

  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/chat/completions")) {
      modelRequests.push({ url: target, headers: init.headers || {}, body: JSON.parse(init.body || "{}") });
      const next = queued.shift();
      if (!next) throw new Error("no model reply queued");
      if (next.status && next.status !== 200) {
        return { ok: false, status: next.status, async json() { return { error: { message: "upstream said no: " + KEY } }; } };
      }
      const payload = next.payload ?? next;
      return { ok: true, status: 200, async json() { return payload; } };
    }
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    if (failing && /^\s*(INSERT INTO habitat_ax_runs|UPDATE habitat_ax_runs)/i.test(sql)) {
      throw new Error("synthetic D1 write failure");
    }
    if (failingReads && /FROM habitat_command_tasks/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      throw new Error("synthetic D1 read failure");
    }
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

  await tasks.initialize();
  await runs.initialize();

  const app = makeApp();
  const state = { orchestrator: null };
  const commandApi = registerUniversalCommandRoutes(app, {
    env: cfg,
    fetchImpl,
    repository: tasks,
    orchestratorProvider: () => state.orchestrator
  });

  const makeOrchestrator = ({ execute = null, overrides = {}, planner = null } = {}) => {
    const config = { ...resolveAxOrchestratorConfig(cfg), ...overrides };
    state.orchestrator = createAxOrchestrator({
      engine: commandApi.engine,
      execute,
      planner: planner || createOpenAiPlanner({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        fetchImpl,
        prices: config.prices,
        maxSteps: config.maxSteps,
        maxOutputTokens: config.maxOutputTokens,
        reasoningEffort: config.reasoningEffort,
        failedCallCostUsd: config.failedCallCostUsd
      }),
      runs,
      adapters: READ_ONLY_ADAPTER_NAMES,
      config,
      log: quiet
    });
    return state.orchestrator;
  };

  return {
    db,
    cfg,
    fetchImpl,
    tasks,
    runs,
    app,
    commandApi,
    makeOrchestrator,
    modelRequests,
    state,
    setFailRunWrites(value) { failing = Boolean(value); },
    setFailTaskReads(value) { failingReads = Boolean(value); }
  };
}

const tickOnce = h => runTick({ env: h.cfg, fetchImpl: h.fetchImpl, log: quiet });
const tickExecute = h => async () => {
  const result = await tickOnce(h);
  return { claimed: result.report?.tick?.claimed || 0 };
};
const runIdFor = key => "run_" + createHash("sha256").update("run:" + key, "utf8").digest("hex").slice(0, 20);

async function failingWorker(h, { failTimes = 1 } = {}) {
  await h.tasks.initialize();
  const query = createD1Query({
    accountId: CREDS.CLOUDFLARE_ACCOUNT_ID,
    databaseId: CREDS.HABITAT_D1_DATABASE_ID,
    apiToken: CREDS.HABITAT_D1_API_TOKEN,
    fetchImpl: h.fetchImpl
  });
  await query(NEXUS_HEARTBEAT_TABLE_SQL);
  let calls = 0;
  const worker = createNexusWorker({
    repository: h.tasks,
    engine: h.commandApi.engine,
    query,
    maxAttempts: 1,
    log: quiet,
    adapters: {
      "runtime.health": async () => {
        calls += 1;
        return calls <= failTimes
          ? { ok: false, error: "synthetic adapter failure" }
          : { ok: true, summary: "runtime healthy", evidence: ["runtime: ok@test"] };
      }
    }
  });
  return () => worker.tick();
}

// ------------------------------------------------------------ deadline safety

test("a deadline stops the driver, not the work; the run settles when the task does", async () => {
  const h = await setup({
    replies: [planReply([{ objective: "report runtime health", adapter: "runtime.health" }])],
    envOverrides: { AX_RUN_DEADLINE_MS: "700", AX_POLL_MS: "50" }
  });
  h.makeOrchestrator({ execute: async () => ({ claimed: 0 }) });

  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "health" } });
  const run = res.body.run;
  assert.equal(res.statusCode, 201);
  assert.equal(run.status, "deadline_exceeded");
  assert.equal(run.settled, false, "a deadline is not an outcome");
  assert.equal(run.verified, false);
  assert.match(run.note, /NOT cancelled/);

  const stored = await h.tasks.get(run.steps[0].taskId);
  assert.equal(stored.status, "queued", "the task was left alone, not cancelled");

  const early = await invoke(h.app, "GET /ax/command/runs/:id", { headers: auth, params: { id: run.id } });
  assert.notEqual(early.body.run.status, "completed", "an unfinished task never reads as completed");

  const tick = await tickOnce(h);
  assert.equal(tick.report.tick.completed, 1);

  const later = await invoke(h.app, "GET /ax/command/runs/:id", { headers: auth, params: { id: run.id } });
  assert.equal(later.body.run.status, "completed");
  assert.equal(later.body.run.settled, true);
  assert.equal(later.body.run.verified, true);
  assert.ok(later.body.run.recoveries >= 1, "the convergence is recorded");
  assert.match(later.body.run.recoveredNote, /reconciliation/);
});

test("a run abandoned by a crashed driver converges from its task rows on read", async () => {
  const h = await setup();
  const submitted = await h.commandApi.engine.submit({
    objective: "report runtime health",
    requestedBy: "ax",
    role: "ax",
    adapter: "runtime.health",
    idempotencyKey: "crashed-driver:s0"
  });
  const at = new Date(Date.now() - 60_000).toISOString();
  await h.runs.create({
    schemaVersion: 2,
    id: "run_crashed_driver",
    runKey: "crashed-driver",
    objective: "report runtime health",
    requestedBy: "ax",
    status: "running",
    phase: "driving",
    settled: false,
    deadlineAt: new Date(Date.now() - 30_000).toISOString(),
    plan: [{ objective: "report runtime health", adapter: "runtime.health" }],
    steps: [{
      index: 0,
      taskId: submitted.task.id,
      objective: "report runtime health",
      adapter: "runtime.health",
      status: "queued",
      verified: false,
      evidence: [],
      terminal: false
    }],
    corrections: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    costUsd: 0,
    createdAt: at,
    updatedAt: at
  });
  h.makeOrchestrator({ execute: tickExecute(h) });

  const before = await invoke(h.app, "GET /ax/command/runs/:id", { headers: auth, params: { id: "run_crashed_driver" } });
  assert.equal(before.body.run.status, "deadline_exceeded", "still unsettled, reported honestly");

  await tickOnce(h);
  const after = await invoke(h.app, "GET /ax/command/runs/:id", { headers: auth, params: { id: "run_crashed_driver" } });
  assert.equal(after.body.run.status, "completed");
  assert.equal(after.body.run.verified, true);
  assert.ok(after.body.run.recoveries >= 1);
});

// ------------------------------------------------------------ submission idempotency

test("a crash after submission but before saving the step is recovered by adoption, not duplication", async () => {
  const h = await setup();
  h.makeOrchestrator({ execute: tickExecute(h) });
  const runKey = "crash-after-submit";
  const runId = runIdFor(runKey);

  // The plan was saved, the task was submitted, and the process died before the step id was saved.
  const at = new Date().toISOString();
  await h.runs.create({
    schemaVersion: 2,
    id: runId,
    runKey,
    objective: "report runtime health",
    requestedBy: "ax",
    status: "submitting",
    phase: "submitting",
    settled: false,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    plan: [{ objective: "report runtime health", adapter: "runtime.health", needsApproval: false }],
    steps: [],
    corrections: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    costUsd: 0,
    createdAt: at,
    updatedAt: at
  });
  await h.commandApi.engine.submit({
    objective: "report runtime health",
    requestedBy: "ax",
    role: "ax",
    adapter: "runtime.health",
    idempotencyKey: runId + ":s0"
  });
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1);

  const res = await invoke(h.app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "report runtime health", runKey }
  });
  assert.equal(res.body.run.id, runId);
  assert.equal(res.body.run.steps[0].adopted, true, "the existing task was adopted");
  assert.equal(res.body.run.status, "completed");
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1, "no duplicate task was created");
});

test("retrying a finished run returns it without new work or new model calls", async () => {
  const h = await setup({ replies: [planReply([{ objective: "report runtime health", adapter: "runtime.health" }])] });
  h.makeOrchestrator({ execute: tickExecute(h) });
  const body = { objective: "report runtime health", runKey: "retry-once" };

  const first = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body });
  const second = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body });

  assert.equal(first.body.run.status, "completed");
  assert.equal(second.body.resumed, true);
  assert.equal(second.body.run.id, first.body.run.id);
  assert.equal(second.body.run.status, "completed");
  assert.equal(h.modelRequests.length, 1, "the model was asked once");
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1, "one task for one objective");
});

test("a runKey reused for a different objective is refused instead of returning the wrong result", async () => {
  const h = await setup({ replies: [planReply([{ objective: "report runtime health", adapter: "runtime.health" }])] });
  h.makeOrchestrator({ execute: tickExecute(h) });

  await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "health", runKey: "shared-key" } });
  const clash = await invoke(h.app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "something else entirely", runKey: "shared-key" }
  });
  assert.equal(clash.statusCode, 400);
  assert.equal(clash.body.code, "run_key_reused");
  assert.equal(h.modelRequests.length, 1);
});

// ------------------------------------------------------------ concurrency

test("two concurrent drivers cannot overwrite each other: the stale write is refused", async () => {
  const h = await setup();
  const at = new Date().toISOString();
  const base = {
    schemaVersion: 2,
    id: "run_cas",
    objective: "cas",
    requestedBy: "ax",
    status: "running",
    settled: false,
    plan: [],
    steps: [],
    createdAt: at,
    updatedAt: at
  };
  const created = await h.runs.create(base);
  assert.equal(created.created, true);

  const read = await h.runs.getRecord("run_cas");
  const winner = await h.runs.update({ ...read.run, status: "completed", updatedAt: new Date().toISOString() }, read.recordJson);
  assert.equal(winner.ok, true);

  const loser = await h.runs.update({ ...read.run, status: "failed", updatedAt: new Date().toISOString() }, read.recordJson);
  assert.equal(loser.ok, false);
  assert.equal(loser.reason, "conflict");
  assert.equal((await h.runs.get("run_cas")).status, "completed", "the newer state stands");

  // Two creators with the same id converge on one record.
  const twin = await h.runs.create({ ...base, status: "planning" });
  assert.equal(twin.created, false);
  assert.equal(twin.run.status, "completed");
});

test("a duplicate cron invocation claims and completes a task exactly once", async () => {
  const h = await setup();
  await h.commandApi.engine.submit({
    objective: "report runtime health",
    requestedBy: "ax",
    role: "ax",
    adapter: "runtime.health",
    idempotencyKey: "duplicate-cron-1"
  });

  const [a, b] = await Promise.all([tickOnce(h), tickOnce(h)]);
  const claimed = (a.report.tick.claimed || 0) + (b.report.tick.claimed || 0);
  const completed = (a.report.tick.completed || 0) + (b.report.tick.completed || 0);
  assert.equal(claimed, 1, "only one tick won the claim");
  assert.equal(completed, 1);
  assert.equal((await h.tasks.list({ limit: 5 }))[0].status, "done");
});

test("a late completion cannot overwrite a finished task", async () => {
  const h = await setup();
  const submitted = await h.commandApi.engine.submit({
    objective: "report runtime health",
    requestedBy: "ax",
    role: "ax",
    adapter: "runtime.health",
    idempotencyKey: "late-completion-1"
  });
  await tickOnce(h);
  const done = await h.tasks.get(submitted.task.id);
  assert.equal(done.status, "done");

  const late = await h.commandApi.engine.complete({
    taskId: submitted.task.id,
    result: { summary: "late overwrite", evidence: ["runtime: forged"] },
    verifiedBy: "nexus-late"
  });
  assert.equal(late.ok, false);
  assert.equal(late.code, "invalid_transition");
  assert.deepEqual((await h.tasks.get(submitted.task.id)).result.evidence, done.result.evidence);
});

// ------------------------------------------------------------ evidence

test("forged, stale, mismatched and unattributed evidence is rejected", () => {
  const evidence = ["runtime: ok@test"];
  const valid = {
    id: "cmd_ok",
    status: "done",
    attempts: 2,
    claimedBy: "nexus-abc123",
    statusHistory: [{ to: "working" }, { to: "done", by: "nexus-abc123" }],
    result: { evidence, verifiedBy: "nexus-abc123", attempt: 2, evidenceDigest: evidenceDigest("cmd_ok", 2, evidence) }
  };
  assert.equal(verifyResult(valid, { taskId: "cmd_ok" }).verified, true);
  assert.equal(verifyResult(valid).verified, true);

  // A string that merely starts with "nexus-" proves nothing on its own.
  const noDigest = {
    ...valid,
    claimedBy: "nexus-evil",
    statusHistory: [{ to: "working" }, { to: "done", by: "nexus-evil" }],
    result: { evidence, verifiedBy: "nexus-evil", attempt: 2 }
  };
  assert.equal(verifyResult(noDigest).reason, "evidence_digest_mismatch");

  assert.equal(verifyResult({ ...valid, id: "cmd_other" }, { taskId: "cmd_ok" }).reason, "task_id_mismatch");

  const edited = { ...valid, result: { ...valid.result, evidence: ["runtime: edited"] } };
  assert.equal(verifyResult(edited).reason, "evidence_digest_mismatch");

  const stale = { ...valid, attempts: 3 };
  assert.equal(verifyResult(stale).reason, "stale_attempt");

  const wrongWorker = {
    ...valid,
    claimedBy: "nexus-worker1",
    statusHistory: [{ to: "working" }, { to: "done", by: "nexus-abc123" }]
  };
  assert.equal(verifyResult(wrongWorker).reason, "worker_mismatch");

  const unattributed = {
    ...valid,
    statusHistory: [{ to: "working" }, { to: "done", by: "ax" }]
  };
  assert.equal(verifyResult(unattributed).reason, "unproven_completion");

  const fakeIdentity = { ...valid, result: { ...valid.result, verifiedBy: "nexus-" } };
  assert.equal(verifyResult(fakeIdentity).reason, "invalid_worker_identity");

  const empty = { ...valid, result: { ...valid.result, evidence: [] } };
  assert.equal(verifyResult(empty).reason, "no_evidence");

  assert.equal(verifyResult(null).reason, "missing_task");
  assert.equal(verifyResult({ status: "working" }).reason, "not_done");
  assert.equal(verifyResult({ status: "needs_approval" }).reason, "needs_approval");
});

test("copied evidence from another task does not verify", () => {
  const evidence = ["runtime: ok@task-a"];
  const a = {
    id: "cmd_a",
    status: "done",
    attempts: 1,
    statusHistory: [{ to: "done", by: "nexus-a" }],
    result: { evidence, verifiedBy: "nexus-a", attempt: 1, evidenceDigest: evidenceDigest("cmd_a", 1, evidence) }
  };
  // Same evidence and identity, different task: the digest covers the task id, so it fails.
  const copied = {
    ...a,
    id: "cmd_b",
    result: { ...a.result, evidenceDigest: evidenceDigest("cmd_a", 1, evidence) }
  };
  assert.equal(verifyResult(copied, { taskId: "cmd_b" }).reason, "evidence_digest_mismatch");
});

// ------------------------------------------------------------ storage and model failures

test("a run that cannot be persisted fails loudly and submits nothing", async () => {
  const h = await setup({
    replies: [planReply([{ objective: "report runtime health", adapter: "runtime.health" }])],
    failRunWrites: true
  });
  h.makeOrchestrator({ execute: tickExecute(h) });

  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "health" } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "store_unavailable");
  assert.equal((await h.tasks.list({ limit: 5 })).length, 0, "no task was queued without a durable run");
});

test("a model timeout is charged and recorded as a failure, not a silent success", async () => {
  const hangingFetch = (url, init = {}) => new Promise((resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const planner = createOpenAiPlanner({
    apiKey: KEY,
    model: "gpt-6-luna",
    fetchImpl: hangingFetch,
    timeoutMs: 20,
    prices: DEFAULT_PRICES,
    failedCallCostUsd: 0.01
  });
  const result = await planner.plan({ objective: "anything", adapters: ["runtime.health"] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "openai_timeout");
  assert.equal(result.costUsd, 0.01);
  assert.equal(result.estimated, true);
});

test("an HTTP failure is reported without the credential and still costs budget", async () => {
  const h = await setup({ replies: [{ status: 500 }], envOverrides: { AX_FAILED_CALL_COST_USD: "0.01" } });
  h.makeOrchestrator({ execute: tickExecute(h) });

  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "anything" } });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "plan_failed");
  assert.match(res.body.run.error, /openai_http_500/);
  assert.equal(res.body.run.costUsd, 0.01, "a failed call is not free");
  assert.equal(res.body.run.usageEstimated, true);
  assert.equal(JSON.stringify(res.body).includes(KEY), false);
});

test("a failed call that overspends the budget is reported as budget_exceeded", async () => {
  const h = await setup({
    replies: [{ status: 500 }],
    envOverrides: { AX_FAILED_CALL_COST_USD: "0.01", AX_RUN_BUDGET_USD: "0.005" }
  });
  h.makeOrchestrator({ execute: tickExecute(h) });
  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "anything" } });
  assert.equal(res.body.run.status, "budget_exceeded");
  assert.ok(res.body.run.costUsd > 0.005);
});

test("a missing usage block is priced with the configured estimate and flagged", async () => {
  const reply = { choices: [{ message: { content: JSON.stringify({ steps: [{ objective: "report runtime health", adapter: "runtime.health" }] }) } }] };
  const h = await setup({ replies: [{ payload: reply }], envOverrides: { AX_FAILED_CALL_COST_USD: "0.004" } });
  h.makeOrchestrator({ execute: tickExecute(h) });

  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "health" } });
  assert.equal(res.body.run.status, "completed");
  assert.equal(res.body.run.usageEstimated, true);
  assert.equal(res.body.run.costUsd, 0.004);
  assert.deepEqual(res.body.run.usage, { input_tokens: 0, output_tokens: 0 });
});

test("redact strips credentials from any message", () => {
  const safe = redact(`failed with Authorization: Bearer ${KEY} / ${KEY}`);
  assert.equal(safe.includes(KEY), false);
  assert.match(safe, /\[redacted\]/);
});

// ------------------------------------------------------------ correction and budget

test("a failed step is repaired once and the run completes with the failure still visible", async () => {
  const h = await setup({
    replies: [
      planReply([{ objective: "report runtime health", adapter: "runtime.health" }]),
      planReply([{ objective: "report runtime health again", adapter: "runtime.health" }])
    ]
  });
  const execute = await failingWorker(h, { failTimes: 1 });
  h.makeOrchestrator({ execute });

  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "inspect the runtime" } });
  const run = res.body.run;
  assert.equal(run.status, "completed", JSON.stringify({ status: run.status, error: run.error }));
  assert.equal(run.corrections, 1);
  assert.equal(run.steps[0].status, "failed");
  assert.equal(run.steps[0].verified, false);
  assert.ok(run.steps[0].correctedBy);
  assert.equal(run.steps[1].corrective, true);
  assert.equal(run.steps[1].verified, true);
  assert.equal(h.modelRequests.length, 2);
});

test("a corrective call that would overspend the budget is recorded and no task is submitted", async () => {
  const h = await setup({
    replies: [
      planReply([{ objective: "report runtime health", adapter: "runtime.health" }]),
      planReply([{ objective: "report runtime health again", adapter: "runtime.health" }])
    ],
    // Plan costs $0.0002; $0.0003 leaves room to start the correction but not to finish it.
    envOverrides: { AX_RUN_BUDGET_USD: "0.0003" }
  });
  const execute = await failingWorker(h, { failTimes: 1 });
  h.makeOrchestrator({ execute });

  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "inspect the runtime" } });
  const run = res.body.run;
  assert.equal(run.status, "budget_exceeded");
  assert.equal(run.corrections, 1);
  assert.equal(run.steps.length, 1, "the corrective task was never submitted");
  assert.ok(run.costUsd > 0.0003);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1);
});

test("a correctable failure is not repaired when the budget is already spent", async () => {
  const h = await setup({
    replies: [planReply([{ objective: "report runtime health", adapter: "runtime.health" }])],
    envOverrides: { AX_RUN_BUDGET_USD: "0.0001" }
  });
  const execute = await failingWorker(h, { failTimes: 1 });
  h.makeOrchestrator({ execute });

  const res = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective: "inspect" } });
  assert.equal(res.body.run.status, "budget_exceeded");
  assert.equal(res.body.run.corrections, 0);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0, "planning alone overran the budget, so nothing ran");
});

// ------------------------------------------------ missing-submission recovery (Mission 06)

/**
 * A run record that looks exactly like one written by a process that died after persisting a step
 * and before submitting its task: the step has its deterministic id, the task does not exist.
 */
function runRecord({ runKey, steps, objective = "report runtime health", corrections = 0, deadlineMs = 10_000, plan = null }) {
  const id = runIdFor(runKey);
  const at = new Date().toISOString();
  return {
    schemaVersion: 2,
    id,
    runKey,
    objective,
    requestedBy: "ax",
    status: "submitting",
    phase: "submitting",
    code: null,
    settled: false,
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
    plan: plan || [{ objective, adapter: "runtime.health", needsApproval: false }],
    steps,
    corrections,
    usage: { input_tokens: 0, output_tokens: 0 },
    usageEstimated: false,
    costUsd: 0,
    recoveries: 0,
    createdAt: at,
    updatedAt: at
  };
}

function persistedStep(runKey, index = 0, extra = {}) {
  const key = runIdFor(runKey) + ":s" + index;
  return {
    index,
    taskId: taskIdForKey(key),
    key,
    objective: "report runtime health",
    adapter: "runtime.health",
    needsApproval: false,
    corrective: false,
    status: "submitting",
    verified: false,
    verifyReason: null,
    evidence: [],
    error: null,
    terminal: false,
    ...extra
  };
}

const resume = (h, runKey, objective = "report runtime health") =>
  invoke(h.app, "POST /ax/command/runs", { headers: auth, body: { objective, runKey } });

test("a step persisted before its task was submitted is recovered, not skipped", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "1200", AX_POLL_MS: "40" } });
  const runKey = "missing-submission";
  const record = runRecord({ runKey, steps: [persistedStep(runKey)] });
  await h.runs.create(record);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0, "the crash left no command task behind");

  h.makeOrchestrator({ execute: tickExecute(h) });
  const res = await resume(h, runKey);

  assert.equal(res.statusCode, 201);
  const run = res.body.run;
  const tasks = await h.tasks.list({ limit: 50 });
  assert.equal(tasks.length, 1, "exactly one task was submitted for the persisted step");
  assert.equal(tasks[0].id, record.steps[0].taskId, "it used the persisted id, not a freshly minted one");
  assert.equal(tasks[0].status, "done");
  assert.equal(run.steps[0].taskId, record.steps[0].taskId);
  assert.equal(run.steps[0].key, record.steps[0].key);
  assert.equal(run.steps[0].adopted, false, "there was nothing to adopt: this was a submission");
  assert.equal(run.status, "completed", JSON.stringify({ status: run.status, steps: run.steps }));
  assert.equal(run.verified, true);
});

test("a task submitted before the run was updated is adopted, and the id is unchanged", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "1200", AX_POLL_MS: "40" } });
  const runKey = "lost-run-update";
  const step = persistedStep(runKey);
  const submitted = await h.commandApi.engine.submit({
    objective: step.objective,
    requestedBy: "ax",
    role: "ax",
    adapter: step.adapter,
    idempotencyKey: step.key
  });
  assert.equal(submitted.task.id, step.taskId);

  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: tickExecute(h) });
  const res = await resume(h, runKey);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.run.steps[0].adopted, true);
  assert.equal(res.body.run.steps[0].taskId, step.taskId);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1, "no second task was created");
  assert.equal(res.body.run.status, "completed");
});

test("two simultaneous recoveries of the same missing submission create one task", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "1200", AX_POLL_MS: "40" } });
  const runKey = "concurrent-recovery";
  const step = persistedStep(runKey);
  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: tickExecute(h) });

  const [a, b] = await Promise.all([resume(h, runKey), resume(h, runKey)]);
  const tasks = await h.tasks.list({ limit: 50 });
  assert.equal(tasks.length, 1, "the idempotency key held under two drivers");
  assert.equal(tasks[0].id, step.taskId);
  for (const res of [a, b]) {
    assert.ok([201, 409].includes(res.statusCode), "both attempts answer with a run or a conflict: " + res.statusCode);
    assert.ok(res.body.run, "a conflict still returns the winning run");
  }
});

test("a failed task lookup does not trigger a second submission", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "600", AX_POLL_MS: "40" } });
  const runKey = "unreadable-lookup";
  const step = persistedStep(runKey);
  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: async () => ({ claimed: 0 }) });

  h.setFailTaskReads(true);
  const blind = await resume(h, runKey);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0, "an unreadable lookup must not be read as \"missing\"");
  assert.equal(blind.body.run.settled, false);
  assert.equal(blind.body.run.steps[0].readError, "task_unreadable");
  assert.notEqual(blind.body.run.status, "completed");

  h.setFailTaskReads(false);
  const healed = await resume(h, runKey);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1, "the retry submitted the missing task once");
  assert.equal(healed.body.run.steps[0].taskId, step.taskId);
  assert.equal(healed.body.run.steps[0].readError, undefined);
});

test("an already completed task is adopted and its evidence verified", async () => {
  const h = await setup();
  const runKey = "adopt-completed";
  const step = persistedStep(runKey);
  const submitted = await h.commandApi.engine.submit({
    objective: step.objective, requestedBy: "ax", role: "ax", adapter: step.adapter, idempotencyKey: step.key
  });
  assert.equal((await tickOnce(h)).report.tick.completed, 1);
  const finished = await h.tasks.get(submitted.task.id);
  assert.equal(finished.status, "done");

  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: async () => ({ claimed: 0 }) });
  const res = await resume(h, runKey);

  assert.equal(res.body.run.steps[0].adopted, true);
  assert.equal(res.body.run.steps[0].verified, true);
  assert.equal(res.body.run.status, "completed");
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1);
});

test("a running task is adopted rather than resubmitted, and settles later", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "600", AX_POLL_MS: "40" } });
  const runKey = "adopt-running";
  const step = persistedStep(runKey);
  await h.commandApi.engine.submit({
    objective: step.objective, requestedBy: "ax", role: "ax", adapter: step.adapter, idempotencyKey: step.key
  });
  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: async () => ({ claimed: 0 }) });

  const res = await resume(h, runKey);
  assert.equal(res.body.run.steps[0].adopted, true);
  assert.equal(res.body.run.steps[0].status, "queued");
  assert.equal(res.body.run.settled, false, "a queued task is not an outcome");
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1);

  await tickOnce(h);
  const later = await invoke(h.app, "GET /ax/command/runs/:id", { headers: auth, params: { id: runIdFor(runKey) } });
  assert.equal(later.body.run.status, "completed");
});

test("a persisted approval step is never submitted behind the owner's back", async () => {
  const h = await setup();
  const runKey = "approval-gap";
  const step = persistedStep(runKey, 0, {
    taskId: null,
    key: null,
    needsApproval: true,
    status: "needs_approval",
    verifyReason: "needs_approval"
  });
  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: tickExecute(h) });

  const res = await resume(h, runKey);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.run.status, "needs_approval");
  assert.equal(res.body.run.steps[0].taskId, null);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0, "nothing was queued");
});

test("recovery of a terminal failure preserves it instead of resubmitting", async () => {
  const h = await setup();
  const runKey = "terminal-failure";
  const step = persistedStep(runKey);
  const submitted = await h.commandApi.engine.submit({
    objective: step.objective, requestedBy: "ax", role: "ax", adapter: step.adapter, idempotencyKey: step.key
  });
  const worker = await failingWorker(h, { failTimes: 1 });
  await worker();
  assert.equal((await h.tasks.get(submitted.task.id)).status, "failed");

  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: tickExecute(h), overrides: { maxCorrections: 0 } });
  const res = await resume(h, runKey);

  assert.equal(res.body.run.status, "failed");
  assert.equal(res.body.run.settled, true);
  assert.equal(res.body.run.verified, false);
  assert.equal(res.body.run.steps[0].status, "failed");
  assert.match(res.body.run.error, /unverified/);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1, "the failed task was not replaced");
});

test("repeated recoveries keep one task id and never create a second task", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "500", AX_POLL_MS: "40" } });
  const runKey = "repeat-recovery";
  const step = persistedStep(runKey);
  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: async () => ({ claimed: 0 }) });

  const first = await resume(h, runKey);
  const second = await resume(h, runKey);
  const tasks = await h.tasks.list({ limit: 50 });
  assert.equal(tasks.length, 1);
  assert.equal(first.body.run.steps[0].taskId, step.taskId);
  assert.equal(second.body.run.steps[0].taskId, step.taskId);
});

test("a lost run write reports 503 and the submitted task is adopted, not duplicated", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "1200", AX_POLL_MS: "40" } });
  const runKey = "lost-write";
  const step = persistedStep(runKey);
  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: tickExecute(h) });

  h.setFailRunWrites(true);
  const broken = await resume(h, runKey);
  assert.equal(broken.statusCode, 503);
  assert.equal(broken.body.code, "store_unavailable");
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1, "the task exists even though the run write failed");

  h.setFailRunWrites(false);
  const healed = await resume(h, runKey);
  assert.equal(healed.body.run.steps[0].adopted, true);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 1, "recovery adopted instead of submitting again");
  assert.equal(healed.body.run.status, "completed");
});

test("an orphaned corrective step is recovered by its own key, not replaced", async () => {
  const h = await setup({ envOverrides: { AX_RUN_DEADLINE_MS: "1200", AX_POLL_MS: "40" } });
  const runKey = "corrective-gap";
  const step = persistedStep(runKey);
  const submitted = await h.commandApi.engine.submit({
    objective: step.objective, requestedBy: "ax", role: "ax", adapter: step.adapter, idempotencyKey: step.key
  });
  const worker = await failingWorker(h, { failTimes: 1 });
  await worker();
  assert.equal((await h.tasks.get(submitted.task.id)).status, "failed");

  const runId = runIdFor(runKey);
  const correctiveKey = runId + ":c1";
  const correctiveId = taskIdForKey(correctiveKey);
  const failedStep = {
    ...step,
    status: "failed",
    terminal: true,
    verifyReason: "failed",
    error: "synthetic adapter failure",
    correctedBy: correctiveId
  };
  const correctiveStep = {
    index: 1,
    taskId: correctiveId,
    key: correctiveKey,
    objective: "report runtime health",
    adapter: "runtime.health",
    needsApproval: false,
    corrective: true,
    status: "submitting",
    verified: false,
    verifyReason: null,
    evidence: [],
    error: null,
    terminal: false
  };
  await h.runs.create(runRecord({ runKey, steps: [failedStep, correctiveStep], corrections: 1 }));
  h.makeOrchestrator({ execute: tickExecute(h), overrides: { maxCorrections: 2 } });

  const res = await resume(h, runKey);
  const tasks = await h.tasks.list({ limit: 50 });
  assert.equal(tasks.length, 2, "the corrective task was submitted once, not replaced");
  assert.equal(tasks.some(task => task.id === correctiveId), true);
  assert.equal(res.body.run.corrections, 1, "recovery did not count a new correction");
  assert.equal(res.body.run.status, "completed", JSON.stringify({ status: res.body.run.status, steps: res.body.run.steps }));
  assert.equal(res.body.run.steps[1].taskId, correctiveId);
});

test("a persisted step whose id disagrees with its key is refused, not resubmitted", async () => {
  const h = await setup();
  const runKey = "corrupt-step";
  const step = persistedStep(runKey, 0, { taskId: taskIdForKey("some-other-key") });
  await h.runs.create(runRecord({ runKey, steps: [step] }));
  h.makeOrchestrator({ execute: tickExecute(h), overrides: { maxCorrections: 0 } });

  const res = await resume(h, runKey);
  assert.equal((await h.tasks.list({ limit: 50 })).length, 0, "no task was created under a mismatched id");
  assert.equal(res.body.run.status, "failed");
  assert.match(res.body.run.error, /task_id_mismatch/);
});
