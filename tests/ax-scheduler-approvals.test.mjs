import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const now = () => new Date(NOW).toISOString();

function scheduler(overrides = {}) {
  return createSchedulerService({
    ticks: createMemorySchedulerRepository(),
    now,
    nowMs: () => NOW,
    ...overrides
  });
}

const expiredApproval = {
  id: "apr_expired",
  kind: "purchase",
  vendor: "cjdropshipping",
  amountCents: 1237,
  currency: "USD",
  expiresAt: "2026-11-23T11:00:00.000Z"
};
const soonApproval = {
  id: "apr_soon",
  kind: "subscription",
  vendor: "zendrop",
  amountCents: 3900,
  currency: "USD",
  expiresAt: "2026-11-23T12:30:00.000Z"
};

test("approval findings ride the existing tick, not a second scheduler", async () => {
  const service = scheduler({
    approvalExpiry: async () => ({ ok: true, expired: [expiredApproval], expiringSoon: [soonApproval], failed: [] })
  });

  const outcome = await service.tick({ trigger: "cron" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "degraded", "an expired approval is a high finding");

  const expired = outcome.findings.find(item => item.kind === "approval.expired");
  assert.ok(expired, "approval.expired is reported");
  assert.equal(expired.severity, "high");
  assert.equal(expired.subject, "approval:apr_expired");
  assert.match(expired.detail, /cjdropshipping/);

  const expiring = outcome.findings.find(item => item.kind === "approval.expiring");
  assert.ok(expiring, "approval.expiring is reported");
  assert.equal(expiring.severity, "warning");
  assert.equal(expiring.subject, "approval:apr_soon");
  assert.match(expiring.detail, /30 minute/);

  assert.deepEqual(outcome.approvals, { ok: true, expired: 1, expiringSoon: 1, failed: 0, withinMs: 60 * 60_000 });

  const state = await service.status();
  assert.equal(state.scheduler.tickCount, 1, "one lease, one tick, one sweep");
});

test("the sweep window is configured on the existing scheduler", async () => {
  const seen = [];
  const service = scheduler({
    approvalExpiry: async input => {
      seen.push(input);
      return { ok: true, expired: [], expiringSoon: [], failed: [] };
    }
  });
  await service.tick();
  assert.deepEqual(seen, [{ withinMs: 60 * 60_000 }]);
  assert.equal(service.limits.approvalExpirySoonMs, 60 * 60_000);

  const custom = scheduler({
    approvalExpirySoonMs: 5 * 60_000,
    approvalExpiry: async input => {
      seen.push(input);
      return { ok: true };
    }
  });
  await custom.tick();
  assert.deepEqual(seen.at(-1), { withinMs: 5 * 60_000 });
});

test("a failing monitor is a finding, never a failed tick", async () => {
  const service = scheduler({
    approvalExpiry: async () => {
      throw new Error("approval store unreachable");
    }
  });
  const outcome = await service.tick();
  assert.equal(outcome.ok, true);
  const finding = outcome.findings.find(item => item.kind === "approval.monitor_failed");
  assert.ok(finding);
  assert.equal(finding.severity, "warning");
  assert.equal(outcome.approvals.ok, false);
  assert.equal(outcome.approvals.code, "approval_monitor_failed");
});

test("an unavailable ledger is reported without blocking maintenance", async () => {
  const service = scheduler({
    approvalExpiry: async () => ({ ok: false, code: "approval_store_unavailable" })
  });
  const outcome = await service.tick();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.findings.some(item => item.kind === "approval.monitor_failed"), true);
  assert.equal(outcome.approvals.code, "approval_store_unavailable");
});

test("a sweep race is reported as incomplete rather than retried blindly", async () => {
  const service = scheduler({
    approvalExpiry: async () => ({ ok: true, expired: [], expiringSoon: [], failed: ["apr_race"] })
  });
  const outcome = await service.tick();
  const incomplete = outcome.findings.find(item => item.kind === "approval.sweep_incomplete");
  assert.ok(incomplete);
  assert.match(incomplete.detail, /apr_race/);
  assert.equal(outcome.approvals.failed, 1);
});

test("without a provider the scheduler reports nothing about approvals", async () => {
  const service = scheduler();
  const outcome = await service.tick();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.approvals, null);
  assert.equal(outcome.findings.some(item => String(item.kind).startsWith("approval.")), false);
});
