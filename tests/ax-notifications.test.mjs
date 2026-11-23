import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxNotificationRepository } from "../d1-ax-notification-repository.mjs";
import {
  createNotificationService,
  normalizeNotification,
  notificationEventsForRun
} from "../ax-notifications.mjs";

/**
 * Notification events: idempotent recording, honest channel reporting and bounded delivery retries.
 * Storage is SQLite behind the D1 HTTP shape; no push provider is contacted or claimed.
 */

const quiet = { log() {}, warn() {}, error() {} };

function harness({ failFirst = 0 } = {}) {
  const db = new DatabaseSync(":memory:");
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const statement = db.prepare(sql);
    // Statements with RETURNING produce rows even though they are writes.
    const rows = /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)
      ? statement.all(...params)
      : (statement.run(...params), []);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  const repository = createD1AxNotificationRepository({
    accountId: "acct-notify",
    databaseId: "db-notify-0001",
    apiToken: "d1_token_notify_" + "x".repeat(10),
    fetchImpl
  });
  let failures = failFirst;
  const deliver = async () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("push endpoint refused the request");
    }
    return { delivered: true };
  };
  return { db, repository, service: createNotificationService({ repository, project: "habitat", log: quiet }), deliver };
}

test("recording is idempotent on the dedupe key", async () => {
  const { repository, service } = harness();
  await repository.initialize();
  const first = await service.record({
    type: "run.completed",
    runId: "run_1",
    severity: "info",
    title: "Mission completed",
    body: "Run run_1 completed."
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);

  const second = await service.record({
    type: "run.completed",
    runId: "run_1",
    severity: "info",
    title: "Mission completed",
    body: "Run run_1 completed."
  });
  assert.equal(second.ok, true);
  assert.equal(second.created, false, "the same event must not be recorded twice");

  const listed = await service.list({});
  assert.equal(listed.notifications.length, 1);
});

test("inbox notifications are recorded, not reported as pushed", async () => {
  const { repository, service } = harness();
  await repository.initialize();
  await service.record({ type: "run.failed", runId: "run_2", severity: "critical", title: "Mission failed", body: "no evidence" });
  const listed = await service.list({});
  const note = listed.notifications[0];
  assert.equal(note.channel, "inbox");
  assert.equal(note.status, "recorded");
  assert.ok(note.deliveredAt, "inbox delivery is the durable row itself");
  assert.equal(note.attempts, 0);
});

test("external delivery retries safely and records each attempt", async () => {
  const { repository, service, deliver } = harness({ failFirst: 1 });
  await repository.initialize();
  await service.record({ type: "run.failed", runId: "run_3", channel: "external", title: "t", body: "b" });

  const first = await service.deliverPending({ deliver });
  assert.equal(first.delivered, 0);
  const pending = (await service.list({ status: "pending" })).notifications[0];
  assert.equal(pending.attempts, 1);
  assert.match(pending.lastError, /refused/);

  const second = await service.deliverPending({ deliver });
  assert.equal(second.delivered, 1);
  const delivered = (await service.list({ status: "delivered" })).notifications[0];
  assert.equal(delivered.attempts, 2);
  assert.ok(delivered.deliveredAt);
});

test("delivery stops at maxAttempts instead of retrying forever", async () => {
  const { repository, service } = harness({ failFirst: 10 });
  await repository.initialize();
  await service.record({ type: "run.failed", runId: "run_4", channel: "external", title: "t", body: "b" });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await service.deliverPending({ deliver: async () => { throw new Error("down"); }, maxAttempts: 3 });
  }
  const failed = (await service.list({ status: "failed" })).notifications[0];
  assert.equal(failed.attempts, 3, "attempts stop at the configured ceiling");
  const pending = (await service.list({ status: "pending" })).notifications;
  assert.equal(pending.length, 0);
});

test("with no transport configured, delivery is an honest no-op", async () => {
  const { repository, service } = harness();
  await repository.initialize();
  const result = await service.deliverPending({});
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 0);
  assert.equal(result.reason, "no_external_transport_configured");
});

test("acknowledgement is recorded with its time", async () => {
  const { repository, service } = harness();
  await repository.initialize();
  const recorded = await service.record({ type: "run.recovery", runId: "run_5", title: "Recovered", body: "reconciled" });
  const ack = await service.acknowledge({ id: recorded.notification.id, by: "owner:device-1" });
  assert.equal(ack.ok, true);
  assert.equal(ack.notification.status, "acknowledged");
  assert.ok(ack.notification.acknowledgedAt);
});

test("event descriptors are derived from a settled run, including recovery", () => {
  const completed = notificationEventsForRun({
    id: "run_6",
    status: "completed",
    verified: true,
    objective: "report runtime health",
    evidence: ["runtime: ok"],
    recoveries: 1
  });
  assert.deepEqual(completed.map(event => event.type), ["run.completed", "run.recovery"]);
  assert.equal(completed[0].dedupeKey, "run:run_6:run.completed");

  assert.deepEqual(notificationEventsForRun({ id: "r", status: "needs_approval" }).map(e => e.type), ["run.needs_approval"]);
  assert.deepEqual(notificationEventsForRun({ id: "r", status: "budget_exceeded" }).map(e => e.type), ["run.budget_exceeded"]);
  assert.deepEqual(notificationEventsForRun({ id: "r", status: "running" }), []);
});

test("notification bodies redact credential shapes", () => {
  const normalized = normalizeNotification({
    type: "run.failed",
    title: "Failure",
    body: "upstream said sk-" + "a".repeat(28) + " and Bearer " + "b".repeat(24)
  });
  assert.equal(normalized.ok, true);
  assert.doesNotMatch(normalized.notification.body, /sk-a{10}/);
  assert.doesNotMatch(normalized.notification.body, /Bearer b{10}/);
  assert.match(normalized.notification.body, /\[redacted\]/);
});
