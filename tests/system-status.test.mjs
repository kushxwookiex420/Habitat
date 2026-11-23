import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemStatus,
  classifyWorkers,
  formatSystemStatus,
  inferReadOnlyAdapter,
  isSystemStatusRequest,
  parseAxCommand,
  summarizeWorkerCounts
} from "../system-status.mjs";

/**
 * These tests pin the honesty rules, not just the shape:
 *   - registration is never health;
 *   - a run outside the health window is unverified, not healthy;
 *   - environment values never appear in the result;
 *   - "ask ax system status" is a status intent, and "ask ax to …" is a command intent.
 */

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-11-23T20:00:00.000Z");

const registry = new Map([
  ["habitat-qa-worker", { id: "habitat-qa-worker", name: "Habitat QA Worker", kind: "model-backed", status: "available", model: "openrouter/free", capabilities: ["backend-health"] }],
  ["dropilot-product-scout", { id: "dropilot-product-scout", name: "DropPilot Product Scout", kind: "specialist", status: "available", capabilities: ["product-research"] }],
  ["vicecity-topic-scout", { id: "vicecity-topic-scout", name: "Vice City Topic Scout", kind: "specialist", status: "blocked", capabilities: ["topic-research"] }]
]);

const missingExecution = { configured: false, reason: "disabled_by_config" };

function statusFor({ tasks = [], env = {}, execution = missingExecution, deviceBridge = {}, devicePresence = {} } = {}) {
  return buildSystemStatus({
    env,
    now: NOW,
    version: "0.5.0",
    commit: "0d5eb6e4ab2eb62ee044f2b7708af8a1c250b788",
    startedAtMs: NOW - 5 * MINUTE,
    latencyMs: 4,
    registry,
    tasks,
    deviceBridge: { durable: true, axTokenConfigured: true, perDeviceTokens: true, nexus: execution, ...deviceBridge },
    devicePresence,
    storage: { taskRepositoryReady: true, contentJobRepositoryReady: true, dispatchLeaseReady: true, secretVaultReady: true },
    providers: { groq: true, gemini: true, openrouter: true, cerebras: false, cloudflare: false },
    routes: { chat: true, deviceCommands: true, axCommand: true, nexusRuntime: execution.configured === true },
    execution
  });
}

test("registered workers with no tasks are idle, never healthy", () => {
  const items = classifyWorkers({ registry, tasks: [], now: NOW });
  assert.equal(items.length, 3);
  assert.deepEqual(summarizeWorkerCounts(items), {
    registered: 3,
    running: 0,
    healthy: 0,
    unavailable: 1,
    idle: 2,
    unverified: 0
  });
});

test("a running task makes a worker running, not healthy", () => {
  const items = classifyWorkers({
    registry,
    tasks: [{ worker: "habitat-qa-worker", status: "delegated", createdAt: new Date(NOW - MINUTE).toISOString() }],
    now: NOW
  });
  const qa = items.find(item => item.id === "habitat-qa-worker");
  assert.equal(qa.state, "running");
  assert.equal(qa.healthy, false);
  assert.equal(qa.running, 1);
});

test("only a recent verified run counts as healthy", () => {
  const recent = classifyWorkers({
    registry,
    tasks: [{ worker: "habitat-qa-worker", status: "verified", verifiedAt: new Date(NOW - 2 * MINUTE).toISOString() }],
    now: NOW
  }).find(item => item.id === "habitat-qa-worker");
  assert.equal(recent.state, "healthy");
  assert.equal(recent.healthy, true);

  const stale = classifyWorkers({
    registry,
    tasks: [{ worker: "habitat-qa-worker", status: "verified", verifiedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() }],
    now: NOW
  }).find(item => item.id === "habitat-qa-worker");
  assert.equal(stale.state, "unverified");
  assert.equal(stale.healthy, false);
});

test("a blocked registry entry is unavailable regardless of history", () => {
  const items = classifyWorkers({
    registry,
    tasks: [{ worker: "vicecity-topic-scout", status: "verified", verifiedAt: new Date(NOW - MINUTE).toISOString() }],
    now: NOW
  });
  const blocked = items.find(item => item.id === "vicecity-topic-scout");
  assert.equal(blocked.state, "unavailable");
  assert.equal(blocked.healthy, false);
  assert.equal(blocked.configured, false);
});

test("status never contains environment values", () => {
  const secrets = {
    HABITAT_AX_BRIDGE_TOKEN: "ax_secret_value_should_not_leak",
    HABITAT_D1_API_TOKEN: "d1_secret_value_should_not_leak",
    HOME_BRIDGE_AX_TOKEN: "relay_secret_value_should_not_leak",
    GROQ_API_KEY: "groq_secret_value_should_not_leak"
  };
  const status = statusFor({ env: secrets });
  const serialized = JSON.stringify(status);
  for (const value of Object.values(secrets)) {
    assert.equal(serialized.includes(value), false, "secret value leaked into status");
  }
  assert.equal(status.secretsExposed, false);
  // Public payload: missing key *names* only. No per-key configured map and never a value.
  assert.equal(status.requiredConfiguration.keys, undefined);
  assert.equal(status.requiredConfiguration.allPresent, false);
  assert.equal(status.requiredConfiguration.missing.includes("NEXUS_RUNTIME_ENABLED"), true);
  assert.equal(status.requiredConfiguration.missing.includes("HABITAT_AX_BRIDGE_TOKEN"), false);
});

test("a disabled executor is reported as unable to execute", () => {
  const status = statusFor({ env: { HABITAT_AX_BRIDGE_TOKEN: "set", NEXUS_RUNTIME_ENABLED: "" } });
  const execution = status.components.workers.execution;
  assert.equal(execution.configured, false);
  assert.equal(execution.canExecute, false);
  assert.equal(execution.state, "unavailable");
  assert.match(execution.detail, /will not run/i);
  assert.equal(status.components.workers.counts.healthy, 0);
});

test("a started but heartbeat-less executor is not execution", () => {
  const status = statusFor({
    execution: {
      configured: true,
      started: true,
      canExecute: false,
      heartbeat: { verified: false, liveWorkers: 0 },
      queue: { queued: 2, claimed: 0 }
    }
  });
  const execution = status.components.workers.execution;
  assert.equal(execution.state, "started_unverified");
  assert.equal(execution.canExecute, false);
  assert.match(execution.detail, /not proven/i);
});

test("the human report states the real counts and the limit of the check", () => {
  const status = statusFor({ devicePresence: { paired: 2, recentlySeen: true, lastSeenAt: "2026-11-23T19:59:00.000Z" } });
  const report = formatSystemStatus(status);
  assert.match(report, /^AX SYSTEM STATUS/);
  assert.match(report, /Workers: 3 registered \/ 0 running \/ 0 healthy \/ 1 unavailable \/ 2 idle \/ 0 unverified/);
  assert.match(report, /Execution: UNAVAILABLE/);
  assert.match(report, /Device: ONLINE — 2 paired/);
  assert.match(report, /Not verified here/);
  assert.match(report, /secretsExposed: false/);
});

test("status intent recognises the phone phrasing but not a bare status or a system check", () => {
  for (const message of [
    "ask ax system status",
    "system status",
    "ax system status",
    "what is the system status",
    "show backend status",
    "backend status report"
  ]) {
    assert.equal(isSystemStatusRequest(message), true, message);
  }
  for (const message of [
    "status",
    "are you online",
    "create a system check",
    "ask ax to check the workers",
    "hello"
  ]) {
    assert.equal(isSystemStatusRequest(message), false, message);
  }
});

test("Ax command intent is explicit and bounded", () => {
  assert.equal(parseAxCommand("ax: inspect the repository state"), "inspect the repository state");
  assert.equal(parseAxCommand("ask ax to check the workers"), "check the workers");
  assert.equal(parseAxCommand("ax run verify the backend"), "run verify the backend");
  assert.equal(parseAxCommand("ask ax system status"), null);
  assert.equal(parseAxCommand("hello there"), null);
  assert.equal(parseAxCommand("ax: short"), null);
  assert.equal(parseAxCommand("ax: " + "x".repeat(2001)), null);
});

test("only allowlisted read-only adapters are inferred", () => {
  assert.equal(inferReadOnlyAdapter("inspect the repository state"), "repo.inspect");
  assert.equal(inferReadOnlyAdapter("list the task queue"), "task.inspect");
  assert.equal(inferReadOnlyAdapter("check the worker health"), "runtime.health");
  assert.equal(inferReadOnlyAdapter("order a pizza"), null);
  assert.equal(inferReadOnlyAdapter(""), null);
});

test("status exposes no task content, device identifiers or worker internals", () => {
  const status = buildSystemStatus({
    env: { HABITAT_AX_BRIDGE_TOKEN: "set", NEXUS_RUNTIME_ENABLED: "false" },
    now: NOW,
    version: "0.5.0",
    commit: "0d5eb6e4ab2eb62ee044f2b7708af8a1c250b788",
    startedAtMs: NOW - MINUTE,
    latencyMs: 3,
    registry,
    tasks: [{
      worker: "habitat-qa-worker",
      status: "verified",
      verifiedAt: new Date(NOW - MINUTE).toISOString(),
      title: "private task title",
      objective: "private objective text",
      result: "private result body"
    }],
    deviceBridge: { durable: true, axTokenConfigured: true, perDeviceTokens: true, nexus: missingExecution },
    devicePresence: {
      paired: 1,
      recentlySeen: true,
      lastSeenAt: "2026-11-23T19:59:00.000Z",
      deviceId: "dev_private_identifier",
      name: "Owner Pixel",
      details: { manufacturer: "Google", model: "Pixel 9" }
    },
    storage: { taskRepositoryReady: true, contentJobRepositoryReady: true, dispatchLeaseReady: true, secretVaultReady: true },
    providers: { groq: true },
    routes: { chat: true, deviceCommands: true, axCommand: true, nexusRuntime: false },
    execution: missingExecution
  });

  const serialized = JSON.stringify(status);
  for (const privateValue of [
    "private task title",
    "private objective text",
    "private result body",
    "dev_private_identifier",
    "Owner Pixel",
    "Pixel 9"
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue + " leaked into status");
  }

  // Coarse presence is public; exact check-in time and identifiers are not.
  assert.equal(status.components.device.lastSeenAt, undefined);
  assert.equal(status.components.device.deviceId, undefined);
  assert.equal(status.components.device.paired, 1);

  const worker = status.components.workers.items[0];
  for (const field of ["capabilities", "model", "lastRunAt", "lastStatus"]) {
    assert.equal(field in worker, false, field + " must not be public");
  }
  assert.equal(status.redaction.applied, true);
  assert.equal(status.secretsExposed, false);
});
