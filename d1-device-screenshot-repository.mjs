/**
 * D1 storage for phone screenshots.
 *
 * A screenshot is private owner data: it is device-authenticated on upload, operator- or Ax-
 * authenticated on read, never cached, and retained for 24 hours. The base64 body is bounded before
 * it reaches SQL so a phone bug cannot fill the database.
 */
const API = "https://api.cloudflare.com/client/v4";
export const SCREENSHOT_MAX_BYTES = 1_500_000;
export const SCREENSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SCREENSHOT_MIME_TYPES = Object.freeze(["image/jpeg", "image/png"]);

export function createD1DeviceScreenshotRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every((value) => String(value || "").trim())) {
    throw new Error("Device screenshot storage requires Cloudflare D1 credentials.");
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
      throw new Error(`D1 screenshot query failed with HTTP ${response.status}; verify D1 configuration.`);
    }
    return payload.result || [];
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_device_screenshots (id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, mime TEXT NOT NULL, data_b64 TEXT NOT NULL, captured_at TEXT NOT NULL, created_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_device_screenshots_device ON habitat_device_screenshots(device_id, captured_at)");
      return { ok: true, adapter: "cloudflare-d1" };
    },
    async save({ id, deviceId, mime, dataBase64, capturedAt, createdAt }) {
      await query(
        "INSERT INTO habitat_device_screenshots (id, device_id, mime, data_b64, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [id, deviceId, mime, dataBase64, capturedAt, createdAt]
      );
      return { id, deviceId, mime, capturedAt };
    },
    async get(id) {
      const result = await query(
        "SELECT id, device_id, mime, data_b64, captured_at, created_at FROM habitat_device_screenshots WHERE id = ? LIMIT 1",
        [String(id || "")]
      );
      const row = result[0]?.results?.[0];
      if (!row) return null;
      return {
        id: row.id,
        deviceId: row.device_id,
        mime: row.mime,
        dataBase64: row.data_b64,
        capturedAt: row.captured_at,
        createdAt: row.created_at
      };
    },
    async latest(deviceId) {
      const result = await query(
        "SELECT id, device_id, mime, captured_at, created_at FROM habitat_device_screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1",
        [String(deviceId || "")]
      );
      const row = result[0]?.results?.[0];
      return row ? { id: row.id, deviceId: row.device_id, mime: row.mime, capturedAt: row.captured_at, createdAt: row.created_at } : null;
    },
    async prune(beforeIso) {
      await query("DELETE FROM habitat_device_screenshots WHERE created_at < ?", [String(beforeIso || "")]);
      return true;
    }
  });
}
