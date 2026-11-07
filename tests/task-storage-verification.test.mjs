import test from "node:test";
import assert from "node:assert/strict";
import { verifyTaskStorage } from "../task-storage-verification.mjs";

test("memory-only task storage is UNKNOWN, never PASS", async () => {
  const result = await verifyTaskStorage({ taskRepository: null, taskStorageReady: false });
  assert.equal(result.status, "UNKNOWN");
  assert.match(result.detail, /in-memory.*not evidence/i);
});

test("durable task storage passes only when health and durability are confirmed", async () => {
  const result = await verifyTaskStorage({
    taskStorageReady: true,
    taskRepository: { async healthCheck() { return { ok: true, durable: true }; } }
  });
  assert.equal(result.status, "PASS");
});

test("task storage fails closed when health check does not confirm durability", async () => {
  const result = await verifyTaskStorage({
    taskStorageReady: true,
    taskRepository: { async healthCheck() { return { ok: true, durable: false }; } }
  });
  assert.equal(result.status, "FAIL");
});

test("task storage fails closed when durable health check throws", async () => {
  const result = await verifyTaskStorage({
    taskStorageReady: true,
    taskRepository: { async healthCheck() { throw new Error("database unavailable"); } }
  });
  assert.equal(result.status, "FAIL");
});
