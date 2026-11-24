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
  now = () => Date.now(),
  ttlMs = 5 * 60 * 1000
} = {}) {
  const configured = String(secret || "").trim().length >= 32;
  const key = configured ? String(secret) : "";

  function sign(fields = {}) {
    if (!configured) return { ok: false, code: "owner_attestation_not_configured" };
    const payload = attestationPayload(fields);
    const issuedAt = new Date(now()).toISOString();
    const nonce = randomBytes(12).toString("hex");
    const mac = macFor(key, { ...payload, keyId, issuedAt, nonce });
    return { ok: true, attestation: { v: OWNER_ATTESTATION_VERSION, keyId, issuedAt, nonce, mac } };
  }

  function verify(fields = {}, attestation = null, { ttl = ttlMs } = {}) {
    if (!configured) return { ok: false, code: "owner_attestation_not_configured" };
    if (!attestation || typeof attestation !== "object") return { ok: false, code: "owner_attestation_required" };
    if (Number(attestation.v) !== OWNER_ATTESTATION_VERSION) return { ok: false, code: "owner_attestation_version_unsupported" };
    if (String(attestation.keyId || "") !== String(keyId)) return { ok: false, code: "owner_attestation_unknown_key" };
    const issuedMs = Date.parse(String(attestation.issuedAt || ""));
    if (!Number.isFinite(issuedMs)) return { ok: false, code: "owner_attestation_invalid_time" };
    if (Math.abs(now() - issuedMs) > ttl) return { ok: false, code: "owner_attestation_expired" };
    if (!/^[a-f0-9]{16,64}$/i.test(String(attestation.nonce || ""))) return { ok: false, code: "owner_attestation_invalid_nonce" };
    const payload = attestationPayload(fields);
    const expected = macFor(key, {
      ...payload,
      keyId: attestation.keyId,
      issuedAt: attestation.issuedAt,
      nonce: attestation.nonce
    });
    if (!safeEqual(expected, attestation.mac)) return { ok: false, code: "owner_attestation_invalid" };
    return { ok: true, keyId, issuedAt: attestation.issuedAt };
  }

  return Object.freeze({
    configured,
    keyId,
    sign,
    verify,
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
export function ownerVerifierFromEnv({ env = process.env, now, ttlMs } = {}) {
  const secret = String(env?.[OWNER_ATTESTATION_KEY_ENV] || "").trim();
  if (secret.length < 32) return null;
  return createOwnerAttestation({ secret, now, ttlMs });
}
