import test from "node:test";
import assert from "node:assert/strict";
import { appendTaskEvidence } from "../task-evidence.mjs";

test("task evidence is timestamped and appended without changing task status", () => {
  const task = { id: "t1", status: "running", evidence: [] };
  const event = appendTaskEvidence(task, { type: "check-passed", source: "system", detail: "Backend health check returned ready." }, { now: () => "2026-10-12T07:00:00.000Z" });
  assert.equal(event.timestamp, "2026-10-12T07:00:00.000Z");
  assert.equal(task.evidence.length, 1);
  assert.equal(task.status, "running");
});

test("task evidence rejects empty, oversized, or unsupported entries", () => {
  const task = { id: "t2", status: "planned" };
  assert.throws(() => appendTaskEvidence(task, { detail: " " }), /required/);
  assert.throws(() => appendTaskEvidence(task, { type: "made-up", detail: "something" }), /Unsupported task evidence type/);
  assert.throws(() => appendTaskEvidence(task, { detail: "x".repeat(2001) }), /at most 2000/);
  assert.throws(() => appendTaskEvidence(task, { source: "unknown", detail: "something" }), /Unsupported evidence source/);
});

test("task evidence keeps a bounded recent history", () => {
  const task = { id: "t3", evidence: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) };
  appendTaskEvidence(task, { detail: "Latest verified event" });
  assert.equal(task.evidence.length, 100);
  assert.equal(task.evidence.at(-1).detail, "Latest verified event");
});
