import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Worker request authentication.
 *
 * A worker is a durable identity (`habitat_ax_workforce_workers`). Being able to *act* as that identity is a
 * separate fact: a worker holds a credential, signs each request with it, and the server verifies the MAC.
 * That is what stops a caller from claiming `worker-engineering` by typing the id into a URL.
 *
 * The signed statement binds every field that changes the meaning of a request:
 *
 *   AX-WORKER-REQUEST-V1
 *   workerId          which identity is acting
 *   credentialId      which key signed
 *   operation         heartbeat | lease.acquire | lease.renew | lease.release
 *   nonce             single-use, recorded by the server
 *   timestamp         epoch ms, inside a bounded window
 *   bodyHash          SHA-256 of the canonical JSON body
 *
 * Without the body hash, a valid heartbeat signature could be replayed onto a lease release by changing the
 * URL only. Without the operation, a signed renewal could be re-aimed at a release.
 */

export const WORKER_AUTH_VERSION = "AX-WORKER-REQUEST-V1";
export const WORKER_CREDENTIAL_PREFIX = "axw_";
export const WORKER_REQUEST_WINDOW_MS = 5 * 60_000;
export const WORKER_OPERATIONS = Object.freeze(["heartbeat", "lease.acquire", "lease.renew", "lease.release"]);
export const WORKER_CREDENTIAL_SCOPES = Object.freeze(["worker"]);

/** Deterministic JSON: sorted keys, stable arrays. The worker and the server hash the same bytes. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function bodyHash(body) {
  return createHash("sha256").update(canonicalJson(body ?? {})).digest("hex");
}

export function workerRequestStatement({ operation, workerId, credentialId, nonce, timestamp, hash }) {
  return [
    WORKER_AUTH_VERSION,
    String(workerId || ""),
    String(credentialId || ""),
    String(operation || ""),
    String(nonce || ""),
    String(timestamp ?? ""),
    String(hash || "")
  ].join("\n");
}

export function signWorkerRequest({ secret, operation, workerId, credentialId, nonce, timestamp, body = null, hash = null }) {
  const digest = hash || bodyHash(body);
  const statement = workerRequestStatement({ operation, workerId, credentialId, nonce, timestamp, hash: digest });
  const mac = createHmac("sha256", String(secret)).update(statement).digest("base64url");
  return { signature: "v1," + mac, hash: digest, statement };
}

export function verifyWorkerRequest({ secret, signature, operation, workerId, credentialId, nonce, timestamp, body = null, hash = null }) {
  const digest = hash || bodyHash(body);
  const statement = workerRequestStatement({ operation, workerId, credentialId, nonce, timestamp, hash: digest });
  const expected = "v1," + createHmac("sha256", String(secret)).update(statement).digest("base64url");
  const left = Buffer.from(String(signature || ""), "utf8");
  const right = Buffer.from(expected, "utf8");
  // Constant-time comparison, and a length check first because timingSafeEqual throws on a mismatch.
  const ok = left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
  return { ok, statement, hash: digest, expected: ok ? null : "signature_mismatch" };
}

/** `axw_<credentialId>_<secret>` — the id is public, the secret is presented only by the worker. */
export function createWorkerSecret() {
  const credentialId = "wcr_" + randomBytes(9).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return {
    credentialId,
    secret,
    presented: WORKER_CREDENTIAL_PREFIX + credentialId + "_" + secret
  };
}

export function parseWorkerCredential(presented) {
  const value = String(presented || "").trim();
  if (!value.startsWith(WORKER_CREDENTIAL_PREFIX)) return null;
  const rest = value.slice(WORKER_CREDENTIAL_PREFIX.length);
  // The id itself contains an underscore, so match its shape rather than splitting on the first one.
  const matched = /^wcr_[a-f0-9]{8,64}/.exec(rest);
  if (!matched || rest.charAt(matched[0].length) !== "_") return null;
  const credentialId = matched[0];
  const secret = rest.slice(credentialId.length + 1);
  if (!/^wcr_[a-f0-9]{8,64}$/.test(credentialId)) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
  return { credentialId, secret };
}

/**
 * The owner statement for a workforce mutation. It reuses the existing owner attestation key: no second
 * trust root, and a signature can never be moved from one worker to another because the id is in the text.
 */
export function workforceOwnerStatement({ operation, workerId = null, credentialId = null, detail = "" } = {}) {
  const parts = ["workforce", String(operation || "").trim()];
  if (workerId) parts.push(String(workerId));
  if (credentialId) parts.push(String(credentialId));
  if (detail) parts.push(String(detail));
  return parts.join(":");
}

/** Capability fingerprint used in a registration statement, so capabilities cannot be swapped after signing. */
export function capabilitiesFingerprint(capabilities = []) {
  const sorted = [...new Set((Array.isArray(capabilities) ? capabilities : []).map((item) => String(item).trim()).filter(Boolean))].sort();
  return createHash("sha256").update(sorted.join("\u0000")).digest("hex").slice(0, 16);
}
