import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";
import { createD1AxRunRepository } from "../d1-ax-run-repository.mjs";
import { createD1AxMemoryRepository } from "../d1-ax-memory-repository.mjs";
import { createD1AxNotificationRepository } from "../d1-ax-notification-repository.mjs";
import { createNotificationService } from "../ax-notifications.mjs";
import { createAxMemoryContext } from "../ax-memory-context.mjs";
import { createAxOrchestrator, resolveAxOrchestratorConfig } from "../ax-orchestrator.mjs";
import {
  createAxPlannerFromProviderConfig,
  describeProviderStatus,
  resolveAxProviderConfig
} from "../ax-providers.mjs";
import { createAxDiagnostics } from "../ax-diagnostics.mjs";
import { READ_ONLY_ADAPTER_NAMES } from "../nexus-adapter-registration.mjs";
import { runTick } from "../scripts/nexus-tick.mjs";

/**
 * Mission 09 end-to-end.
 *
 * Real: HTTP routes, orchestrator, provider failover, command engine, D1-shaped task rows, the
 * NEXUS tick, adapters, evidence verification, memory repository, notification store and mission
 * history. Only the model transport is mocked — the provider accounts are fake, and this suite
 * therefore proves the integration, not a live OpenAI/Gemini subscription.
 */

const COMMAND_TOKEN = "ax_command_" + "c".repeat(28);
const BRIDGE_TOKEN = "ax_bridge_" + "b".repeat(28);
const OPENAI_KEY = "sk-mock-" + "0".repeat(32);
const GEMINI_KEY = "gm-mock-" + "1".repeat(32);
const OWNER_DEVICE = "owner-device-1";
const OWNER_TOKEN = "owner-device-token-" + "t".repeat(12);

const quiet = { log() {}, warn() {}, error() {} };

function baseEnv(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: "acct-m9",
    HABITAT_D1_DATABASE_ID: "db-m9-0001",
    HABITAT_D1_API_TOKEN: "d1_token_m9_" + "x".repeat(20),
    NEXUS_RUNTIME_ENABLED: "true",
    HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN,
    HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN,
    HABITAT_OWNER_DEVICE_IDS: OWNER_DEVICE,
    OPENAI_API_KEY: OPENAI_KEY,
    GEMINI_API_KEY: GEMINI_KEY,
    AX_PROVIDER: "openai",
    AX_PROVIDER_FALLBACKS: "gemini",
    AX_ORCHESTRATOR_ENABLED: "true",
    AX_RUN_DEADLINE_MS: "8000",
    AX_POLL_MS: "10",
    AX_MAX_STEPS: "4",
    AX_MAX_CORRECTIONS: "1",
    AX_RUN_BUDGET_USD: "0.05",
    AX_FAILED_CALL_COST_USD: "0.005",
    AX_RECONCILE_AFTER_MS: "0",
    HABITAT_AX_MEMORY_PROJECT: "habitat",
    ...overrides
  };
}

function planPayload(steps, { prompt = 900, completion = 200 } = {}) {
  return {
    choices: [{ message: { content: JSON.stringify({ steps }) } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion }
  };
}

function d1Fetch({ db, plan, openaiStatus = 200, modelRequests = [] } = {}) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/chat/completions")) {
      modelRequests.push({ target, headers: init.headers || {}, body: JSON.parse(init.body || "{}") });
      const isOpenAi = target.includes("api.openai.com");
      if (isOpenAi && openaiStatus !== 200) {
        return {
          ok: false,
          status: openaiStatus,
          async json() { return { error: { message: "primary provider is down" } }; }
        };
      }
      return { ok: true, status: 200, async json() { return planPayload(plan); } };
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
const ownerAuth = {
  authorization: "Bearer " + COMMAND_TOKEN,
  "x-owner-device-id": OWNER_DEVICE,
  "x-owner-device-token": OWNER_TOKEN
};
// The device-capable bridge credential plus real device proof: the only combination that may act
// as the owner.
const ownerBridgeAuth = { ...ownerAuth, authorization: "Bearer " + BRIDGE_TOKEN };

function harness({ env: envOverrides = {}, plan, openaiStatus = 200, execute = true, memoryOverride = null } = {}) {
  const env = baseEnv(envOverrides);
  const db = new DatabaseSync(":memory:");
  const modelRequests = [];
  const fetchImpl = d1Fetch({ db, plan, openaiStatus, modelRequests });
  const d1 = { accountId: env.CLOUDFLARE_ACCOUNT_ID, databaseId: env.HABITAT_D1_DATABASE_ID, apiToken: env.HABITAT_D1_API_TOKEN, fetchImpl };
  const tasks = createD1CommandTaskRepository(d1);
  const runs = createD1AxRunRepository(d1);
  const memoryRepository = createD1AxMemoryRepository(d1);
  const notificationRepository = createD1AxNotificationRepository(d1);
  const notifications = createNotificationService({ repository: notificationRepository, project: "habitat", log: quiet });
  const memory = memoryOverride || createAxMemoryContext({ repository: memoryRepository, project: "habitat", log: quiet, now: () => "2026-11-22T12:00:00.000Z" });
  const providerConfig = resolveAxProviderConfig(env);
  const config = resolveAxOrchestratorConfig(env);

  const tick = async () => {
    const result = await runTick({ env: { ...env }, fetchImpl, log: quiet });
    return { claimed: result.report?.tick?.claimed || 0, ok: result.report?.tick?.ok };
  };

  function makeOrchestrator({ withExecutor = execute } = {}) {
    return createAxOrchestrator({
      engine: commandApi.engine,
      execute: withExecutor ? tick : null,
      planner: createAxPlannerFromProviderConfig(providerConfig, {
        fetchImpl,
        prices: config.prices,
        maxSteps: config.maxSteps,
        maxOutputTokens: config.maxOutputTokens,
        reasoningEffort: config.reasoningEffort,
        failedCallCostUsd: config.failedCallCostUsd
      }),
      runs,
      memory,
      notify: event => notifications.record(event),
      adapters: READ_ONLY_ADAPTER_NAMES,
      config: {
        ...config,
        enabled: providerConfig.enabled,
        code: providerConfig.code,
        model: providerConfig.primary?.model || config.model,
        baseUrl: providerConfig.primary?.baseUrl || config.baseUrl
      },
      log: quiet
    });
  }

  const ref = { current: null };
  const app = makeApp();
  const commandApi = registerUniversalCommandRoutes(app, {
    env,
    fetchImpl,
    repository: tasks,
    memoryProvider: () => memoryRepository,
    notificationProvider: () => notifications,
    providerStatusProvider: () => describeProviderStatus(providerConfig),
    diagnosticsProvider: () => createAxDiagnostics({
      env,
      version: "0.5.0",
      project: "habitat",
      engine: commandApi.engine,
      memory: memoryRepository,
      notifications,
      providerConfig,
      orchestrator: () => ref.current,
      deviceBridge: { ready: true, durable: true, axTokenConfigured: true, perDeviceTokens: true },
      sandbox: async () => ({ available: false, reason: "not probed here", missing: [] })
    })(),
    // A fake device verifier: proves owner gating without a live device store.
    verifyDevice: async (token, deviceId) => token === OWNER_TOKEN && deviceId === OWNER_DEVICE,
    orchestratorProvider: () => ref.current
  });

  ref.current = makeOrchestrator();
  return { env, db, app, commandApi, tasks, runs, memoryRepository, notificationRepository, notifications, modelRequests, tick, makeOrchestrator, ref };
}

async function seedOwnerFact(h) {
  await h.memoryRepository.initialize();
  await h.notificationRepository.initialize();
  const written = await h.memoryRepository.put(
    {
      project: "habitat",
      key: "arch:engine",
      kind: "verified_fact",
      statement: "NEXUS keeps habitat_command_tasks as the only durable command task engine.",
      provenance: { source: "owner", actor: "owner", ref: "mission-08", observedAt: "2026-11-22T00:00:00.000Z" },
      tags: ["architecture", "engine"],
      confidence: 1
    },
    { expectedVersion: 0 }
  );
  assert.equal(written.ok, true);
}

// ------------------------------------------------------------------ 1. the whole lifecycle

test("command → memory → provider fallback → durable task → worker → evidence → memory → notification", async () => {
  const h = harness({
    plan: [{ objective: "report runtime health", adapter: "runtime.health" }],
    openaiStatus: 500
  });
  await seedOwnerFact(h);

  const res = await invoke(h.app.routes.has("POST /ax/command/runs") ? h.app : h.app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "Check command task engine runtime health", runKey: "m9-main" }
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const run = res.body.run;
  assert.equal(res.body.ok, true);
  assert.equal(run.status, "completed");
  assert.equal(run.verified, true);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].verified, true);
  assert.ok(run.steps[0].evidence.length > 0, "worker evidence is bound to the step");

  // Approved memory reached the planner, with provenance.
  assert.ok(run.memory.recalled >= 1);
  assert.ok(run.memory.citations.some(cite => cite.key === "arch:engine" && cite.source === "owner"));
  assert.match(run.memory.context, /VERIFIED FACTS/);

  // The primary provider failed and the fallback answered; both attempts were charged.
  assert.equal(h.modelRequests.length, 2);
  assert.match(h.modelRequests[0].target, /api\.openai\.com/);
  assert.match(h.modelRequests[1].target, /generativelanguage\.googleapis\.com/);
  assert.ok(run.costUsd > 0.005, "the failed attempt is part of the run cost");

  // One task exists, executed and verified by the real engine and tick.
  const listed = await h.commandApi.engine.list({ limit: 10 });
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].status, "done");
  assert.equal(listed.tasks[0].claimedBy !== undefined, true);

  // Verified completion wrote durable memory.
  assert.equal(run.memoryUpdate.ok, true);
  const memoryEntry = await h.memoryRepository.get({ project: "habitat", key: "run:" + run.id });
  assert.equal(memoryEntry.kind, "status");
  assert.equal(memoryEntry.provenance.source, "ax");

  // A durable notification exists, on the honest inbox channel.
  const notes = await h.notifications.list({});
  assert.ok(notes.notifications.some(note => note.type === "run.completed" && note.channel === "inbox" && note.status === "recorded"));

  // History is reconstructed from durable records, not from memory of the request.
  const history = await invoke(h.app, "GET /ax/command/history", { headers: auth });
  assert.equal(history.statusCode, 200);
  assert.equal(history.body.missions.length, 1);
  assert.equal(history.body.missions[0].runId, run.id);
  assert.equal(history.body.missions[0].steps[0].verified, true);
  assert.equal(history.body.summary.verified, 1);
  assert.equal(history.body.summary.costUsd, run.costUsd);
});

// ------------------------------------------------------- 2. duplicate submissions are idempotent

test("the same run key and idempotency key never duplicate work", async () => {
  const h = harness({ plan: [{ objective: "report runtime health", adapter: "runtime.health" }] });
  await seedOwnerFact(h);

  const body = { objective: "Check command task engine runtime health", runKey: "m9-once" };
  const first = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body });
  const second = await invoke(h.app, "POST /ax/command/runs", { headers: auth, body });

  assert.equal(first.body.run.id, second.body.run.id);
  assert.equal(second.body.resumed, true);
  const listed = await h.commandApi.engine.list({ limit: 10 });
  assert.equal(listed.tasks.length, 1, "a resumed run must not submit a second task");
  assert.equal(h.modelRequests.length, 1, "a completed run must not spend a second model call");

  // The engine itself replays an idempotency key even outside a run.
  const direct = await h.commandApi.engine.submit({
    objective: "inspect the repository layout",
    requestedBy: "ax",
    role: "ax",
    adapter: "repo.inspect",
    idempotencyKey: "m9-engine-dup"
  });
  const replay = await h.commandApi.engine.submit({
    objective: "inspect the repository layout",
    requestedBy: "ax",
    role: "ax",
    adapter: "repo.inspect",
    idempotencyKey: "m9-engine-dup"
  });
  assert.equal(direct.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, direct.task.id);
  assert.equal((await h.commandApi.engine.list({ limit: 10 })).tasks.length, 2);
});

// --------------------------------------------------------------- 3. approval is owner-gated

test("a plan step that needs approval parks the run without submitting work", async () => {
  const h = harness({ plan: [{ objective: "publish the approved video", adapter: null, needsApproval: true }] });
  await seedOwnerFact(h);

  const res = await invoke(h.app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "publish the approved video" }
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.run.status, "needs_approval");
  assert.equal(res.body.run.verified, false);
  assert.equal((await h.commandApi.engine.list({ limit: 10 })).tasks.length, 0, "Ax must not submit owner-gated work");

  const notes = await h.notifications.list({});
  assert.ok(notes.notifications.some(note => note.type === "run.needs_approval"));
});

// ------------------------------------------------------- 4. budget caps spending across attempts

test("the run budget counts every provider attempt and stops before submitting", async () => {
  const h = harness({
    plan: [{ objective: "report runtime health", adapter: "runtime.health" }],
    openaiStatus: 500,
    env: { AX_RUN_BUDGET_USD: "0.001" }
  });
  await seedOwnerFact(h);

  const res = await invoke(h.app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "Check command task engine runtime health" }
  });
  assert.equal(res.body.run.status, "budget_exceeded");
  assert.ok(res.body.run.costUsd > 0.001);
  assert.equal((await h.commandApi.engine.list({ limit: 10 })).tasks.length, 0);
  const notes = await h.notifications.list({});
  assert.ok(notes.notifications.some(note => note.type === "run.budget_exceeded"));
});

// ------------------------------------------------ 5. interrupted work recovers after a restart

test("a run abandoned by its driver is settled from durable task rows by a new process", async () => {
  const h = harness({
    plan: [{ objective: "report runtime health", adapter: "runtime.health" }],
    execute: false
  });
  await seedOwnerFact(h);

  const queued = await invoke(h.app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "Check command task engine runtime health" }
  });
  const runId = queued.body.run.id;
  assert.equal(queued.body.run.status, "running");
  assert.match(queued.body.run.note, /cron executor/);

  // The queued task is executed by the one-shot tick after the driver is gone.
  const tickResult = await h.tick();
  assert.equal(tickResult.claimed, 1);
  assert.equal((await h.commandApi.engine.get(queued.body.run.steps[0].taskId)).task.status, "done");

  // A fresh orchestrator instance stands in for a restarted process; it reads the same run store.
  const restarted = h.makeOrchestrator({ withExecutor: false });
  const recovered = await restarted.getRun(runId);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.verified, true);
  assert.ok(recovered.recoveries >= 1);
  assert.equal(recovered.memoryUpdate.ok, true, "a recovered completion still updates memory");

  const notes = await h.notifications.list({});
  assert.ok(notes.notifications.some(note => note.type === "run.recovery"));
});

// -------------------------------------------- 6. memory outage degrades but never corrupts a run

test("a memory outage is visible on the run and does not fail the task", async () => {
  const brokenMemory = createAxMemoryContext({
    repository: { async search() { throw new Error("memory store is down"); } },
    project: "habitat",
    log: quiet
  });
  const h = harness({
    plan: [{ objective: "report runtime health", adapter: "runtime.health" }],
    memoryOverride: brokenMemory
  });
  await h.notificationRepository.initialize();

  const res = await invoke(h.app, "POST /ax/command/runs", {
    headers: auth,
    body: { objective: "Check command task engine runtime health" }
  });
  assert.equal(res.body.run.status, "completed");
  assert.equal(res.body.run.verified, true);
  assert.equal(res.body.run.memory.error, "memory_unavailable");
  assert.equal(res.body.run.memory.recalled, 0);
  assert.equal(res.body.run.memoryUpdate.ok, false);
  assert.equal((await h.commandApi.engine.list({ limit: 10 })).tasks[0].status, "done");
});

// ------------------------------------------------------------- 7. authorization boundaries

test("memory, approvals and diagnostics reject callers without the right credential", async () => {
  const h = harness({ plan: [{ objective: "report runtime health", adapter: "runtime.health" }] });
  await seedOwnerFact(h);

  const anonymous = await invoke(h.app, "GET /ax/command/memory/search", { query: { q: "engine" } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.body.code, "invalid_token");

  const authorized = await invoke(h.app, "GET /ax/command/memory/search", { headers: auth, query: { q: "engine" } });
  assert.equal(authorized.statusCode, 200);
  assert.ok(authorized.body.results.length >= 1);

  // The Ax command token may read memory but may never satisfy an owner action.
  const asAx = await invoke(h.app, "POST /ax/command/memory/owner", {
    headers: ownerAuth,
    body: { key: "arch:owner-only", kind: "verified_fact", statement: "Owner-only fact.", provenance: {} }
  });
  assert.equal(asAx.statusCode, 403);
  assert.equal(asAx.body.code, "command_token_cannot_approve");

  // Ax cannot write a verified fact even through the normal write route.
  const forged = await invoke(h.app, "POST /ax/command/memory", {
    headers: auth,
    body: { key: "arch:forged", kind: "verified_fact", statement: "Ax claims this is verified.", provenance: { source: "owner" } }
  });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.body.code, "verified_fact_owner_only");

  // The device-capable bridge credential still cannot satisfy an owner action without device proof.
  const bridgeAuth = { authorization: "Bearer " + BRIDGE_TOKEN };
  const noDevice = await invoke(h.app, "POST /ax/command/tasks/:id/approve", { headers: bridgeAuth, params: { id: "whatever" }, body: {} });
  assert.equal(noDevice.statusCode, 401);
  assert.equal(noDevice.body.code, "owner_required");

  // With valid owner proof the same action reaches the engine; the id does not exist, so it is 404 —
  // which proves authorization was satisfied rather than bypassed.
  const withDevice = await invoke(h.app, "POST /ax/command/tasks/:id/approve", { headers: ownerBridgeAuth, params: { id: "whatever" }, body: {} });
  assert.equal(withDevice.statusCode, 404);

  const diagnosticsNoToken = await invoke(h.app, "GET /ax/command/diagnostics", {});
  assert.equal(diagnosticsNoToken.statusCode, 401);

  const diagnostics = await invoke(h.app, "GET /ax/command/diagnostics", { headers: auth });
  assert.equal(diagnostics.statusCode, 200);
  const serialized = JSON.stringify(diagnostics.body);
  assert.equal(serialized.includes(OPENAI_KEY), false);
  assert.equal(serialized.includes(GEMINI_KEY), false);
  assert.equal(serialized.includes(COMMAND_TOKEN), false);
  assert.equal(diagnostics.body.diagnostics.secretsExposed, false);
  assert.equal(diagnostics.body.diagnostics.providers.health.checked, false);
});

// -------------------------------------------- 8. providers and diagnostics report honestly

test("provider status separates configured from enabled and refuses unknown providers", async () => {
  const h = harness({ plan: [{ objective: "report runtime health", adapter: "runtime.health" }] });
  const providers = await invoke(h.app, "GET /ax/command/providers", { headers: auth });
  assert.equal(providers.statusCode, 200);
  assert.equal(providers.body.providers.enabled, true);
  assert.equal(providers.body.providers.primary.configured, true);
  assert.equal(providers.body.health.checked, false);

  const unknownEnv = baseEnv({ AX_PROVIDER: "not-a-provider" });
  const unknown = resolveAxProviderConfig(unknownEnv);
  assert.equal(unknown.enabled, false);
  assert.equal(unknown.code, "unknown_provider");

  // A missing primary still plans through a configured fallback.
  const fallbackOnly = resolveAxProviderConfig(baseEnv({ OPENAI_API_KEY: "", GEMINI_API_KEY: GEMINI_KEY }));
  assert.equal(fallbackOnly.enabled, true);
  assert.equal(fallbackOnly.primary.configured, false);
  assert.equal(fallbackOnly.summary.find(entry => entry.name === "gemini").configured, true);
});
