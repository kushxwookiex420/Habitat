// Authorization for chat-originated AX commands.
//
// `/chat` is a public conversational surface: anonymous callers may ask for status, but a command
// objective writes a durable task row. That write must be attributable, so this module decides who
// is allowed to submit one and fails closed when it cannot prove it.
//
// Accepted credentials, strongest first:
//
//   1. A signed owner request: HMAC-SHA256 over method, path, timestamp, nonce and the message
//      digest, keyed by the server-held Ax bridge token. The timestamp window and the single-use
//      nonce make a captured request unusable twice.
//   2. The Ax bridge/command bearer token: the same credential the /ax/command routes already use.
//   3. A paired-device credential: `x-habitat-device-id` plus `x-habitat-device-token`, verified
//      against the durable paired-device registry (token hashes only, constant-time comparison).
//
// What is deliberately absent: any anonymous fallback, any IP-based trust, and any "rate limit as
// authentication". A rate limit is abuse damping; it is not an identity.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CLOCK_SKEW_MS = 120_000;
const NONCE_TTL_MS = 300_000;
const NONCE_MAX = 5_000;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function bearer(req) {
  const value = String(req?.headers?.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function header(req, name) {
  const headers = req?.headers || {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return String(value || "").trim();
}

function messageDigest(message) {
  return createHash("sha256").update(String(message || ""), "utf8").digest("hex");
}

function validNonce(value) {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(String(value || ""));
}

/**
 * @param {object} options
 * @param {object} options.env       process env (token presence only; values are never returned)
 * @param {object} options.deviceBridge bridge API with `verifyDevice({deviceId, token})`
 * @param {() => number} [options.now]
 * @param {Map} [options.nonces]     replay cache; injectable so tests can observe pruning
 */
export function createChatCommandAuthorizer({
  env = process.env,
  deviceBridge = null,
  now = () => Date.now(),
  nonces = new Map(),
  log = console
} = {}) {
  const bridgeToken = String(env?.HABITAT_AX_BRIDGE_TOKEN || "").trim();
  const commandToken = String(env?.HABITAT_AX_COMMAND_TOKEN || "").trim();

  function prune(at) {
    for (const [key, expiresAt] of nonces) {
      if (expiresAt <= at) nonces.delete(key);
    }
    // Hard cap so a flood of valid-looking nonces cannot grow the map without bound. Oldest first
    // is a Map insertion-order approximation; the TTL above is the real bound.
    while (nonces.size > NONCE_MAX) {
      const oldest = nonces.keys().next().value;
      if (oldest === undefined) break;
      nonces.delete(oldest);
    }
  }

  function signedOwnerRequest(req, message) {
    const timestamp = header(req, "x-habitat-timestamp");
    const nonce = header(req, "x-habitat-nonce");
    const signature = header(req, "x-habitat-signature");
    if (!timestamp && !nonce && !signature) return null;
    if (!bridgeToken) return { ok: false, code: "signing_unavailable" };
    if (!timestamp || !nonce || !signature) return { ok: false, code: "incomplete_signature" };
    if (!validNonce(nonce)) return { ok: false, code: "invalid_nonce" };
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at)) return { ok: false, code: "invalid_timestamp" };
    const skew = Math.abs(now() - at);
    if (skew > CLOCK_SKEW_MS) return { ok: false, code: "stale_signature" };

    const canonical = ["POST", "/chat", timestamp, nonce, messageDigest(message)].join("\n");
    const expected = createHmac("sha256", bridgeToken).update(canonical, "utf8").digest("base64");
    if (!safeEqual(expected, signature)) return { ok: false, code: "bad_signature" };

    prune(now());
    if (nonces.has(nonce)) return { ok: false, code: "replayed_nonce" };
    nonces.set(nonce, now() + NONCE_TTL_MS);
    return { ok: true, actor: "owner:bridge", authorization: "owner_signature" };
  }

  return Object.freeze({
    /**
     * @param {{headers: object, message: string}} request
     * @returns {Promise<{ok: boolean, actor?: string, authorization?: string, code?: string}>}
     */
    async authorize(request = {}) {
      const message = String(request.message || "");
      if (!message) return { ok: false, code: "missing_message" };

      const signed = signedOwnerRequest(request, message);
      if (signed) return signed;

      const token = bearer(request);
      if (token) {
        if ((bridgeToken && safeEqual(token, bridgeToken)) ||
            (commandToken && safeEqual(token, commandToken))) {
          return { ok: true, actor: "owner:bridge", authorization: "ax_bridge" };
        }
      }

      const deviceId = header(request, "x-habitat-device-id");
      const deviceToken = header(request, "x-habitat-device-token");
      if (deviceId && deviceToken) {
        if (!deviceBridge || typeof deviceBridge.verifyDevice !== "function") {
          return { ok: false, code: "device_auth_unavailable" };
        }
        try {
          const valid = await deviceBridge.verifyDevice({ deviceId, token: deviceToken });
          if (valid) return { ok: true, actor: "device:" + deviceId, authorization: "device_token" };
        } catch (error) {
          log?.error?.("CHAT_DEVICE_AUTH_FAILED", String(error?.message || error).slice(0, 160));
          return { ok: false, code: "device_auth_unavailable" };
        }
        return { ok: false, code: "device_token_invalid" };
      }

      if (token) return { ok: false, code: "invalid_credential" };
      return { ok: false, code: "missing_credential" };
    }
  });
}
