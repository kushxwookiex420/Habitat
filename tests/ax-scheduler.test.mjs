import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");

function scheduler(overrides = {}) {
  const ticks = createMemorySchedulerRepository();
  const service = createSchedulerService({
    ticks,
    now: () => new Date(NOW).toISOString(),
    nowMs: () => NOW,
    tickIntervalMs: 60_000,
    ...overrides
  });
  return { ticks, service };
}

test("overlapping invocations cannot both run a tick", async () => {
  const runs = [];
  const { service, ticks } = scheduler({
    recovery: {
      async scanAndRecord() {
        runs.push("scan");
        await new Promise(resolve => setTimeout(resolve, 10));
        return { ok: true, recorded: [], report: { summary: { total: 0 } } };
      }
    }
  });
  const [first, second] = await Promise.all([service.tick({ trigger: "cron" }), service.tick({ trigger: "cron" })]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter(item => item.ok === true).length, 1);
  assert.equal(outcomes.filter(item => item.code === "tick_overlap").length, 1);
  assert.equal(runs.length, 1, "the recovery scan ran once");
  const state = await ticks.status();
  assert.equal(state.lease, null, "a finished tick releases its lease");
  assert.equal(state.tickCount, 1);
});

test("a successful tick records last success and a healthy status", async () => {
  const { service } = scheduler();
  const tick = await service.tick();
  assert.equal(tick.ok, true);
  assert.equal(tick.status, "ok");
  const status = await service.status();
  assert.equal(status.scheduler.status, "healthy");
  assert.equal(status.scheduler.healthy, true);
  assert.equal(status.scheduler.lastStatus, "ok");
  assert.equal(status.scheduler.lastSuccessAt, new Date(NOW).toISOString());
  assert.equal(status.scheduler.missedTicks, 0);
});

test("missed ticks are surfaced, not hidden", async () => {
  const ticks = createMemorySchedulerRepository({
    state: {
      lastStartAt: "2026-11-22T11:54:00.000Z",
      lastSuccessAt: "2026-11-22T11:54:00.000Z",
      lastStatus: "ok",
      tickCount: 5
    }
  });
  const service = createSchedulerService({ ticks, now: () => new Date(NOW).toISOString(), nowMs: () => NOW, tickIntervalMs: 60_000 });
  const status = await service.status();
  assert.equal(status.scheduler.missedTicks, 5);
  assert.equal(status.scheduler.status, "degraded");
  assert.equal(status.scheduler.healthy, false);
});

test("a failed tick records failure and never advances last success", async () => {
  const ticks = createMemorySchedulerRepository({
    state: { lastSuccessAt: "2026-11-22T11:59:00.000Z", lastStatus: "ok" }
  });
  const service = createSchedulerService({
    ticks,
    now: () => new Date(NOW).toISOString(),
    nowMs: () => NOW,
    recovery: { async scanAndRecord() { throw new Error("database_unreachable"); } }
  });
  const outcome = await service.tick();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "tick_failed");
  const state = await ticks.status();
  assert.equal(state.lastStatus, "failed");
  assert.equal(state.lastSuccessAt, "2026-11-22T11:59:00.000Z");
  assert.equal(state.lease, null);
  assert.match(state.lastDetail, /database_unreachable/);
});

test("an expired lease can be taken over; a live one cannot", async () => {
  const ticks = createMemorySchedulerRepository({
    state: { lease: { tickId: "old", owner: "cron", startedAt: "2026-11-22T11:00:00.000Z", expiresAt: "2026-11-22T11:01:00.000Z" } }
  });
  const service = createSchedulerService({ ticks, now: () => new Date(NOW).toISOString(), nowMs: () => NOW });
  const outcome = await service.tick();
  assert.equal(outcome.ok, true, "an expired lease does not block forever");
});

test("stuck objectives and expired approvals become scheduler findings", async () => {
  const objectives = {
    async list({ status } = {}) {
      if (status === "awaiting_approval") {
        return [{
          id: "obj_wait",
          status: "awaiting_approval",
          updatedAt: "2026-11-20T00:00:00.000Z",
          createdAt: "2026-11-20T00:00:00.000Z",
          approval: { requestedAt: "2026-11-20T00:00:00.000Z" }
        }];
      }
      return [{
        id: "obj_stuck",
        status: "executing",
        updatedAt: "2026-11-22T10:00:00.000Z",
        createdAt: "2026-11-22T10:00:00.000Z"
      }];
    }
  };
  const { service } = scheduler({ objectives });
  const tick = await service.tick();
  assert.equal(tick.ok, true);
  assert.equal(tick.status, "degraded");
  assert.ok(tick.findings.some(item => item.kind === "objective.stuck" && item.objectiveId === "obj_stuck"));
  assert.ok(tick.findings.some(item => item.kind === "approval.expired" && item.objectiveId === "obj_wait"));
});

test("scheduler status contains no fabricated health before its first tick", async () => {
  const { service } = scheduler();
  const status = await service.status();
  assert.equal(status.scheduler.status, "never_run");
  assert.equal(status.scheduler.healthy, false);
  assert.equal(status.scheduler.lastSuccessAt, null);
});
