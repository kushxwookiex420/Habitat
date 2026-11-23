import test from "node:test";
import assert from "node:assert/strict";
import { createAxDiagnostics } from "../ax-diagnostics.mjs";

/**
 * Diagnostics must report probe results, never configuration guesses, and must never return a secret.
 */

const quietPresence = {
  presence: async () => ({
    executor: { configured: true, started: true, state: "running" },
    heartbeat: { verified: true, liveWorkers: 1, lastHeartbeatAgeSeconds: 4 },
    queue: { ok: true, waiting: 0, claimed: 0, stale: 0 },
    canExecute: true
  })
};

function build(overrides = {}) {
  return createAxDiagnostics({
    env: {},
    version: "0.5.0",
    project: "habitat",
    engine: { async get() { return { ok: false, code: "not_found" }; } },
    memory: { async stats() { return { active: 3, deleted: 1, byKind: { decision: 2, claim: 1 } }; } },
    notifications: { async stats() { return { ok: true, byStatus: { recorded: 2 }, total: 2 }; } },
    providerConfig: {
      enabled: true,
      code: null,
      primary: { name: "openai", model: "gpt-6-luna", configured: true },
      fallbacks: [{ name: "gemini", model: "gemini-2.5-flash", configured: false }],
      summary: [
        { name: "openai", model: "gpt-6-luna", configured: true },
        { name: "gemini", model: "gemini-2.5-flash", configured: false }
      ]
    },
    orchestrator: { enabled: true, code: null, model: "gpt-6-luna", budgetUsd: 0.05, adapters: ["runtime.health"] },
    presence: quietPresence,
    deviceBridge: { ready: true, durable: true, axTokenConfigured: true, perDeviceTokens: true },
    sandbox: async () => ({ available: false, reason: "namespace probe failed", missing: ["unprivileged user namespaces"] }),
    ...overrides
  });
}

test("probes report reachable, available and unchecked honestly", async () => {
  const diagnostics = await build()();
  assert.equal(diagnostics.database.status, "reachable");
  assert.equal(diagnostics.memory.status, "available");
  assert.equal(diagnostics.memory.active, 3);
  assert.equal(diagnostics.notifications.status, "recorded_only");
  assert.equal(diagnostics.notifications.externalTransport, false);
  assert.equal(diagnostics.scheduler.started, true);
  assert.equal(diagnostics.workers.detail.heartbeat.liveWorkers, 1);
  assert.equal(diagnostics.sandbox.status, "unavailable");
  assert.deepEqual(diagnostics.sandbox.missing, ["unprivileged user namespaces"]);
  assert.equal(diagnostics.deviceBridge.ready, true);

  // A configured provider is not a tested provider.
  assert.equal(diagnostics.providers.primary.configured, true);
  assert.equal(diagnostics.providers.health.checked, false);
  assert.match(diagnostics.providers.health.note, /does not prove/);
  assert.equal(diagnostics.orchestrator.enabled, true);
  assert.equal(diagnostics.secretsExposed, false);
});

test("no environment secret or credential shape can appear in the report", async () => {
  const env = {
    OPENAI_API_KEY: "sk-" + "a".repeat(40),
    GEMINI_API_KEY: "gemini-secret-" + "b".repeat(20),
    HABITAT_D1_API_TOKEN: "d1-" + "c".repeat(30),
    HABITAT_AX_BRIDGE_TOKEN: "bridge-" + "d".repeat(30),
    HABITAT_OWNER_DEVICE_IDS: "device-secret",
    HABITAT_COMMIT_SHA: "abc123<script>"
  };
  const diagnostics = await build({ env })();
  const serialized = JSON.stringify(diagnostics);
  for (const secret of Object.values(env)) {
    if (secret === env.HABITAT_COMMIT_SHA) continue;
    assert.equal(serialized.includes(secret), false, "must not leak " + secret.slice(0, 6));
  }
  assert.doesNotMatch(serialized, /<script>/);
  assert.equal(diagnostics.application.commit, "abc123script");
});

test("one failing probe degrades only its own section", async () => {
  const diagnostics = await build({
    memory: { async stats() { throw new Error("D1 unreachable"); } },
    notifications: { async stats() { throw new Error("D1 unreachable"); } }
  })();
  assert.equal(diagnostics.memory.status, "unavailable");
  assert.equal(diagnostics.memory.detail, "D1 unreachable");
  assert.equal(diagnostics.notifications.status, "unavailable");
  assert.equal(diagnostics.database.status, "reachable");
  assert.equal(diagnostics.providers.enabled, true);
});

test("missing subsystems are reported as not configured, not as healthy", async () => {
  const diagnostics = await build({
    engine: null,
    memory: null,
    notifications: null,
    presence: null,
    deviceBridge: null,
    sandbox: null,
    providerConfig: null,
    orchestrator: null
  })();
  assert.equal(diagnostics.database.status, "not_configured");
  assert.equal(diagnostics.memory.status, "not_configured");
  assert.equal(diagnostics.notifications.status, "not_configured");
  assert.equal(diagnostics.providers.enabled, false);
  assert.equal(diagnostics.providers.health.checked, false);
  assert.equal(diagnostics.orchestrator.code, "orchestrator_not_mounted");
  assert.equal(diagnostics.sandbox.status, "unchecked");
  assert.equal(diagnostics.deviceBridge.status, "not_configured");
  assert.equal(diagnostics.scheduler.mounted, false);
});
