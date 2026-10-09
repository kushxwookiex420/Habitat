import crypto from "node:crypto";

const API = "https://api.cloudflare.com/client/v4";

export function createD1SecretVault({ accountId, databaseId, apiToken, encryptionKey, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("D1 secret vault requires Cloudflare account ID, database ID, and API token.");
  }
  const keyHex = String(encryptionKey || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
    throw new Error("HABITAT_TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 random bytes).");
  }
  const key = Buffer.from(keyHex, "hex");
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
      throw new Error(`D1 secret-vault query failed with HTTP ${response.status}; check database configuration.`);
    }
    return payload.result || [];
  }

  function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), ciphertext: ciphertext.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
  }

  function decrypt(row) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "hex"));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "hex"));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "hex")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(clear);
  }

  return Object.freeze({
    adapter: "cloudflare-d1-aes-256-gcm",
    durable: true,
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_secret_vault (key_name TEXT PRIMARY KEY NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, auth_tag TEXT NOT NULL, updated_at TEXT NOT NULL)");
      return { ok: true, adapter: "cloudflare-d1-aes-256-gcm" };
    },
    async set(name, value) {
      const keyName = String(name || "").trim();
      if (!keyName) throw new Error("Vault key name is required.");
      const encrypted = encrypt(value);
      await query(
        "INSERT INTO habitat_secret_vault (key_name, iv, ciphertext, auth_tag, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key_name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, auth_tag = excluded.auth_tag, updated_at = excluded.updated_at",
        [keyName, encrypted.iv, encrypted.ciphertext, encrypted.authTag, new Date().toISOString()]
      );
      return { ok: true };
    },
    async get(name) {
      const result = await query("SELECT iv, ciphertext, auth_tag FROM habitat_secret_vault WHERE key_name = ? LIMIT 1", [String(name || "")]);
      const row = result[0]?.results?.[0];
      if (!row) return null;
      try { return decrypt(row); }
      catch { throw new Error("Vault record could not be decrypted; verify HABITAT_TOKEN_ENCRYPTION_KEY."); }
    },
    async delete(name) {
      await query("DELETE FROM habitat_secret_vault WHERE key_name = ?", [String(name || "")]);
      return { ok: true };
    },
    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1-aes-256-gcm", durable: true };
    }
  });
}
