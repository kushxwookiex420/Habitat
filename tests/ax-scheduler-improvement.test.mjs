import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createImprovementMonitor } from "../ax-improvement.mjs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const now = () => new Date(NOW).toISOString();

function scheduler(overrides = {}) {
  return createSchedulerService({
    ticks: createMemorySchedulerRepository(),
    now,
    nowMs: () => NOW,
    ...overrides
  });
}

function notifier() {
  const calls = [];
  return {
    calls,
    async notify(payload) {
      calls.push(payload);
      return { ok: true, id: "ntf_test" };
    }
  };
}

const cleanSignals = () => ({
  systemStatus: {
    components: {
      workers: { execution: { configured: true }, items: [], counts: {} },
      storage: { taskRepositoryReady: true, dispatchLeaseReady: true },
      device: { paired: 0, recentlySeen: false }
    },
    requiredConfiguration: { missing: [] }
  }
});

const brokenSignals = () => ({
  systemStatus: {
    components: {
      workers: { execution: { configured: false, state: "unavailable", detail: "No executor is mounted." }, items: [], counts: {} },
      storage: { taskRepositoryReady: true, dispatchLeaseReady: true },
      device: { paired: 0, recentlySeen: false }
    },
    requiredConfiguration: { missing: [] }
  }
});

test("without an improvement callback the tick is unchanged", async () => {
  const outcome = await scheduler().tick({ trigger: "cron" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.improvement, null);
  assert.equal(outcome.findings.some(item => item.source === "improvement"), false);
});

test("improvement findings ride the existing tick and are severity-mapped", async () => {
  const monitor = createImprovementMonitor({ readSignals: async () => brokenSignals(), now: () => NOW });
  const outcome = await scheduler({ improvement: () => monitor.check() }).tick({ trigger: "cron" });
  const finding = outcome.findings.find(item => item.kind === "execution_blocked");
  assert.ok(finding, "the engine's finding reached the tick");
  assert.equal(finding.severity, "critical");
  assert.equal(finding.source, "improvement");
  assert.equal(finding.safeAction, null, "an improvement is never auto-actioned");
  assert.equal(outcome.status, "degraded");
  assert.equal(outcome.improvement.reported, 1);
});

test("a medium engine finding is a warning here, not a high", async () => {
  const monitor = createImprovementMonitor({
    readSignals: async () => ({
      systemStatus: {
        components: {
          workers: { execution: { configured: true }, items: [], counts: {} },
          storage: { taskRepositoryReady: true, dispatchLeaseReady: true },
          device: { paired: 1, recentlySeen: false, lastSeenAt: "2026-11-20T00:00:00.000Z" }
        },
        requiredConfiguration: { missing: [] }
      }
    }),
    now: () => NOW
  });
  const outcome = await scheduler({ improvement: () => monitor.check() }).tick({ trigger: "cron" });
  const finding = outcome.findings.find(item => item.kind === "device_silent");
  assert.equal(finding.severity, "warning");
  assert.equal(outcome.status, "ok", "a warning alone does not degrade the tick");
});

test("a persistent condition is reported once, and does not page again", async () => {
  const monitor = createImprovementMonitor({ readSignals: async () => brokenSignals(), now: () => NOW });
  const notifications = notifier();
  const service = scheduler({ improvement: () => monitor.check(), notifications });

  const first = await service.tick({ trigger: "cron" });
  assert.equal(first.findings.filter(item => item.source === "improvement").length, 1);
  assert.equal(notifications.calls.length, 1, "a critical finding notifies once");

  const second = await service.tick({ trigger: "cron" });
  assert.equal(second.findings.filter(item => item.source === "improvement").length, 0, "deduplicated");
  assert.equal(second.improvement.suppressed, 1);
  assert.equal(notifications.calls.length, 1, "no second page for the same condition");
});

test("the notification keeps the existing dedupe key and bounded body", async () => {
  const monitor = createImprovementMonitor({ readSignals: async () => brokenSignals(), now: () => NOW });
  const notifications = notifier();
  await scheduler({ improvement: () => monitor.check(), notifications }).tick({ trigger: "cron" });
  assert.equal(notifications.calls.length, 1);
  assert.match(notifications.calls[0].dedupeKey, /^scheduler:\d{4}-\d{2}-\d{2}T\d{2}$/);
  assert.equal(notifications.calls[0].type, "scheduler.tick");
  assert.ok(notifications.calls[0].body.length <= 600);
});

test("a failing improvement pass becomes a warning and never fails the tick", async () => {
  const outcome = await scheduler({
    improvement: async () => { throw new Error("status endpoint unreachable"); }
  }).tick({ trigger: "cron" });
  assert.equal(outcome.ok, true);
  const finding = outcome.findings.find(item => item.kind === "improvement.failed");
  assert.equal(finding.severity, "warning");
  assert.match(finding.detail, /unreachable/);
  assert.equal(outcome.improvement.ok, false);
});

test("a clean status produces no improvement findings and no notification", async () => {
  const monitor = createImprovementMonitor({ readSignals: async () => cleanSignals(), now: () => NOW });
  const notifications = notifier();
  const outcome = await scheduler({ improvement: () => monitor.check(), notifications }).tick({ trigger: "cron" });
  assert.equal(outcome.findings.filter(item => item.source === "improvement").length, 0);
  assert.equal(notifications.calls.length, 0);
  assert.equal(outcome.improvement.reported, 0);
});

test("the monitor refuses to exist without a signal source", () => {
  assert.throws(() => createImprovementMonitor({}), /will not invent one/);
});

test("reset re-reports a condition without creating a durable claim", async () => {
  const monitor = createImprovementMonitor({ readSignals: async () => brokenSignals(), now: () => NOW });
  const service = scheduler({ improvement: () => monitor.check() });
  await service.tick({ trigger: "cron" });
  const second = await service.tick({ trigger: "cron" });
  assert.equal(second.improvement.reported, 0);
  monitor.reset();
  const third = await service.tick({ trigger: "cron" });
  assert.equal(third.improvement.reported, 1, "process-local memory, stated as such");
  assert.equal(third.improvement.processLocalMemory, true);
});
