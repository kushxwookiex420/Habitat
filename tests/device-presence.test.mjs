import test from "node:test";
import assert from "node:assert/strict";
import { projectDevicePresence, DEVICE_BRIDGE_HEARTBEAT_TTL_MS } from "../device-presence.mjs";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const row = (overrides = {}) => ({
  device_id: "s26-ultra",
  created_at: iso(-86_400_000),
  last_seen_at: iso(-30_000),
  revoked_at: null,
  device_json: JSON.stringify({ manufacturer: "Samsung", model: "SM-S948U1", appVersion: "0.8.6", batteryPercent: 82 }),
  ...overrides
});

test("a durable paired row is live presence with its real device details", () => {
  const presence = projectDevicePresence([row()], { now: NOW });
  assert.equal(presence.status, "PASS");
  assert.equal(presence.active.length, 1);
  assert.equal(presence.devices[0].deviceModel, "Samsung SM-S948U1");
  assert.equal(presence.devices[0].source, "secure-device-bridge");
  assert.equal(presence.devices[0].batteryPercent, 82);
});

test("a row outside the heartbeat window is listed but never counted as live", () => {
  const presence = projectDevicePresence([row({ last_seen_at: iso(-(DEVICE_BRIDGE_HEARTBEAT_TTL_MS + 1000)) })], { now: NOW });
  assert.equal(presence.status, "UNVERIFIED");
  assert.equal(presence.active.length, 0);
  assert.equal(presence.devices.length, 1);
  assert.match(presence.detail, /45-minute heartbeat window/);
});

test("revoked, never-seen and unparseable rows are not presence", () => {
  const presence = projectDevicePresence([
    row({ device_id: "revoked", revoked_at: iso(-1000) }),
    row({ device_id: "never-seen", last_seen_at: null }),
    row({ device_id: "bad-time", last_seen_at: "not-a-date" })
  ], { now: NOW });
  assert.equal(presence.devices.length, 0);
  assert.equal(presence.active.length, 0);
  assert.equal(presence.status, "UNVERIFIED");
});

test("the most recent check-in is first even when rows arrive out of order", () => {
  const presence = projectDevicePresence([
    row({ device_id: "old", last_seen_at: iso(-600_000) }),
    row({ device_id: "new", last_seen_at: iso(-5_000) })
  ], { now: NOW });
  assert.equal(presence.devices[0].deviceId, "new");
  assert.equal(presence.active[0].deviceId, "new");
});

test("malformed device_json degrades to a safe label instead of throwing", () => {
  const presence = projectDevicePresence([row({ device_json: "{not json" })], { now: NOW });
  assert.equal(presence.devices[0].deviceModel, "Paired Habitat Android device");
});
