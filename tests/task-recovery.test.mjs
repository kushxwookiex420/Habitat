import test from "node:test";
import assert from "node:assert/strict";
import { markInterruptedTask, prepareTaskRetry } from "../task-recovery.mjs";

test("startup marks active tasks interrupted without rerunning them", () => {
  const task = { id: "t1", status: "delegated", result: null };
  const result = markInterruptedTask(task, { now: () => "2026-10-09T18:00:00.000Z" });
  assert.equal(result.changed, true);
  assert.equal(task.status, "interrupted");
  assert.match(task.error, /review/i);
  assert.equal(task.interruptedAt, "2026-10-09T18:00:00.000Z");
});

test("terminal tasks are not changed by startup recovery", () => {
  for (const status of ["planned", "verified", "failed", "blocked"]) {
    const task = { id: "t2", status };
    const result = markInterruptedTask(task);
    assert.equal(result.changed, false);
    assert.equal(task.status, status);
  }
});

test("only interrupted or failed tasks can be explicitly retried and prior attempt is retained", () => {
  const task = {
    id: "t3", status: "interrupted", error: "worker stopped",
    result: "partial output", interruptedAt: "2026-10-09T17:00:00.000Z"
  };
  const result = prepareTaskRetry(task, { now: () => "2026-10-09T18:00:00.000Z" });
  assert.equal(result.allowed, true);
  assert.equal(task.status, "planned");
  assert.equal(task.error, null);
  assert.equal(task.result, null);
  assert.equal(task.attemptHistory.length, 1);
  assert.equal(task.attemptHistory[0].result, "partial output");
  assert.equal(task.updatedAt, "2026-10-09T18:00:00.000Z");
});

test("verified tasks cannot be retried", () => {
  const task = { id: "t4", status: "verified" };
  const result = prepareTaskRetry(task);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "task_not_retryable");
  assert.equal(task.status, "verified");
});
