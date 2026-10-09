import test from "node:test";
import assert from "node:assert/strict";
import { claimTaskDispatch } from "../task-dispatch-guard.mjs";

test("only the first request can claim a planned task", () => {
  const task = { id: "t-1", status: "planned", result: "old" };
  const now = () => "2026-10-09T18:00:00.000Z";
  const first = claimTaskDispatch(task, { now });
  const second = claimTaskDispatch(task, { now });

  assert.equal(first.claimed, true);
  assert.equal(task.status, "delegated");
  assert.equal(task.delegatedAt, "2026-10-09T18:00:00.000Z");
  assert.equal(task.result, null);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "dispatch_already_in_progress");
});

test("completed or blocked tasks are never silently dispatched again", () => {
  for (const status of ["verified", "blocked", "failed", "completed"]) {
    const task = { id: "t-2", status };
    const result = claimTaskDispatch(task);
    assert.equal(result.claimed, false, status);
    assert.equal(task.status, status);
  }
});

test("invalid task input is rejected", () => {
  assert.throws(() => claimTaskDispatch(null), /task record is required/i);
});
