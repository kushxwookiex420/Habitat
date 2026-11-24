import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Owner attestation.
 *
 * A memory row that claims `provenance.source: "owner"` is a claim, not proof: any in-process writer
 * can type the string. This module makes the claim checkable with an HMAC over the exact fields being
 * written, using a key the agents never hold. It is deliberately small: no user directory, no tokens,
 * no network — one key, one signature, one verification.
 *
 * What it does prove: the writer knew the owner key at signing time and the payload was not altered
 * afterwards. What it does not prove: which human was at the keyboard. That remains the owner's
 * responsibility, and the key must live in the environment, never in memory rows or prompts.
 */

export const OWNER_ATTESTATION_VERSION = 1;
export const OWNER_ATTESTATION_KEY_ENV = "HABITAT_OWNER_ATTESTATION_KEY";

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function macFor(secret, payload) {
  return createHmac("sha256", secret).update(canonical(payload)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The fields a signature covers. `operation` separates a write from a delete or an approval. */
export function attestationPayload({ operation = "memory.put", project, key, kind, statement, tags = [], confidence = null } = {}) {
  return {
    v: OWNER_ATTESTATION_VERSION,
    operation: String(operation),
    project: String(project || ""),
    key: String(key || ""),
    kind: String(kind || ""),
    statement: String(statement || ""),
    tags: (Array.isArray(tags) ? tags : []).map(tag => String(tag)),
    confidence: confidence === null || confidence === undefined ? null : Number(confidence)
  };
}

export function createOwnerAttestation({
  secret = process.env?.[OWNER_ATTESTATION_KEY_ENV] || "",
  keyId = "owner-1",
  // Rotation: several keys may verify while exactly one signs. A retired key stays valid for
  // verification so previously signed data does not become unverifiable during a rotation.
  keys = null,
  revokedKeyIds = [],
  now = () => Date.now(),
  ttlMs = 5 * 60 * 1000,
  replay = null
} = {}) {
  const declared = Array.isArray(keys) && keys.length > 0
    ? keys
    : [{ keyId, secret, status: "active" }];
  const keyring = new Map();
  for (const entry of declared) {
    const id = String(entry?.keyId || "").trim();
    const value = String(entry?.secret || "");
    if (!id || value.trim().length < 32) continue;
    keyring.set(id, { keyId: id, secret: value, status: entry?.status === "active" ? "active" : "retired" });
  }
  const revoked = new Set((Array.isArray(revokedKeyIds) ? revokedKeyIds : []).map(item => String(item)));
  for (const id of revoked) {
    if (keyring.has(id)) keyring.get(id).status = "revoked";
  }
  const active = [...keyring.values()].find(entry => entry.status === "active") || null;
  const configured = Boolean(active);
  const signingKeyId = active?.keyId || keyId;
  const key = active?.secret || "";
  // Single-use nonces, bounded and pruned. In-process only: multi-instance replay protection needs a
  // shared store, which the gateway supplies separately.
  const seen = new Map();
  const replayStore = replay || {
    seen(id) { return seen.get(id) || 0; },
    remember(id, expiresAt) {
      const at = now();
      for (const [candidate, expiry] of seen) if (expiry <= at) seen.delete(candidate);
      while (seen.size >= 5000) seen.delete(seen.keys().next().value);
      seen.set(id, expiresAt);
    }
  };

  function sign(fields = {}) {
    if (!configured) return { ok: false, code: "owner_attestation_not_configured" };
    const payload = attestationPayload(fields);
    const issuedAt = new Date(now()).toISOString();
    const nonce = randomBytes(12).toString("hex");
    const mac = macFor(key, { ...payload, keyId: signingKeyId, issuedAt, nonce });
    return { ok: true, attestation: { v: OWNER_ATTESTATION_VERSION, keyId: signingKeyId, issuedAt, nonce, mac } };
  }

  function verify(fields = {}, attestation = null, { ttl = ttlMs, trace = false, consumeReplay = true } = {}) {
    if (!configured) return { ok: false, code: "owner_attestation_not_configured" };
    if (!attestation || typeof attestation !== "object") return { ok: false, code: "owner_attestation_required" };
    if (Number(attestation.v) !== OWNER_ATTESTATION_VERSION) return { ok: false, code: "owner_attestation_version_unsupported" };
    const entry = keyring.get(String(attestation.keyId || ""));
    if (!entry) return { ok: false, code: "owner_attestation_unknown_key" };
    if (entry.status === "revoked") return { ok: false, code: "owner_attestation_key_revoked" };
    const issuedMs = Date.parse(String(attestation.issuedAt || ""));
    if (!Number.isFinite(issuedMs)) return { ok: false, code: "owner_attestation_invalid_time" };
    if (Math.abs(now() - issuedMs) > ttl) return { ok: false, code: "owner_attestation_expired" };
    if (!/^[a-f0-9]{16,64}$/i.test(String(attestation.nonce || ""))) return { ok: false, code: "owner_attestation_invalid_nonce" };
    const payload = attestationPayload(fields);
    const expected = macFor(entry.secret, {
      ...payload,
      keyId: attestation.keyId,
      issuedAt: attestation.issuedAt,
      nonce: attestation.nonce
    });
    if (!safeEqual(expected, attestation.mac)) return { ok: false, code: "owner_attestation_invalid" };
    const replayId = String(attestation.keyId) + ":" + String(attestation.nonce);
    // Execution re-checks a stored signature without spending its nonce; only the decision consumes it.
    if (consumeReplay) {
      if (replayStore.seen(replayId) > now()) return { ok: false, code: "owner_attestation_replayed" };
      replayStore.remember(replayId, issuedMs + ttl);
    }
    return { ok: true, keyId: entry.keyId, issuedAt: attestation.issuedAt, ...(trace ? { replayId } : {}) };
  }

  return Object.freeze({
    configured,
    keyId: signingKeyId,
    sign,
    verify,
    rotation() {
      return {
        activeKeyId: signingKeyId,
        keys: [...keyring.values()].map(entry => ({ keyId: entry.keyId, status: entry.status })),
        revokedKeyIds: [...revoked]
      };
    },
    /** Convenience: verify a normalized memory entry written as owner. */
    verifyEntry(entry = {}, attestation = null, { operation = "memory.put" } = {}) {
      return verify({
        operation,
        project: entry.project,
        key: entry.key,
        kind: entry.kind,
        statement: entry.statement,
        tags: entry.tags || [],
        confidence: entry.confidence ?? null
      }, attestation);
    }
  });
}

/**
 * Build a verifier from the environment. Returns null when no key is configured, which callers must
 * treat as "owner writes cannot be authenticated" rather than "owner writes are allowed".
 */
export const OWNER_ATTESTATION_KEYS_ENV = "HABITAT_OWNER_ATTESTATION_KEYS";
export const OWNER_ATTESTATION_REVOKED_ENV = "HABITAT_OWNER_ATTESTATION_REVOKED";

/**
 * Build a verifier from the environment. A single key is the simple form; a JSON keyring enables
 * rotation without invalidating data signed by a retired key, and a comma-separated list revokes key
 * ids. A malformed keyring yields no verifier rather than silently falling back to the single key.
 */
export function ownerVerifierFromEnv({ env = process.env, now, ttlMs } = {}) {
  const secret = String(env?.[OWNER_ATTESTATION_KEY_ENV] || "").trim();
  const rawKeys = String(env?.[OWNER_ATTESTATION_KEYS_ENV] || "").trim();
  const revokedKeyIds = String(env?.[OWNER_ATTESTATION_REVOKED_ENV] || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);

  let keys = null;
  if (rawKeys) {
    try {
      const parsed = JSON.parse(rawKeys);
      if (!Array.isArray(parsed)) return null;
      keys = parsed
        .filter(entry => entry && String(entry.keyId || "").trim() && String(entry.secret || "").trim().length >= 32)
        .map(entry => ({ keyId: String(entry.keyId).trim(), secret: String(entry.secret), status: entry.status === "retired" ? "retired" : "active" }));
      if (keys.length === 0 || keys.filter(entry => entry.status === "active").length !== 1) return null;
    } catch {
      return null;
    }
  }

  if (!keys && secret.length < 32) return null;
  return createOwnerAttestation({ secret, keys, revokedKeyIds, now, ttlMs });
}
