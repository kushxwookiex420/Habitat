import test from "node:test";
import assert from "node:assert/strict";
import {
  auditPairingLifecycle,
  capabilityManifest,
  deriveDeviceState,
  pairingGuidance,
  DEVICE_STATE_KEYS
} from "../ax-device-capabilities.mjs";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const minutesAgo = minutes => new Date(NOW - minutes * 60 * 1000).toISOString();

test("connection states are derived separately and never conflated", () => {
  const state = deriveDeviceState({
    device: { device_id: "phone-1", created_at: minutesAgo(600), last_seen_at: minutesAgo(0.5), revoked_at: null },
    now: NOW
  });
  assert.deepEqual(Object.keys(state.states), DEVICE_STATE_KEYS.slice());
  assert.equal(state.states.installed.value, "unknown", "the backend cannot see installation");
  assert.equal(state.states.registered.value, "yes");
  assert.equal(state.states.authenticated.value, "yes");
  assert.equal(state.states.connected.value, "yes");
  assert.equal(state.states.reachable.value, "yes");
  assert.equal(state.states.commandAccepted.value, "unknown");
  assert.equal(state.states.commandExecuted.value, "unknown");
  assert.equal(state.states.commandVerified.value, "unknown");
});

test("a stale device is registered but not connected", () => {
  const state = deriveDeviceState({
    device: { device_id: "phone-1", created_at: minutesAgo(600), last_seen_at: minutesAgo(10), revoked_at: null },
    now: NOW
  });
  assert.equal(state.states.registered.value, "yes");
  assert.equal(state.states.authenticated.value, "yes");
  assert.equal(state.states.connected.value, "no");
  assert.equal(state.states.reachable.value, "yes");
  assert.match(state.states.connected.basis, /last check-in 600s/);
});

test("a revoked device is not registered or authenticated and offers no capability", () => {
  const device = { device_id: "phone-1", created_at: minutesAgo(600), last_seen_at: minutesAgo(1), revoked_at: minutesAgo(0.2) };
  const state = deriveDeviceState({ device, now: NOW });
  assert.equal(state.revoked, true);
  assert.equal(state.states.registered.value, "no");
  assert.equal(state.states.authenticated.value, "no");
  const capabilities = capabilityManifest({ device });
  assert.ok(capabilities.every(item => item.available === false));
  assert.ok(capabilities.filter(item => item.implemented).every(item => item.blockedReason === "device_revoked"));
});

test("command states come from receipts and verification needs a checked result", () => {
  const base = { device: { device_id: "phone-1", last_seen_at: minutesAgo(0.5), revoked_at: null }, now: NOW };
  const accepted = deriveDeviceState({ ...base, commands: [{ id: "c1", status: "queued" }] });
  assert.equal(accepted.states.commandAccepted.value, "yes");
  assert.equal(accepted.states.commandExecuted.value, "no");
  assert.equal(accepted.states.commandVerified.value, "unknown");

  const completed = deriveDeviceState({ ...base, commands: [{ id: "c1", status: "completed", result: { ok: true, summary: "online" } }] });
  assert.equal(completed.states.commandExecuted.value, "yes");
  assert.equal(completed.states.commandVerified.value, "unknown", "a completion is not an independent verification");

  const checked = deriveDeviceState({ ...base, commands: [{ id: "c1", status: "completed", result: { ok: true, verified: true } }] });
  assert.equal(checked.states.commandVerified.value, "yes");
});

test("no device reports no registration without pretending otherwise", () => {
  const state = deriveDeviceState({ now: NOW });
  assert.equal(state.states.registered.value, "no");
  assert.equal(state.states.authenticated.value, "unknown");
  assert.equal(state.states.connected.value, "unknown");
  assert.equal(state.states.reachable.value, "unknown");
  assert.equal(state.capabilities.every(item => item.available === false), true);
  assert.equal(state.capabilities.find(item => item.id === "device.status").blockedReason, "no_paired_device");
});

test("the capability manifest marks unimplemented phone actions honestly", () => {
  const manifest = capabilityManifest({ device: { device_id: "phone-1" } });
  const shell = manifest.find(item => item.id === "device.shell");
  assert.equal(shell.implemented, false);
  assert.equal(shell.requiresApproval, true);
  assert.equal(shell.available, false);
  assert.equal(shell.blockedReason, "not_implemented");
  const status = manifest.find(item => item.id === "device.status");
  assert.equal(status.implemented, true);
  assert.equal(status.available, true);
});

test("pairing audits distinguish issued, expired, consumed and lost-response states", () => {
  const issued = auditPairingLifecycle({
    pairing: { device_id: "*", expires_at: minutesAgo(-5), consumed_at: null },
    now: NOW
  });
  assert.equal(issued.stage, "issued");
  assert.equal(issued.codeReturned, false);

  const expired = auditPairingLifecycle({
    pairing: { device_id: "*", expires_at: minutesAgo(1), consumed_at: null },
    now: NOW
  });
  assert.equal(expired.stage, "expired");
  assert.equal(expired.code, "pairing_expired");

  const consumed = auditPairingLifecycle({
    pairing: { device_id: "phone-1", expires_at: minutesAgo(-5), consumed_at: minutesAgo(1) },
    device: { device_id: "phone-1", last_seen_at: minutesAgo(0.5), revoked_at: null },
    now: NOW
  });
  assert.equal(consumed.stage, "consumed");
  assert.equal(consumed.replayRecovered, true);

  const lostResponse = auditPairingLifecycle({
    pairing: { device_id: "phone-1", expires_at: minutesAgo(-5), consumed_at: minutesAgo(1) },
    device: null,
    now: NOW
  });
  assert.equal(lostResponse.stage, "consumed_without_registration");
  assert.match(lostResponse.ownerAction, /Pair again/);

  const unknown = auditPairingLifecycle({ pairing: null, now: NOW });
  assert.equal(unknown.stage, "not_found");
  assert.match(pairingGuidance(unknown.code), /never issued/);
});
