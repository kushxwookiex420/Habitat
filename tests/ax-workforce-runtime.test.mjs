import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkforceRuntime, workforceConfiguration, inspectWorkforceSchema } from "../ax-workforce-runtime.mjs";
import { createWorkforceRepository } from "../d1-workforce-repository.mjs";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createImprovementMonitor } from "../ax-improvement.mjs";
import { buildSystemStatus } from "../system-status.mjs";
import { summarizeWorkforce } from "../ax-workforce-status.mjs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const now = () => new Date(NOW).toISOString();
const quiet = { error() {}, warn() {}, log() {} };
const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "acct", HABITAT_D1_DATABASE_ID: "db", HABITAT_D1_API_TOKEN: "token" };

function queryFrom(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };
}

function finding() {
  return {
    id: "imp:execution_blocked:runtime01",
    kind: "execution_blocked",
    subject: "nexus-executor",
    title: "No executor is mounted",
    evidence: ["execution.configured=false"]
  };
}

const EXECUTORS = {
  "habitat-planner": async () => ({
    result: { status: "completed", evidence: ["patch.diff"], changedFiles: ["a.mjs"], tests: { ran: 2, passed: 2, failed: 0 }, costCents: null }
  }),
  "habitat-verifier": async () => ({ ok: true, evidence: ["independent rerun 2/2"], tests: { ran: 2, passed: 2, failed: 0 } })
};

async function preparedDatabase() {
  const db = new DatabaseSync(":memory:");
  const query = queryFrom(db);
  await createWorkforceRepository({ query, now }).initialize();
  return { db, query };
}

test("the flag is off by default and touches no database", async () => {
  const configuration = workforceConfiguration({ env: {} });
  assert.equal(configuration.enabled, false);
  assert.equal(configuration.configured, false);
  assert.equal(configuration.nexusRuntimeEnabled, false);

  let calls = 0;
  const runtime = createWorkforceRuntime({
    env: {},
    query: async () => { calls += 1; return []; },
    log: quiet
  });
  const status = await runtime.initialize();
  assert.equal(status.state, "disabled");
  assert.equal(status.enabled, false);
  assert.equal(status.initialized, false);
  assert.equal(calls, 0, "no query ran while disabled");
  assert.equal((await runtime.intake(finding())).code, "workforce_disabled");
  assert.equal((await runtime.run()).code, "workforce_disabled");
});

test("enabling the workforce does not enable the NEXUS runtime", async () => {
  const runtime = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", NEXUS_RUNTIME_ENABLED: "false", ...CREDENTIALS }, query: async () => ({}), log: quiet });
  const status = await runtime.initialize();
  assert.equal(status.enabled, true);
  assert.equal(status.nexusRuntimeEnabled, false);
});

test("enabled without a D1 binding refuses instead of falling back to memory", async () => {
  let calls = 0;
  const runtime = createWorkforceRuntime({
    env: { HABITAT_WORKFORCE_ENABLED: "true" },
    query: async () => { calls += 1; return []; },
    log: quiet
  });
  const status = await runtime.initialize();
  assert.equal(status.state, "unconfigured");
  assert.equal(status.configured, false);
  assert.equal(status.initialized, false);
  assert.equal(calls, 0);
  assert.equal((await runtime.intake(finding())).code, "workforce_unconfigured");
});

test("a missing migration 0010 is a safe refusal and the runtime creates nothing", async () => {
  const db = new DatabaseSync(":memory:");
  const query = queryFrom(db);
  const runtime = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, log: quiet });
  const status = await runtime.initialize();
  assert.equal(status.state, "schema_missing");
  assert.equal(status.migration.ready, false);
  assert.equal(status.migration.appliedByRuntime, false);
  assert.deepEqual(status.migration.missing, [
    "habitat_ax_worker_adapters", "habitat_ax_workers", "habitat_ax_worker_assignments",
    "habitat_ax_worker_results", "habitat_ax_worker_audit"
  ]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.equal(tables.length, 0, "the runtime did not create the schema");
  assert.equal((await runtime.run()).code, "workforce_schema_missing");

  const schema = await inspectWorkforceSchema({ query });
  assert.equal(schema.ok, false);
});

test("with the schema present the runtime hydrates, registers its agents and reports five separate states", async () => {
  const { db, query } = await preparedDatabase();
  const runtime = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, executors: EXECUTORS, log: quiet });
  const status = await runtime.initialize();
  assert.equal(status.state, "initialized");
  assert.equal(status.configured, true);
  assert.equal(status.enabled, true);
  assert.equal(status.initialized, true);
  assert.equal(status.running, false);
  assert.equal(status.verified, false);
  // Two default workforce agents plus the seven specialist agents the mounted mission service registers
  // into this same durable workforce; the count is the registry, not a wish.
  assert.equal(status.counts.agents, 9);
  assert.equal(status.migration.ready, true);
  db.close();
});

test("an in-flight assignment is recovered after a restart and completed to approval-required", async () => {
  const { db, query } = await preparedDatabase();
  const first = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, executors: EXECUTORS, log: quiet });
  await first.initialize();
  const intake = await first.intake(finding());
  assert.equal(intake.ok, true);
  assert.equal(intake.agentId, "coder.workforce");

  // New process over the same store: nothing is shared but the database.
  const second = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, executors: EXECUTORS, log: quiet });
  const recovered = await second.initialize();
  assert.equal(recovered.recoveredAssignments, 1, "the active assignment came back");
  assert.equal(recovered.counts.active, 1);

  const run = await second.run();
  assert.equal(run.verified, 1);
  const status = second.status();
  assert.equal(status.state, "running");
  assert.equal(status.running, true);
  assert.equal(status.verified, true);
  assert.deepEqual(status.counts.verified, 1);
  assert.equal(status.counts.approvalRequired, 1, "verification is not approval");
  db.close();
});

test("the scheduler coordinates a finding through the runtime, with no manual step", async () => {
  const { db, query } = await preparedDatabase();
  const runtime = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, executors: EXECUTORS, log: quiet });
  await runtime.initialize();
  const broken = {
    components: {
      workers: { execution: { configured: false, state: "unavailable", detail: "No executor is mounted." }, items: [], counts: {} },
      storage: { taskRepositoryReady: true, dispatchLeaseReady: true },
      device: { paired: 0, recentlySeen: false }
    },
    requiredConfiguration: { missing: [] }
  };
  const monitor = createImprovementMonitor({ readSignals: async () => ({ systemStatus: broken }), now: () => NOW });
  const service = createSchedulerService({
    ticks: createMemorySchedulerRepository(),
    now,
    nowMs: () => NOW,
    log: quiet,
    improvement: () => monitor.check(),
    workforceIntake: runtime.intake,
    workforceRunner: runtime.run
  });

  const tick = await service.tick({ trigger: "cron" });
  assert.equal(tick.workforce.tasks.length, 1);
  assert.equal(tick.workforce.run.verified, 1);
  const status = runtime.status();
  assert.equal(status.initialized, true);
  assert.equal(status.running, true);
  assert.equal(status.verified, true);
  assert.equal(status.counts.results, 1);
  assert.equal(status.lastError, null);
  db.close();
});

test("an executor failure is bounded and never becomes a verified result", async () => {
  const { db, query } = await preparedDatabase();
  const runtime = createWorkforceRuntime({
    env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS },
    query,
    executors: { "habitat-planner": async () => { throw new Error("provider 503"); } },
    log: quiet
  });
  await runtime.initialize();
  await runtime.intake(finding());
  const first = await runtime.run();
  assert.equal(first.retried, 1);
  await runtime.run();
  const status = runtime.status();
  assert.equal(status.verified, false);
  assert.equal(status.counts.results, 0);
  assert.equal(status.counts.active, 0, "the assignment is exhausted, not left invisible");
  db.close();
});

test("an unavailable worker is skipped rather than executed or silently dropped", async () => {
  const { db, query } = await preparedDatabase();
  const runtime = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, executors: EXECUTORS, log: quiet });
  await runtime.initialize();
  await runtime.intake(finding());
  // Mark the worker unhealthy through a second durable view over the same store.
  const repository = createWorkforceRepository({ query, now });
  const agents = await repository.listAgents();
  const coder = agents.find(agent => agent.id === "coder.workforce");
  await repository.saveAgent({ ...coder, health: { status: "unavailable", checkedAt: now() } });
  const restarted = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, executors: EXECUTORS, log: quiet });
  await restarted.initialize();
  const run = await restarted.run();
  assert.equal(run.verified, 0);
  assert.equal(run.skipped[0].code, "agent_unavailable");
  assert.equal(restarted.status().counts.results, 0);
  db.close();
});

test("a hydration failure leaves the workforce stopped, not half-running", async () => {
  const db = new DatabaseSync(":memory:");
  const query = queryFrom(db);
  await createWorkforceRepository({ query, now }).initialize();
  let calls = 0;
  const failing = async (sql, params = []) => {
    calls += 1;
    if (/FROM habitat_ax_workers/i.test(sql)) throw new Error("D1 read timeout");
    return query(sql, params);
  };
  const runtime = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query: failing, log: quiet });
  const status = await runtime.initialize();
  assert.equal(status.state, "initialization_failed");
  assert.equal(status.initialized, false);
  assert.match(status.lastError, /D1 read timeout/);
  assert.ok(calls > 0);
  assert.equal((await runtime.intake(finding())).code, "workforce_not_initialized");
  assert.equal(runtime.status().counts.agents, 0);
  db.close();
});

test("plan-only default execution never claims a verified result", async () => {
  const { db, query } = await preparedDatabase();
  const runtime = createWorkforceRuntime({ env: { HABITAT_WORKFORCE_ENABLED: "true", ...CREDENTIALS }, query, log: quiet });
  await runtime.initialize();
  await runtime.intake(finding());
  const run = await runtime.run();
  assert.equal(run.verified, 0);
  const results = runtime.status().counts;
  assert.equal(results.verified, 0, "a plan is not a verified change");
  db.close();
});

test("/system/status keeps the five workforce states apart and is additive when disabled", () => {
  const disabled = summarizeWorkforce(createWorkforceRuntime({ env: {} }).status());
  assert.equal(disabled.state, "disabled");
  assert.deepEqual(
    [disabled.enabled, disabled.configured, disabled.initialized, disabled.running, disabled.verified],
    [false, false, false, false, false]
  );
  const shared = {
    env: {},
    now: NOW,
    registry: new Map(),
    tasks: [],
    deviceBridge: { durable: false, axTokenConfigured: false, perDeviceTokens: true, nexus: { configured: false, reason: "disabled_by_config" } },
    devicePresence: { paired: 0, recentlySeen: false },
    storage: { taskRepositoryReady: false },
    providers: {},
    execution: { configured: false, reason: "disabled_by_config" }
  };
  const baseline = buildSystemStatus(shared);
  const status = buildSystemStatus({ ...shared, workforce: createWorkforceRuntime({ env: {} }).status() });
  assert.equal(status.components.workforce.state, "disabled");
  assert.equal(status.components.workforce.enabled, false);
  // Existing sections are byte-identical: the workforce section is additive, and no route changes.
  for (const key of ["backend", "api", "authentication", "storage", "workers", "device", "providers"]) {
    assert.deepEqual(status.components[key], baseline.components[key], key + " is unchanged when the workforce is disabled");
  }
  assert.match(status.report, /Workforce: DISABLED/);

  const absent = buildSystemStatus({ env: {}, now: NOW, execution: { configured: false } });
  assert.equal(absent.components.workforce.state, "not_configured");
  assert.equal(absent.components.workforce.enabled, false);
});
