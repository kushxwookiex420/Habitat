import { createHash, timingSafeEqual } from "node:crypto";

const API = "https://api.cloudflare.com/client/v4";

export function createD1DeviceCommandRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("Device command storage requires Cloudflare D1 credentials.");
  }
  const endpoint = `${API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params })
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.success !== true) {
      throw new Error(`D1 device-command query failed with HTTP ${response.status}; verify D1 configuration.`);
    }
    return payload.result || [];
  }
  function decode(row) {
    try {
      const command = JSON.parse(row.record_json);
      return command && typeof command.id === "string" ? command : null;
    } catch { return null; }
  }
  function hash(value) {
    return createHash("sha256").update(String(value), "utf8").digest("hex");
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_device_commands (id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_device_commands_queue ON habitat_device_commands(device_id, status, created_at)");
      await query("CREATE TABLE IF NOT EXISTS habitat_device_pairings (code_hash TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT)");
      await query("CREATE INDEX IF NOT EXISTS habitat_device_pairings_expiry ON habitat_device_pairings(expires_at, consumed_at)");
      await query("CREATE TABLE IF NOT EXISTS habitat_paired_devices (device_id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    },
    async createPairing({ codeHash, deviceId, createdAt, expiresAt }) {
      await query(
        "INSERT INTO habitat_device_pairings (code_hash, device_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)",
        [codeHash, deviceId, createdAt, expiresAt]
      );
      return true;
    },
    async consumePairing({ codeHash, deviceId, consumedAt }) {
      const result = await query(
        "UPDATE habitat_device_pairings SET consumed_at = ? WHERE code_hash = ? AND device_id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING device_id",
        [consumedAt, codeHash, deviceId, consumedAt]
      );
      return Boolean(result[0]?.results?.length);
    },
    async registerDevice({ deviceId, tokenHash, createdAt }) {
      await query(
        "INSERT INTO habitat_paired_devices (device_id, token_hash, created_at, revoked_at) VALUES (?, ?, ?, NULL) " +
        "ON CONFLICT(device_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, revoked_at = NULL",
        [deviceId, tokenHash, createdAt]
      );
      return true;
    },
    async verifyDeviceToken(token, deviceId) {
      const result = await query(
        "SELECT token_hash FROM habitat_paired_devices WHERE device_id = ? AND revoked_at IS NULL LIMIT 1",
        [deviceId]
      );
      const stored = String(result[0]?.results?.[0]?.token_hash || "");
      const supplied = hash(token);
      const a = Buffer.from(stored);
      const b = Buffer.from(supplied);
      return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
    },
    async isDevicePaired(deviceId) {
      const result = await query(
        "SELECT device_id FROM habitat_paired_devices WHERE device_id = ? AND revoked_at IS NULL LIMIT 1",
        [deviceId]
      );
      return Boolean(result[0]?.results?.length);
    },
    async revokeDevice(deviceId, revokedAt) {
      await query(
        "UPDATE habitat_paired_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        [revokedAt, deviceId]
      );
      return true;
    },
    async enqueue(command) {
      if (!command?.id || !command?.deviceId || !command?.type) throw new Error("A complete device command is required.");
      await query(
        "INSERT INTO habitat_device_commands (id, device_id, record_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [command.id, command.deviceId, JSON.stringify(command), "queued", command.createdAt, command.expiresAt]
      );
      return structuredClone(command);
    },
    async claimNext(deviceId) {
      const claimedAt = new Date().toISOString();
      const result = await query(
        "UPDATE habitat_device_commands SET status = 'claimed', record_json = json_set(record_json, '$.status', 'claimed', '$.claimedAt', ?) " +
        "WHERE id = (SELECT id FROM habitat_device_commands WHERE device_id = ? AND status = 'queued' AND expires_at > ? ORDER BY created_at ASC LIMIT 1) " +
        "AND status = 'queued' RETURNING record_json",
        [claimedAt, deviceId, claimedAt]
      );
      return decode(result[0]?.results?.[0] || {});
    },
    async complete({ id, deviceId, result: commandResult, completedAt }) {
      const currentResult = await query(
        "SELECT record_json FROM habitat_device_commands WHERE id = ? AND device_id = ? AND status = 'claimed' AND expires_at > ? LIMIT 1",
        [id, deviceId, completedAt]
      );
      const current = decode(currentResult[0]?.results?.[0] || {});
      if (!current) return false;
      const next = { ...current, status: "completed", result: commandResult, completedAt };
      const updated = await query(
        "UPDATE habitat_device_commands SET record_json = ?, status = 'completed' WHERE id = ? AND device_id = ? AND status = 'claimed' RETURNING id",
        [JSON.stringify(next), id, deviceId]
      );
      return Boolean(updated[0]?.results?.length);
    },
    async get(id) {
      const result = await query("SELECT record_json FROM habitat_device_commands WHERE id = ? LIMIT 1", [id]);
      return decode(result[0]?.results?.[0] || {});
    },
    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}
