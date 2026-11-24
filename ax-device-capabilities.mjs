/**
 * Phone capability manifest and connection-state derivation.
 *
 * The bridge's states are separated on purpose. A row in D1 proves a device *registered*; it does
 * not prove the app is installed, that its credential still authenticates, that it is connected right
 * now, that a command was accepted, that it executed, or that its output was independently checked.
 * Each state below therefore carries `value` of `yes`, `no` or `unknown` plus the basis for it, and
 * nothing promotes one state into another.
 *
 * Only `device.status` and the heartbeat are implemented today. Everything else is listed as
 * `implemented: false` with the permission and approval it would require, so Ax can reason about what
 * the phone cannot do instead of assuming a capability.
 */

export const DEVICE_STATE_KEYS = Object.freeze([
  "installed",
  "registered",
  "authenticated",
  "connected",
  "reachable",
  "commandAccepted",
  "commandExecuted",
  "commandVerified"
]);

export const DEVICE_RECEIPT_STATUSES = Object.freeze(["queued", "claimed", "completed", "failed", "expired"]);

export const PHONE_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "device.status",
    label: "Device status",
    implemented: true,
    permission: "device.status.read",
    requiresApproval: false,
    description: "Read-only device identity and OS details returned by the foreground phone agent."
  }),
  Object.freeze({
    id: "device.heartbeat",
    label: "Device heartbeat",
    implemented: true,
    permission: "device.status.read",
    requiresApproval: false,
    description: "Battery, charging and interactive state written at most once a minute."
  }),
  Object.freeze({
    id: "device.notifications.read",
    label: "Read notifications",
    implemented: false,
    permission: "android.notifications.read",
    requiresApproval: true,
    description: "Not implemented in the phone agent. Would require an explicit Android notification-listener grant."
  }),
  Object.freeze({
    id: "device.notifications.send",
    label: "Send notification",
    implemented: false,
    permission: "android.notifications.post",
    requiresApproval: true,
    description: "Not implemented. Would require the Android notification permission and an owner-approved command."
  }),
  Object.freeze({
    id: "device.shell",
    label: "Shell command",
    implemented: false,
    permission: "android.shell",
    requiresApproval: true,
    description: "Deliberately not implemented. The phone agent has no shell, file, messaging or UI automation path."
  })
]);

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function state(value, basis) {
  return { value, basis: clean(basis, 160) };
}

function deviceOf(input) {
  if (!input) return null;
  return {
    deviceId: input.device_id || input.deviceId || null,
    createdAt: input.created_at || input.createdAt || null,
    lastSeenAt: input.last_seen_at || input.lastSeenAt || null,
    revokedAt: input.revoked_at || input.revokedAt || null,
    info: (() => {
      if (!input.device_json) return input.deviceInfo || null;
      try { return JSON.parse(input.device_json); } catch { return null; }
    })()
  };
}

function ageMs(at, nowMs) {
  const parsed = Date.parse(at || "");
  return Number.isFinite(parsed) ? nowMs - parsed : null;
}

/**
 * Derive the eight states from durable rows. `commands` are optional command receipts; with none, the
 * three command states are `unknown` rather than assumed.
 */
export function deriveDeviceState({
  device = null,
  commands = [],
  now = Date.now(),
  connectedWithinMs = 2 * 60 * 1000,
  reachableWithinMs = 45 * 60 * 1000
} = {}) {
  const row = deviceOf(device);
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const receipts = (Array.isArray(commands) ? commands : []).filter(item => item && typeof item === "object");
  const revoked = Boolean(row?.revokedAt);
  const seenAge = row?.lastSeenAt ? ageMs(row.lastSeenAt, nowMs) : null;

  const accepted = receipts.filter(item => ["queued", "claimed", "completed"].includes(item.status));
  const executed = receipts.filter(item => item.status === "completed");
  const verified = receipts.filter(item => item.status === "completed" && item.result?.verified === true);

  return {
    deviceId: row?.deviceId || null,
    observedAt: new Date(nowMs).toISOString(),
    revoked,
    deviceInfo: row?.info || null,
    secondsSinceCheckIn: seenAge === null ? null : Math.max(0, Math.round(seenAge / 1000)),
    states: {
      // The server has no signal that can establish installation; claiming yes would be invention.
      installed: row || receipts.length ? state("unknown", "the backend cannot observe app installation") : state("unknown", "no registered device"),
      registered: row ? (revoked ? state("no", "device row is revoked") : state("yes", "device row present")) : state("no", "no device row"),
      authenticated: row
        ? revoked
          ? state("no", "credential revoked")
          : seenAge === null
            ? state("unknown", "no authenticated request recorded yet")
            : state("yes", "last authenticated request at " + row.lastSeenAt)
        : state("unknown", "no device registered"),
      connected: seenAge === null ? state("unknown", "no check-in recorded") : seenAge <= connectedWithinMs ? state("yes", "check-in within " + Math.round(connectedWithinMs / 1000) + "s") : state("no", "last check-in " + Math.round(seenAge / 1000) + "s ago"),
      reachable: seenAge === null ? state("unknown", "no check-in recorded") : seenAge <= reachableWithinMs ? state("yes", "check-in within " + Math.round(reachableWithinMs / 60000) + " min") : state("no", "no check-in for " + Math.round(seenAge / 60000) + " min"),
      commandAccepted: receipts.length === 0 ? state("unknown", "no command receipts") : accepted.length ? state("yes", accepted.length + " accepted receipt(s)") : state("no", "no accepted receipt"),
      commandExecuted: receipts.length === 0 ? state("unknown", "no command receipts") : executed.length ? state("yes", executed.length + " completed receipt(s)") : state("no", "no completed receipt"),
      commandVerified: receipts.length === 0 ? state("unknown", "no command receipts") : verified.length ? state("yes", verified.length + " receipt(s) carry a result") : state("unknown", "completions exist without an independent check")
    },
    capabilities: capabilityManifest({ device: row }),
    notes: [
      "A paired row is registration, not connectivity.",
      "A completed receipt is not an independent verification unless its result was checked.",
      "Installed is always unknown from the backend."
    ]
  };
}

/** What Ax may ask this phone to do, and what each operation would require. */
export function capabilityManifest({ device = null } = {}) {
  const row = deviceOf(device);
  const revoked = Boolean(row?.revokedAt);
  return PHONE_CAPABILITIES.map(capability => ({
    ...capability,
    available: capability.implemented && Boolean(row) && !revoked,
    blockedReason: !capability.implemented
      ? "not_implemented"
      : !row
        ? "no_paired_device"
        : revoked
          ? "device_revoked"
          : null
  }));
}

/**
 * Audit one pairing row. This is the server-side answer to "why did the phone not pair?" — it names
 * the stage and the owner action, without ever returning the code.
 */
export function auditPairingLifecycle({ pairing = null, device = null, now = Date.now() } = {}) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (!pairing) {
    return {
      stage: "not_found",
      code: "pairing_unknown",
      ownerAction: "Generate a fresh pairing code in the control center. The code must come from this service.",
      codeReturned: false
    };
  }
  const expiresAt = pairing.expires_at || pairing.expiresAt || null;
  const consumedAt = pairing.consumed_at || pairing.consumedAt || null;
  const boundDevice = pairing.device_id || pairing.deviceId || null;
  const row = deviceOf(device);
  const expired = expiresAt ? Date.parse(expiresAt) <= nowMs : false;

  if (consumedAt) {
    if (!row) {
      return {
        stage: "consumed_without_registration",
        code: "pairing_consumed_no_device",
        ownerAction: "The code was accepted but no device credential exists. Pair again; the app must retry the exchange.",
        codeReturned: false,
        risk: "a lost response, not a security failure"
      };
    }
    if (row.revokedAt) {
      return { stage: "consumed_revoked", code: "device_revoked", ownerAction: "Create a new pairing code; the previous credential was revoked.", codeReturned: false };
    }
    return {
      stage: "consumed",
      code: "paired",
      ownerAction: "Nothing. The device is registered; ask it to poll to confirm connectivity.",
      codeReturned: false,
      replayRecovered: true
    };
  }
  if (expired) {
    return { stage: "expired", code: "pairing_expired", ownerAction: "Generate a fresh code; expired codes are refused by design.", codeReturned: false };
  }
  return {
    stage: "issued",
    code: "awaiting_device",
    ownerAction: "Enter the code on the phone before it expires.",
    codeReturned: false,
    boundDevice,
    expiresAt
  };
}

/** Owner-facing guidance for the error codes the phone can receive, without exposing internals. */
export function pairingGuidance(code) {
  const map = {
    paired: "This phone is registered. Ask it to poll to confirm connectivity; registration is not a live connection.",
    awaiting_device: "The code is valid and waiting for this phone to exchange it.",
    pairing_unknown: "This code was never issued by this service. Create a new one.",
    pairing_expired: "This code expired. Create a new one.",
    pairing_used_other_device: "This code was already used by another device. Create a new one.",
    pairing_invalid: "The code does not match this phone. Create a new one.",
    device_revoked: "This phone was revoked. Create a new code to pair it again.",
    pairing_consumed_no_device: "The code was accepted but the credential was not stored. Retry the exchange."
  };
  return map[String(code || "")] || "Pairing did not complete. Create a fresh code and try again.";
}
