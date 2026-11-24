import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHeartbeatRepository } from "../d1-heartbeat-repository.mjs";
import { createHeartbeatMonitor, TRIGGER_MESSAGE, summarizeSnapshot } from "../ax-heartbeat.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const START = Date.parse("2026-11-24T18:00:00.000Z");

function db() {
  const database = new DatabaseSync(":memory:");
  const query = async (sql, params = []) => {
    const statement = database.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
  return { database, query };
}

function missions(list) {
  return { missions: async () => ({ ok: true, missions: list }) };
}

function fakeNotifier({ failures = 0 } = {}) {
  const sent = [];
  let remainingFailures = failures;
  return {
    channel: "test",
    sent,
    async send(payload) {
      sent.push(payload);
      if (remainingFailures > 0) { remainingFailures -= 1; return { ok: false, error: "simulated_failure" }; }
      return { ok: true, status: 202 };
    }
  };
}

function mission(overrides = {}) {
  return {
    id: "msn_test",
    status: "planned",
    objective: "Test the heartbeat",
    tasks: [{ id: "t1", title: "Do work", status: "pending" }],
    approvals: [],
    updatedAt: "2026-11-24T18:00:00.000Z",
    ...overrides
  };
}

async function harness({ team = [mission()], notifier = null, maxAttempts = 3 } = {}) {
  const { database, query } = db();
  const clock = { value: START };
  const now = () => clock.value;
  const repository = createHeartbeatRepository({ query, now: () => new Date(clock.value).toISOString() });
  await repository.initialize();
  const runtime = missions(team);
  const monitor = createHeartbeatMonitor({
    repository, missionRuntime: runtime, statusProvider: async () => ({ version: "0.8.6", commit: "abc", components: { identity: { name: "Ax" }, missions: { state: "running" } } }),
    notifier, now, log: quiet, maxAttempts
  });
  return { database, repository, monitor, clock, notifier };
}

test("the trigger text is exact and a beat queues only meaningful, deduplicated events", async () => {
  const h = await harness();
  assert.equal(h.monitor.TRIGGER_MESSAGE, TRIGGER_MESSAGE);
  assert.equal(TRIGGER_MESSAGE, "AX RECONNECT — HABITAT HEARTBEAT.");

  const first = await h.monitor.beat();
  assert.equal(first.ok, true);
  assert.equal(first.queued, 1);
  assert.equal(first.events[0].kind, "mission_status");
  assert.equal(first.events[0].payload.missionId, "msn_test");

  h.clock.value += 60_000;
  const second = await h.monitor.beat();
  assert.equal(second.queued, 0, "the same state must not create a second event");
  const pending = await h.repository.pendingEvents({});
  assert.equal(pending.length, 1);
  h.database.close();
});

test("status changes become new events, and delivery is recorded as delivered, not verified", async () => {
  const team = [mission()];
  const notifier = fakeNotifier();
  const h = await harness({ team, notifier });
  await h.monitor.beat();
  team.splice(0, 1, mission({ status: "completed", tasks: [{ id: "t1", status: "completed" }] }));
  h.clock.value += 60_000;
  const result = await h.monitor.beat();
  assert.equal(result.queued, 1);
  assert.equal(result.events[0].dedupeKey, "mission:msn_test:completed");
  const delivered = await h.monitor.deliver();
  assert.equal(delivered.delivered, 2);
  const events = await h.repository.listEvents({});
  assert.equal(events.filter(event => event.status === "delivered").length, 2);
  assert.equal(events.filter(event => event.status === "acknowledged").length, 0);
  h.database.close();
});

test("duplicate delivery attempts do not resend an already delivered event", async () => {
  const notifier = fakeNotifier();
  const h = await harness({ notifier });
  await h.monitor.beat();
  const first = await h.monitor.deliver();
  assert.equal(first.delivered, 1);
  const second = await h.monitor.deliver();
  assert.equal(second.attempted, 0);
  assert.equal(notifier.sent.length, 1);
  h.database.close();
});

test("a failing notifier retries within a bound and then marks the event dead", async () => {
  const notifier = fakeNotifier({ failures: 3 });
  const h = await harness({ notifier, maxAttempts: 3 });
  await h.monitor.beat();
  const first = await h.monitor.deliver();
  assert.equal(first.failed, 1);
  const second = await h.monitor.deliver();
  assert.equal(second.failed, 1);
  const third = await h.monitor.deliver();
  assert.equal(third.dead, 1);
  const events = await h.repository.listEvents({});
  assert.equal(events[0].status, "dead");
  assert.equal(events[0].attempts, 3);
  assert.equal((await h.monitor.deliver()).attempted, 0, "a dead event is not retried forever");
  h.database.close();
});

test("without a notifier events stay queued and nothing is reported as delivered", async () => {
  const h = await harness();
  await h.monitor.beat();
  const result = await h.monitor.deliver();
  assert.equal(result.code, "notifier_not_configured");
  assert.equal(result.delivered, 0);
  const status = await h.monitor.status();
  assert.equal(status.connection, "never_connected");
  assert.equal(status.queue.pending, 1);
  h.database.close();
});

test("missed beats and an absent integration are detected as disconnected, not as success", async () => {
  const h = await harness();
  await h.monitor.beat();
  assert.equal((await h.monitor.status()).connection, "never_connected");
  h.clock.value += 60_000 * 5;
  const second = await h.monitor.beat();
  assert.ok(second.state.missedBeats >= 3);
  assert.equal(second.connection, "disconnected");

  // Let the integration reconnect, then let it go stale again.
  h.clock.value += 60_000;
  const reconnected = await h.monitor.reconnect({ clientId: "gw-test" });
  assert.equal(reconnected.trigger, TRIGGER_MESSAGE);
  assert.equal(reconnected.connection, "connected");
  // The loop keeps beating; the integration is the thing that goes quiet.
  for (let i = 0; i < 11; i += 1) {
    h.clock.value += 60_000;
    await h.monitor.beat();
  }
  assert.equal((await h.monitor.status()).connection, "stale");
  h.database.close();
});

test("reconnect restores context: status, active, completed, failures, approvals and queued changes", async () => {
  const team = [
    mission({ id: "msn_active", status: "running" }),
    mission({ id: "msn_done", status: "completed", approvals: [] }),
    mission({ id: "msn_failed", status: "failed", tasks: [{ id: "t", status: "failed" }] }),
    mission({ id: "msn_approval", status: "approval_required", approvals: [{ reason: "deploy", status: "pending" }] })
  ];
  const h = await harness({ team });
  await h.monitor.beat();
  const payload = await h.monitor.reconnect({ clientId: "gw-chatgpt" });
  assert.equal(payload.trigger, TRIGGER_MESSAGE);
  assert.equal(payload.delivery.received, true);
  assert.equal(payload.delivery.executed, false);
  assert.deepEqual(payload.missions.active.map(item => item.id), ["msn_active", "msn_approval"]);
  assert.deepEqual(payload.missions.completed.map(item => item.id), ["msn_done"]);
  assert.deepEqual(payload.missions.failures.map(item => item.id), ["msn_failed"]);
  assert.equal(payload.missions.approvals[0].missionId, "msn_approval");
  assert.ok(payload.missions.pendingTasks.length >= 1);
  assert.ok(payload.changes.events.length >= 1);
  assert.ok(payload.queued.length >= 1);
  assert.equal(payload.habitat.version, "0.8.6");
  h.database.close();
});

test("acknowledgement is idempotent and separates delivered from acknowledged", async () => {
  const notifier = fakeNotifier();
  const h = await harness({ notifier });
  await h.monitor.beat();
  await h.monitor.deliver();
  const events = await h.repository.listEvents({});
  const ids = events.map(event => event.id);
  const first = await h.monitor.acknowledge(ids);
  assert.equal(first.acknowledged, 1);
  assert.equal(first.duplicate, false);
  const second = await h.monitor.acknowledge(ids);
  assert.equal(second.acknowledged, 0);
  assert.equal(second.duplicate, true);
  const after = await h.repository.listEvents({});
  assert.equal(after[0].status, "acknowledged");
  assert.ok(after[0].acknowledgedAt);
  h.database.close();
});

test("delivery recovers after an outage without losing the queued event", async () => {
  const notifier = fakeNotifier({ failures: 2 });
  const h = await harness({ notifier, maxAttempts: 3 });
  await h.monitor.beat();
  assert.equal((await h.monitor.deliver()).failed, 1);
  assert.equal((await h.monitor.status()).connection, "delivery_failing");
  h.clock.value += 60_000;
  assert.equal((await h.monitor.deliver()).failed, 1);
  h.clock.value += 60_000;
  const recovered = await h.monitor.deliver();
  assert.equal(recovered.delivered, 1);
  const events = await h.repository.listEvents({});
  assert.equal(events[0].status, "delivered");
  assert.equal(events[0].attempts, 3);
  h.database.close();
});

test("snapshot summarisation never invents completion or turns a claim into a verified result", () => {
  const summary = summarizeSnapshot([
    mission({ id: "a", status: "planned" }),
    mission({ id: "b", status: "completed" })
  ]);
  assert.equal(summary.activeMissions.length, 1);
  assert.equal(summary.completedWork.length, 1);
  assert.equal(summary.failures.length, 0);
});
