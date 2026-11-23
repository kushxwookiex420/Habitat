import test from "node:test";
import assert from "node:assert/strict";
import {
  createIncidentService,
  createOperationalMonitor,
  createRecoveryService,
  SAFE_RECOVERY_ACTIONS
} from "../ax-recovery.mjs";
import { createMemoryIncidentRepository } from "../ax-incident-repository.mjs";

const now = () => "2026-11-22T00:00:00.000Z";
const oldIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
const offlineIso = new Date(Date.now() - 90 * 60 * 1000).toISOString();

function monitor(overrides = {}) {
  return createOperationalMonitor({
    presence: async () => ({
      executor: { configured: true, started: false, state: "mounted" },
      heartbeat: { liveWorkers: 0 },
      queue: { ok: true, queued: 4, oldestQueuedAgeSeconds: 1200 },
      canExecute: false
    }),
    engine: {
      list: async () => ({ ok: true, tasks: [{ id: "task-stuck", status: "working", updatedAt: oldIso, createdAt: oldIso }] })
    },
    orchestrator: {
      listRuns: async () => [
        { id: "run-failed", status: "failed", settled: false, error: "worker crashed" },
        { id: "run-late", status: "running", settled: false, deadlineAt: oldIso }
      ]
    },
    devices: async () => [{ device_id: "phone-1", last_seen_at: offlineIso, revoked_at: null }],
    notifications: { list: async () => ({ ok: true, notifications: [{ id: "n1", createdAt: oldIso, status: "pending" }] }) },
    ...overrides
  });
}

test("the monitor reports real findings and never invents a healthy state", async () => {
  const report = await monitor().scan();
  assert.equal(report.ok, true);
  const kinds = report.findings.map(item => item.kind);
  for (const expected of ["scheduler.stopped", "queue.age_exceeded", "workers.none_live", "task.stuck", "run.failed_unsettled", "run.overdue", "device.offline", "notifications.pending_stale"]) {
    assert.ok(kinds.includes(expected), "expected finding " + expected + " in " + kinds.join(","));
  }
  assert.ok(report.summary.high >= 4);
  assert.equal(report.probes.presence, "ok");
});

test("an absent probe produces no fabricated finding", async () => {
  const report = createOperationalMonitor().scan();
  const result = await report;
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.probes.engine, "not_configured");
});

test("incidents deduplicate by fingerprint and keep an occurrence count", async () => {
  const repository = createMemoryIncidentRepository();
  const service = createIncidentService({ repository, now });
  const first = await service.record({ kind: "queue.age_exceeded", severity: "high", subject: "queue", title: "Queue is old", safeAction: "probe_subsystems" });
  assert.equal(first.created, true);
  const second = await service.record({ kind: "queue.age_exceeded", severity: "high", subject: "queue", title: "Queue is old", detail: "still old", safeAction: "probe_subsystems" });
  assert.equal(second.created, false);
  assert.equal(second.incident.occurrences, 2);
  const listed = await service.list({ status: "open" });
  assert.equal(listed.incidents.length, 1);
});

test("recovery refuses destructive or unregistered actions", async () => {
  const repository = createMemoryIncidentRepository();
  const incidents = createIncidentService({ repository, now });
  const recovery = createRecoveryService({ monitor: monitor(), incidents, repairs: {}, now });
  const recorded = await incidents.record({ kind: "task.stuck", subject: "task:1", title: "Stuck", safeAction: "reconcile_run" });

  const destructive = await recovery.recover(recorded.incident.id, { action: "delete_task" });
  assert.equal(destructive.ok, false);
  assert.equal(destructive.code, "unsafe_recovery_refused");
  assert.ok(destructive.allowed.includes("reconcile_run"));

  const unregistered = await recovery.recover(recorded.incident.id, { action: "reconcile_run" });
  assert.equal(unregistered.code, "repair_not_registered");
});

test("a verified repair resolves the incident and records what happened", async () => {
  const repository = createMemoryIncidentRepository();
  const incidents = createIncidentService({ repository, now });
  const repairs = {
    probe_subsystems: async () => ({ ok: true, verified: true, detail: "probed database=reachable memory=available" })
  };
  const recovery = createRecoveryService({ monitor: monitor(), incidents, repairs, now });
  const recorded = await incidents.record({ kind: "queue.unavailable", subject: "queue", title: "Queue unreadable", safeAction: "probe_subsystems" });
  const outcome = await recovery.recover(recorded.incident.id, { action: "probe_subsystems", by: "owner:phone" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.incident.status, "resolved");
  assert.equal(outcome.incident.recovery.action, "probe_subsystems");
  assert.equal(outcome.incident.recovery.verification.verified, true);
  assert.match(outcome.incident.recovery.why, /Queue unreadable/);
});

test("an unverified repair leaves the incident open with the attempt recorded", async () => {
  const repository = createMemoryIncidentRepository();
  const incidents = createIncidentService({ repository, now });
  const repairs = { start_scheduler: async () => ({ ok: true, verified: false, detail: "worker did not report started" }) };
  const recovery = createRecoveryService({ monitor: monitor(), incidents, repairs, now });
  const recorded = await incidents.record({ kind: "scheduler.stopped", subject: "executor", title: "Worker stopped", safeAction: "start_scheduler" });
  const outcome = await recovery.recover(recorded.incident.id, { action: "start_scheduler" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "recovery_unverified");
  const current = await incidents.get(recorded.incident.id);
  assert.equal(current.status, "open");
  assert.equal(current.recovery.action, "start_scheduler");
  assert.equal(current.recovery.verification.verified, false);
});

test("scanAndRecord persists every finding as a durable incident", async () => {
  const incidents = createIncidentService({ repository: createMemoryIncidentRepository(), now });
  const recovery = createRecoveryService({ monitor: monitor(), incidents, repairs: {}, now });
  const report = await recovery.scanAndRecord();
  assert.equal(report.recorded.length, report.findings.length);
  const listed = await incidents.list({ status: "open", limit: 100 });
  assert.equal(listed.incidents.length, report.findings.length);
  assert.equal(SAFE_RECOVERY_ACTIONS.includes("deploy"), false);
});
