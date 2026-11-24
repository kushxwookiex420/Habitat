import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createImprovementMonitor } from "../ax-improvement.mjs";
import { createWorkforce } from "../ax-workforce.mjs";
import { createWorkforceIntake } from "../ax-workforce-intake.mjs";
import { createWorkforceRunner } from "../ax-workforce-runner.mjs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const now = () => new Date(NOW).toISOString();
const quiet = { error() {}, warn() {}, log() {} };

const brokenStatus = {
  components: {
    workers: { execution: { configured: false, state: "unavailable", detail: "No executor is mounted." }, items: [], counts: {} },
    storage: { taskRepositoryReady: true, dispatchLeaseReady: true },
    device: { paired: 0, recentlySeen: false }
  },
  requiredConfiguration: { missing: [] }
};

function workforce() {
  const w = createWorkforce({ now, log: quiet });
  w.registerAdapter({ id: "coder", kind: "coding", execute: async () => ({ ok: true }), health: async () => ({ status: "healthy" }) });
  w.registerAdapter({ id: "verifier", kind: "verification", execute: async () => ({ ok: true }) });
  w.registerAgent({
    id: "coder.one", specialty: "coding", adapterId: "coder",
    capabilities: ["coding", "tests"], permissions: { allowed: ["coding"], denied: ["deploy"] },
    availability: { maxConcurrent: 2 }
  });
  w.registerAgent({
    id: "verifier.one", specialty: "verification", adapterId: "verifier",
    capabilities: ["verification"], permissions: { allowed: ["verification"], denied: [] },
    availability: { maxConcurrent: 2 }
  });
  return w;
}

function pipeline(w) {
  const intake = createWorkforceIntake({ workforce: w, now });
  const runner = createWorkforceRunner({
    workforce: w,
    executors: {
      coder: async () => ({ result: { status: "completed", evidence: ["patch.diff"], changedFiles: ["a.mjs"], tests: { ran: 2, passed: 2, failed: 0 }, costCents: null } }),
      verifier: async () => ({ ok: true, evidence: ["independent rerun 2/2"], tests: { ran: 2, passed: 2, failed: 0 } })
    },
    verifierAgentId: "verifier.one",
    now,
    log: quiet
  });
  return { intake: finding => intake.intake(finding), runner: () => runner.runOnce() };
}

test("one tick detects, assigns, executes and verifies without a manual script", async () => {
  const w = workforce();
  const { intake, runner } = pipeline(w);
  const monitors = createImprovementMonitor({ readSignals: async () => ({ systemStatus: brokenStatus }), now: () => NOW });
  const service = createSchedulerService({
    ticks: createMemorySchedulerRepository(),
    now,
    nowMs: () => NOW,
    log: quiet,
    improvement: () => monitors.check(),
    workforceIntake: intake,
    workforceRunner: runner
  });

  const outcome = await service.tick({ trigger: "cron" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.workforce.tasks.length, 1);
  assert.equal(outcome.workforce.tasks[0].agentId, "coder.one");
  assert.ok(outcome.workforce.tasks[0].taskId.startsWith("task-execution_blocked-"));
  assert.equal(outcome.workforce.run.verified, 1);

  const result = w.results()[0];
  assert.equal(result.status, "verified");
  assert.equal(result.approvalRequired, true, "the owner still decides");
  assert.equal(result.approved, false);
  assert.equal(outcome.status, "degraded", "the critical finding still marks the tick degraded");
});

test("a second tick does not duplicate the task for a finding already reported", async () => {
  const w = workforce();
  const { intake, runner } = pipeline(w);
  const monitors = createImprovementMonitor({ readSignals: async () => ({ systemStatus: brokenStatus }), now: () => NOW });
  const service = createSchedulerService({
    ticks: createMemorySchedulerRepository(), now, nowMs: () => NOW, log: quiet,
    improvement: () => monitors.check(), workforceIntake: intake, workforceRunner: runner
  });
  await service.tick({ trigger: "cron" });
  const second = await service.tick({ trigger: "cron" });
  assert.equal(second.workforce.tasks.length, 0, "the monitor deduplicated the finding");
  assert.equal(w.assignments().length, 1);
  assert.equal(w.results().length, 1);
});

test("an intake failure is recorded on the tick and does not stop it", async () => {
  const w = workforce();
  const monitors = createImprovementMonitor({ readSignals: async () => ({ systemStatus: brokenStatus }), now: () => NOW });
  const service = createSchedulerService({
    ticks: createMemorySchedulerRepository(), now, nowMs: () => NOW, log: quiet,
    improvement: () => monitors.check(),
    workforceIntake: async () => { throw new Error("registry offline"); }
  });
  const outcome = await service.tick({ trigger: "cron" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.workforce.tasks, [{ taskId: null, code: "intake_failed" }]);
  assert.equal(outcome.workforce.run, null, "no runner work when nothing was assigned");
  assert.equal(w.results().length, 0);
});

test("a runner failure is reported, not hidden", async () => {
  const w = workforce();
  const { intake } = pipeline(w);
  const monitors = createImprovementMonitor({ readSignals: async () => ({ systemStatus: brokenStatus }), now: () => NOW });
  const service = createSchedulerService({
    ticks: createMemorySchedulerRepository(), now, nowMs: () => NOW, log: quiet,
    improvement: () => monitors.check(),
    workforceIntake: intake,
    workforceRunner: async () => { throw new Error("workspace unavailable"); }
  });
  const outcome = await service.tick({ trigger: "cron" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.workforce.run.ok, false);
  assert.equal(outcome.workforce.run.code, "runner_failed");
  assert.equal(w.results().length, 0);
});
