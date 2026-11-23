import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { projectDevicePresence, DEVICE_BRIDGE_HEARTBEAT_TTL_MS } from "../device-presence.mjs";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

function row(overrides = {}) {
  return {
    device_id: "android-s26",
    last_seen_at: ago(1),
    device_json: JSON.stringify({
      manufacturer: "samsung",
      model: "SM-S948B",
      appVersion: "1.4.0",
      androidSdk: 36,
      androidRelease: "16",
      batteryPercent: 82,
      charging: false,
      interactive: true
    }),
    ...overrides
  };
}

test("durable paired rows become presence with their real device details", () => {
  const presence = projectDevicePresence([row()], { now: NOW });
  assert.equal(presence.status, "PASS");
  assert.equal(presence.active.length, 1);
  assert.equal(presence.detail, "A Habitat Android device checked in recently (secure-device-bridge).");
  const device = presence.devices[0];
  assert.equal(device.deviceId, "android-s26");
  assert.equal(device.deviceModel, "samsung SM-S948B");
  assert.equal(device.batteryPercent, 82);
  assert.equal(device.source, "secure-device-bridge");
  assert.equal(device.heartbeatTtlMs, DEVICE_BRIDGE_HEARTBEAT_TTL_MS);
});

test("revoked, never-seen and unparseable rows are not presence", () => {
  const presence = projectDevicePresence([
    row({ device_id: "revoked", revoked_at: ago(5) }),
    row({ device_id: "never-seen", last_seen_at: null }),
    row({ device_id: "bad-clock", last_seen_at: "not-a-date" })
  ], { now: NOW });
  assert.deepEqual(presence.devices, []);
  assert.equal(presence.status, "UNVERIFIED");
  assert.match(presence.detail, /No Habitat Android device/);
});

test("a device outside the heartbeat window is listed but never counted as active", () => {
  const presence = projectDevicePresence([
    row({ device_id: "old", last_seen_at: ago(46) }),
    row({ device_id: "fresh", last_seen_at: ago(2) })
  ], { now: NOW });
  assert.equal(presence.devices.length, 2);
  assert.deepEqual(presence.active.map((device) => device.deviceId), ["fresh"]);
  assert.equal(presence.status, "PASS");
});

test("the most recent check-in is first even when rows arrive out of order", () => {
  const presence = projectDevicePresence([
    row({ device_id: "older", last_seen_at: ago(10) }),
    row({ device_id: "newest", last_seen_at: ago(1) })
  ], { now: NOW });
  assert.equal(presence.devices[0].deviceId, "newest");
  assert.equal(presence.active[0].deviceId, "newest");
});

test("malformed device_json degrades to a safe label instead of throwing", () => {
  const presence = projectDevicePresence([
    row({ device_json: "{not json" }),
    row({ device_id: "array-json", device_json: "[1,2]" }),
    row({ device_id: "no-details", device_json: null })
  ], { now: NOW });
  assert.equal(presence.devices.length, 3);
  for (const device of presence.devices) {
    assert.equal(device.deviceModel, "Paired Habitat Android device");
    assert.equal(device.batteryPercent, null);
  }
});

test("server.mjs has no shadowed heartbeat handler and no in-memory presence registry", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.equal(server.includes('app.post("/device/heartbeat"'), false, "the durable bridge must be the only heartbeat route");
  assert.equal(server.includes("androidDevices"), false, "the dead in-memory presence map must be gone");
  assert.equal(server.includes("legacy-heartbeat"), false, "no legacy presence source may be projected");
  assert.equal(server.includes("pruneAndroidDevices"), false);
  assert.equal(server.includes('from "./device-presence.mjs"'), true, "presence must come from the durable projection");
});
