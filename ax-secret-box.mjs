import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for MCP subscription signing secrets.
 *
 * AES-256-GCM with a random 96-bit IV per value. The key id is stored with the ciphertext so a rotation
 * can add a new active key without making old subscriptions undeliverable. Revoked key ids refuse to
 * decrypt. AAD binds a value to its subscription id, so ciphertext moved between rows does not decrypt.
 *
 * Configuration is env-only and strict: 32-byte keys, exactly one active key. A malformed, weak or
 * ambiguous configuration yields no box; callers must refuse to start MCP delivery rather than fall back
 * to plaintext. Errors never include key material.
 */

export const SECRET_BOX_VERSION = "v1";
export const MCP_SECRET_KEYS_ENV = "HABITAT_MCP_SECRET_KEYS";
export const MCP_SECRET_KEY_ENV = "HABITAT_MCP_SECRET_KEY";

function decodeKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const bytes = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function mcpSecretConfiguration({ env = process.env } = {}) {
  const rawKeys = String(env?.[MCP_SECRET_KEYS_ENV] || "").trim();
  const single = String(env?.[MCP_SECRET_KEY_ENV] || "").trim();
  if (!rawKeys && !single) return { ok: false, reason: "secret_encryption_not_configured" };
  if (rawKeys) {
    let parsed;
    try { parsed = JSON.parse(rawKeys); } catch { return { ok: false, reason: "secret_keys_malformed" }; }
    if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, reason: "secret_keys_malformed" };
    const keys = [];
    for (const entry of parsed) {
      const keyId = String(entry?.keyId || "").trim();
      const key = decodeKey(entry?.key);
      if (!keyId || !key || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(keyId)) return { ok: false, reason: "secret_key_invalid" };
      const status = entry?.status === "retired" ? "retired" : entry?.status === "revoked" ? "revoked" : entry?.status === "active" ? "active" : null;
      if (!status) return { ok: false, reason: "secret_key_status_invalid" };
      keys.push({ keyId, key, status });
    }
    const active = keys.filter(entry => entry.status === "active");
    if (active.length !== 1) return { ok: false, reason: "secret_key_active_ambiguous" };
    return { ok: true, keys, activeKeyId: active[0].keyId };
  }
  const key = decodeKey(single);
  if (!key) return { ok: false, reason: "secret_key_invalid" };
  return { ok: true, keys: [{ keyId: "mcp-1", key, status: "active" }], activeKeyId: "mcp-1" };
}

export function createSecretBox({ keys = [], revokedKeyIds = [] } = {}) {
  const ring = new Map();
  for (const entry of keys) {
    const key = Buffer.isBuffer(entry.key) ? entry.key : decodeKey(entry.key);
    const keyId = String(entry?.keyId || "").trim();
    if (!keyId || !key) continue;
    ring.set(keyId, { keyId, key, status: entry.status === "active" ? "active" : entry.status === "revoked" ? "revoked" : "retired" });
  }
  for (const id of revokedKeyIds) if (ring.has(String(id))) ring.get(String(id)).status = "revoked";
  const active = [...ring.values()].find(entry => entry.status === "active");
  if (!active) return null;

  function encrypt(plaintext, { aad = "" } = {}) {
    if (typeof plaintext !== "string" || plaintext.length === 0) return null;
    if (plaintext.startsWith(SECRET_BOX_VERSION + ":")) return null; // never double-encrypt
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", active.key, iv);
    cipher.setAAD(Buffer.from(String(aad), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [SECRET_BOX_VERSION, active.keyId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  }

  function decrypt(envelope, { aad = "" } = {}) {
    if (typeof envelope !== "string") return { ok: false, code: "secret_ciphertext_invalid" };
    const parts = envelope.split(":");
    if (parts.length !== 5 || parts[0] !== SECRET_BOX_VERSION) return { ok: false, code: "secret_ciphertext_invalid" };
    const entry = ring.get(parts[1]);
    if (!entry) return { ok: false, code: "secret_key_unknown" };
    if (entry.status === "revoked") return { ok: false, code: "secret_key_revoked" };
    try {
      const iv = Buffer.from(parts[2], "base64");
      const tag = Buffer.from(parts[3], "base64");
      const ciphertext = Buffer.from(parts[4], "base64");
      const decipher = createDecipheriv("aes-256-gcm", entry.key, iv);
      decipher.setAAD(Buffer.from(String(aad), "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return { ok: true, plaintext, keyId: entry.keyId };
    } catch {
      // Tag, IV, AAD or ciphertext mismatch all look the same to a caller.
      return { ok: false, code: "secret_decryption_failed" };
    }
  }

  return Object.freeze({
    keyId: active.keyId,
    encrypt,
    decrypt,
    rotation: () => ({ activeKeyId: active.keyId, keys: [...ring.values()].map(entry => ({ keyId: entry.keyId, status: entry.status })) })
  });
}

export function secretBoxFromEnv({ env = process.env, revokedKeyIds = [] } = {}) {
  const configuration = mcpSecretConfiguration({ env });
  if (!configuration.ok) return { ok: false, reason: configuration.reason, box: null };
  const box = createSecretBox({ keys: configuration.keys, revokedKeyIds });
  if (!box) return { ok: false, reason: "secret_encryption_not_configured", box: null };
  return { ok: true, box, activeKeyId: box.keyId };
}
