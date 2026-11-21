import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison for bearer-style secrets. Different lengths are rejected
 * without comparing bytes, which is the only information an attacker can learn here.
 */
export function secretEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Builds the Express middleware for the legacy /tasks and /system-check routes.
 *
 * These routes can create model work and execute tasks, so they must not be public. The
 * internal loopback token is generated once per process and only used by /chat's own
 * fetch calls. An operator may use the Ax bridge token. A paired owner device is verified
 * by the same durable store that protects device commands.
 */
export function createTaskAuthorizer({ internalToken, getAxToken, authorizeOwner }) {
  if (!internalToken) throw new Error("internal task token is required");
  if (typeof authorizeOwner !== "function") throw new Error("authorizeOwner is required");

  return async function requireTaskCaller(req, res, next) {
    if (secretEqual(req.headers?.["x-habitat-internal-token"], internalToken)) return next();

    const axToken = String(typeof getAxToken === "function" ? getAxToken() : "").trim();
    const bearer = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (axToken && secretEqual(bearer, axToken)) return next();

    const owner = await authorizeOwner(req);
    if (owner?.ok) return next();
    return res.status(owner?.status || 401).json({
      ok: false,
      code: owner?.code || "owner_required",
      error: owner?.error || "A verified owner device is required to create or execute tasks."
    });
  };
}
