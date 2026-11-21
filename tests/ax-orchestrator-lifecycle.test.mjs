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

  return { db, cfg, fetchImpl, tasks, runs, app, commandApi, makeOrchestrator, modelRequests, state };
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
