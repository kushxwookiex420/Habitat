/**
 * Phone presence comes from one place: the paired-device registry in D1.
 *
 * The legacy in-memory heartbeat map is not presence. Its POST route is registered after the
 * durable bridge mount, so Express never reaches it; anything written there would be a second,
 * unpersisted source of truth. This projection is pure so the durable-only contract can be tested
 * without a server or a database.
 */

export const DEVICE_BRIDGE_HEARTBEAT_TTL_MS = 45 * 60 * 1000;

function parseDetails(deviceJson) {
  if (!deviceJson) return {};
  try {
    const parsed = JSON.parse(deviceJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function projectDevicePresence(pairedDevices = [], { now = Date.now(), ttlMs = DEVICE_BRIDGE_HEARTBEAT_TTL_MS } = {}) {
  const devices = (Array.isArray(pairedDevices) ? pairedDevices : [])
    // A revoked device and a device that has never authenticated are not presence. A row whose
    // timestamp cannot be parsed cannot be aged, so it is excluded rather than counted as fresh.
    .filter((row) => row && !row.revoked_at && row.last_seen_at && Number.isFinite(Date.parse(row.last_seen_at)))
    .map((row) => {
      const details = parseDetails(row.device_json);
      const deviceModel = [details.manufacturer, details.model].filter(Boolean).join(" ") ||
        "Paired Habitat Android device";
      return {
        deviceId: row.device_id,
        packageName: "com.habitat.axbridge",
        deviceModel,
        appVersion: details.appVersion || "device-bridge",
        androidSdk: details.androidSdk || null,
        androidRelease: details.androidRelease || null,
        batteryPercent: Number.isInteger(details.batteryPercent) ? details.batteryPercent : null,
        charging: typeof details.charging === "boolean" ? details.charging : null,
        interactive: typeof details.interactive === "boolean" ? details.interactive : null,
        lastSeenAt: row.last_seen_at,
        source: "secure-device-bridge",
        heartbeatTtlMs: ttlMs
      };
    })
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));

  const active = devices.filter((device) => now - Date.parse(device.lastSeenAt) <= (device.heartbeatTtlMs || ttlMs));

  return {
    status: active.length > 0 ? "PASS" : "UNVERIFIED",
    detail: active.length > 0
      ? "A Habitat Android device checked in recently (" + active[0].source + ")."
      : "No paired Android device has checked in within the " + Math.round(ttlMs / 60000) + "-minute heartbeat window.",
    devices,
    active
  };
}
