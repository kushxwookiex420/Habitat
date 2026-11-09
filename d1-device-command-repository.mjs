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

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_device_commands (id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_device_commands_queue ON habitat_device_commands(device_id, status, created_at)");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
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
