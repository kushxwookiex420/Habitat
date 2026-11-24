import test from "node:test";
import assert from "node:assert/strict";
import {
  createFailureEscalator,
  failureEscalationBody,
  failureEscalationKey
} from "../ax-failure-escalation.mjs";

/** A channel that mirrors the real one: one stored message per (from, idempotencyKey). */
function memoryChannel({ failTimes = 0, failCode = "message_store_unavailable", throwTimes = 0 } = {}) {
  const stored = new Map();
  const calls = [];
  let failures = failTimes;
  let throws = throwTimes;
  return {
    stored,
    calls,
    async submit(payload) {
      calls.push(structuredClone(payload));
      if (throws > 0) {
        throws -= 1;
        throw new Error("synthetic socket hang up");
      }
      if (failures > 0) {
        failures -= 1;
        return { ok: false, code: failCode, error: "synthetic store failure" };
      }
      const key = String(payload.from) + ":" + String(payload.idempotencyKey);
      if (stored.has(key)) {
        return { ok: true, replayed: true, message: { id: stored.get(key).id } };
      }
      const message = { id: "msg_" + (stored.size + 1), ...structuredClone(payload) };
      stored.set(key, message);
      return { ok: true, replayed: false, message: { id: message.id } };
    }
  };
}

const failure = {
  taskId: "cmd_failed_1",
  objective: "Repair the staging bridge",
  error: "adapter failed: connection reset by peer",
  attempts: 3,
  at: "2026-11-24T06:00:00.000Z"
};

test("a terminal failure becomes one durable Ax message with the fields Ax needs to triage", async () => {
  const channel = memoryChannel();
  const escalate = createFailureEscalator({ channel, sleep: async () => {} });

  const result = await escalate(failure);
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(channel.stored.size, 1);

  const message = [...channel.stored.values()][0];
  assert.equal(message.kind, "note", "kinds are limited to task, question and note");
  assert.equal(message.from, "nexus", "the channel only accepts an ax or nexus origin");
  assert.equal(message.correlationId, "task:cmd_failed_1");
  assert.match(message.body, /cmd_failed_1/);
  assert.match(message.body, /Repair the staging bridge/);
  assert.match(message.body, /connection reset by peer/);
  assert.match(message.body, /Attempts: 3/);
  assert.match(message.body, /2026-11-24T06:00:00.000Z/);
});

test("the same failure escalated twice produces one message, not two", async () => {
  const channel = memoryChannel();
  const escalate = createFailureEscalator({ channel, sleep: async () => {} });

  const first = await escalate(failure);
  const second = await escalate(failure);

  assert.equal(first.delivered, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true, "the second call is a replay of the same message id");
  assert.equal(second.delivered, false);
  assert.equal(channel.stored.size, 1, "the sink holds exactly one message");
  assert.equal(channel.calls[0].idempotencyKey, channel.calls[1].idempotencyKey);
});

test("a retried task that fails again is a new failure and is reported again", async () => {
  const channel = memoryChannel();
  const escalate = createFailureEscalator({ channel, sleep: async () => {} });

  await escalate({ ...failure, attempts: 1 });
  await escalate({ ...failure, attempts: 2 });

  assert.equal(channel.stored.size, 2, "a distinct attempt count is a distinct failure");
  assert.equal(failureEscalationKey({ taskId: "t", attempts: 1 }) !== failureEscalationKey({ taskId: "t", attempts: 2 }), true);
});

test("a transient sink failure is retried and then delivered", async () => {
  const channel = memoryChannel({ failTimes: 2 });
  const slept = [];
  const escalate = createFailureEscalator({ channel, retries: 2, retryDelayMs: 10, sleep: async (ms) => { slept.push(ms); } });

  const result = await escalate(failure);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3, "two failures then a success");
  assert.deepEqual(slept, [10, 20], "backoff grows between attempts");
  assert.equal(channel.stored.size, 1);
});

test("a throwing sink is retried and never escapes the escalator", async () => {
  const channel = memoryChannel({ throwTimes: 1 });
  const escalate = createFailureEscalator({ channel, retries: 1, sleep: async () => {} });

  const result = await escalate(failure);
  assert.equal(result.ok, true);
  assert.equal(channel.calls.length, 2);
});

test("a dead sink reports not delivered instead of throwing, after bounded attempts", async () => {
  const channel = memoryChannel({ failTimes: 99 });
  const escalate = createFailureEscalator({ channel, retries: 2, sleep: async () => {} });

  const result = await escalate(failure);
  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  assert.equal(result.code, "message_store_unavailable");
  assert.equal(channel.calls.length, 3, "one attempt plus two retries");
});

test("a permanent refusal is not retried", async () => {
  const channel = memoryChannel({ failTimes: 99, failCode: "invalid_kind" });
  const escalate = createFailureEscalator({ channel, retries: 3, sleep: async () => {} });

  const result = await escalate(failure);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_kind");
  assert.equal(channel.calls.length, 1, "a refusal the sink will never accept is not repeated");
});

test("no message store is reported, not retried, and does not throw", async () => {
  const escalate = createFailureEscalator({ channel: null, log: { warn() {} } });
  const result = await escalate(failure);
  assert.equal(result.ok, false);
  assert.equal(result.code, "message_store_unavailable");
});

test("an escalation without a task id is refused before touching the sink", async () => {
  const channel = memoryChannel();
  const escalate = createFailureEscalator({ channel, sleep: async () => {} });
  const result = await escalate({ error: "no task" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_task");
  assert.equal(channel.calls.length, 0);
});

test("the message body is bounded and survives missing optional fields", () => {
  const body = failureEscalationBody({ taskId: "t1", error: "x".repeat(5000) });
  assert.ok(body.length <= 1800);
  assert.match(body, /Task: t1/);
  assert.doesNotMatch(body, /Objective:/, "no objective line when the task has none");

  const minimal = failureEscalationBody({});
  assert.match(minimal, /Task: unknown/);
  assert.match(minimal, /Reason: no reason recorded/);
});
