import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEVICE_COMMANDS, validateDeviceCommand } from "../device-commands.mjs";
import { buildWorkerDetail } from "../worker-catalog.mjs";

const bridge = await readFile(new URL("../device-command-bridge.mjs", import.meta.url), "utf8");
const android = await readFile(new URL("../app/src/main/java/com/habitat/AndroidDeviceBridge.kt", import.meta.url), "utf8");
const brain = await readFile(new URL("../app/src/main/java/com/habitat/BrainAdapter.kt", import.meta.url), "utf8");

test("every command the phone handles exists in the server allowlist", () => {
  const handled = [...android.matchAll(/"device\.[a-z]+"/g)].map((match) => match[0].replaceAll('"', ""));
  const phoneCommands = [...new Set(handled)].filter((name) => name !== "device.heartbeat");
  assert.deepEqual(phoneCommands.sort(), Object.keys(DEVICE_COMMANDS).sort());
});

test("the payload keys the phone reads are the keys the validator accepts", () => {
  assert.equal(validateDeviceCommand("device.tap", { x: 1, y: 2 }).ok, true);
  assert.equal(validateDeviceCommand("device.swipe", { x1: 0, y1: 0, x2: 100, y2: 100, durationMs: 300 }).ok, true);
  assert.equal(validateDeviceCommand("device.type", { text: "hi" }).ok, true);
  for (const key of ["x", "y", "x1", "y1", "x2", "y2", "durationMs", "text", "name"]) {
    assert.equal(android.includes(`"${key}"`), true, "phone reads payload key " + key);
  }
  // Enter is rejected by both sides: the SDK has no AccessibilityService IME action.
  assert.equal(android.includes("sendImeEnter"), false);
  assert.equal(validateDeviceCommand("device.key", { name: "enter" }).ok, false);
  for (const name of ["back", "home", "recents"]) {
    assert.equal(validateDeviceCommand("device.key", { name }).ok, true);
  }
});

test("the screenshot endpoint and limits agree on both sides", () => {
  assert.equal(bridge.includes('app.post("/device/screenshots"'), true);
  assert.equal(bridge.includes("SCREENSHOT_MAX_BYTES"), true);
  assert.equal(android.includes('"/device/screenshots"'), true);
  assert.equal(android.includes('put("mime", "image/jpeg")'), true);
});

test("the worker fields the phone renders are the fields the catalog emits", () => {
  const detail = buildWorkerDetail({
    worker: { id: "habitat-qa-worker", name: "QA", kind: "model-backed", status: "available", capabilities: ["backend-health"] },
    tasks: [{
      id: "task-1", title: "System Check", status: "blocked", worker: "habitat-qa-worker",
      createdAt: "2026-11-23T05:00:00.000Z", error: null,
      result: JSON.stringify({ verification: { androidHeartbeat: "FAIL" }, blockedReason: "androidHeartbeat: no check-in" })
    }]
  });
  for (const field of ["status", "blockedReason", "capabilities", "runtime", "jobs", "logs", "controls"]) {
    assert.equal(Object.hasOwn(detail, field), true, "catalog emits " + field);
    assert.equal(brain.includes(`"${field}"`), true, "phone reads " + field);
  }
  assert.equal(brain.includes('"retryTaskId"'), true);
  assert.equal(brain.includes('"/workers/"') || brain.includes("WORKERS_ENDPOINT"), true);
});
