/**
 * The device command contract.
 *
 * This file is the single source of truth shared by the server allowlist, the tests and the Android
 * agent. Every command is either read-only or explicitly owner-approved: taps, text entry, gestures
 * and key events change the phone, so an enqueue request must carry `approved: true` before the
 * server will queue one. Validation is strict (unknown keys are rejected) because a silently ignored
 * payload field is how an agent ends up doing something the owner did not ask for.
 *
 * Coordinates are permille of the display (0–10000), never raw pixels, so the phone can map them to
 * whatever resolution and orientation it has.
 */

export const DEVICE_COMMANDS = Object.freeze({
  "device.status": Object.freeze({
    permission: "device.status.read",
    sensitive: false,
    description: "Read-only device identity, OS, battery and interactivity."
  }),
  "device.screen": Object.freeze({
    permission: "android.accessibility.read",
    sensitive: false,
    description: "Bounded accessibility snapshot of the visible screen (window and node text)."
  }),
  "device.screenshot": Object.freeze({
    permission: "android.screen.capture",
    sensitive: false,
    description: "One screenshot, uploaded by the phone and retained for 24 hours."
  }),
  "device.tap": Object.freeze({
    permission: "android.accessibility.tap",
    sensitive: true,
    description: "Tap one point. Requires owner approval at enqueue time."
  }),
  "device.swipe": Object.freeze({
    permission: "android.accessibility.swipe",
    sensitive: true,
    description: "Swipe between two points with a bounded duration."
  }),
  "device.type": Object.freeze({
    permission: "android.accessibility.type",
    sensitive: true,
    description: "Set text in the focused editable field. Never into a password field."
  }),
  "device.key": Object.freeze({
    permission: "android.accessibility.key",
    sensitive: true,
    description: "Back, home or recents."
  })
});

export const DEVICE_COMMAND_TYPES = Object.freeze(Object.keys(DEVICE_COMMANDS));

const TEXT_LIMIT = 500;
const SWIPE_DEFAULT_MS = 300;
const SWIPE_MAX_MS = 2000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integer(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function rejectUnknown(payload, allowed) {
  return Object.keys(payload).filter((key) => !allowed.includes(key));
}

function failure(error) {
  return { ok: false, error };
}

export function validateDeviceCommand(type, payload = {}) {
  const definition = DEVICE_COMMANDS[type];
  if (!definition) return failure("unknown command type");
  if (!isPlainObject(payload)) return failure("payload must be an object");

  const unknown = rejectUnknown(payload, allowedKeys(type));
  if (unknown.length > 0) return failure("payload contains unsupported fields: " + unknown.join(", "));

  if (type === "device.status" || type === "device.screen" || type === "device.screenshot") {
    return { ok: true, payload: {} };
  }

  if (type === "device.tap") {
    if (!integer(payload.x, 0, 10000) || !integer(payload.y, 0, 10000)) {
      return failure("tap requires integer x and y between 0 and 10000");
    }
    return { ok: true, payload: { x: payload.x, y: payload.y } };
  }

  if (type === "device.swipe") {
    for (const key of ["x1", "y1", "x2", "y2"]) {
      if (!integer(payload[key], 0, 10000)) return failure("swipe requires integer " + key + " between 0 and 10000");
    }
    const durationMs = payload.durationMs === undefined ? SWIPE_DEFAULT_MS : payload.durationMs;
    if (!integer(durationMs, 100, SWIPE_MAX_MS)) return failure("swipe durationMs must be 100–2000");
    return {
      ok: true,
      payload: { x1: payload.x1, y1: payload.y1, x2: payload.x2, y2: payload.y2, durationMs }
    };
  }

  if (type === "device.type") {
    if (typeof payload.text !== "string") return failure("type requires text");
    const text = payload.text;
    if (text.length < 1 || text.length > TEXT_LIMIT) return failure("type text must be 1–500 characters");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return failure("type text contains control characters");
    return { ok: true, payload: { text } };
  }

  if (type === "device.key") {
    // "enter" is deliberately absent: the Android agent has no public
    // AccessibilityService IME action, so accepting it would promise a
    // delivery the phone cannot make.
    const names = ["back", "home", "recents"];
    if (!names.includes(payload.name)) return failure("key name must be one of " + names.join(", "));
    return { ok: true, payload: { name: payload.name } };
  }

  return failure("unsupported command");
}

function allowedKeys(type) {
  switch (type) {
    case "device.tap": return ["x", "y"];
    case "device.swipe": return ["x1", "y1", "x2", "y2", "durationMs"];
    case "device.type": return ["text"];
    case "device.key": return ["name"];
    default: return [];
  }
}

export function isSensitiveDeviceCommand(type) {
  return Boolean(DEVICE_COMMANDS[type]?.sensitive);
}

/** True when the type is known and the enqueue request carries the owner's explicit approval. */
export function isDeviceCommandApproved(type, approved) {
  return !isSensitiveDeviceCommand(type) || approved === true;
}

export const DEVICE_TEXT_LIMIT = TEXT_LIMIT;
