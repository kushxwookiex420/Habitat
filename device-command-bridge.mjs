import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { inspectIsolation, resolveRuntimeEnvironment, serviceName } from "./environment-identity.mjs";
import { createD1DeviceCommandRepository } from "./d1-device-command-repository.mjs";
import { registerHomeBridgeConsole } from "./home-bridge-console.mjs";
import { registerDeviceHabitat } from "./device-habitat.mjs";
import { registerUniversalCommandRoutes } from "./command-routes.mjs";
import { createD1Query, registerNexusRuntime } from "./nexus-runtime.mjs";
import { buildReadOnlyNexusAdapters } from "./nexus-adapter-registration.mjs";

const SAFE_COMMANDS = new Set(["device.status"]);
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_RECOVERY_TTL_MS = 60 * 1000;

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}
function bearer(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
function validDeviceId(value) {
  const id = String(value || "").trim();
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(id);
}
function sanitizeDeviceDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const details = {};
  for (const key of ["manufacturer", "model", "androidRelease", "appVersion"]) {
    if (typeof value[key] === "string") details[key] = value[key].trim().slice(0, 100);
  }
  if (Number.isInteger(value.androidSdk) && value.androidSdk >= 1 && value.androidSdk <= 100) details.androidSdk = value.androidSdk;
  if (Number.isInteger(value.batteryPercent) && value.batteryPercent >= 0 && value.batteryPercent <= 100) details.batteryPercent = value.batteryPercent;
  for (const key of ["charging", "interactive"]) {
    if (typeof value[key] === "boolean") details[key] = value[key];
  }
  return details;
}

export function registerDeviceCommandBridge(app, {
  env = process.env,
  fetchImpl = fetch,
  repository = null,
  // Test/embedded injection only. Production passes none of these and builds the same objects
  // from env below; the task store is never re-created for the runtime.
  taskRepository = null,
  query = null,
  adapters = null,
  handleSignals = true,
  exitOnSignal = true,
  log = console
} = {}) {
  const axToken = String(env.HABITAT_AX_BRIDGE_TOKEN || "");
  const breakGlassToken = String(env.HABITAT_BREAK_GLASS_TOKEN || "").trim();
  // An explicit HABITAT_RUNTIME_ENV is authoritative. If it is absent, NODE_ENV=production is a
  // fail-safe production block rather than an implicit non-production assumption.
  const runtimeEnvironment = resolveRuntimeEnvironment(env);
  const productionRuntimeBlocked = runtimeEnvironment === "production";
  const d1Isolation = inspectIsolation(env);
  const productionD1Id = d1Isolation.productionDatabaseId;
  const configuredD1Id = d1Isolation.configuredDatabaseId || String(repository?.databaseId || "").trim();
  const usesProductionD1 = Boolean(productionD1Id && configuredD1Id === productionD1Id);
  // A nonproduction process that holds D1 credentials without declaring the production database
  // id cannot prove isolation. Treat it exactly like a conflict rather than trusting it.
  const productionDatabaseUndeclared = Boolean(
    !productionRuntimeBlocked && d1Isolation.databaseConfigured && !productionD1Id
  );

  // A nonproduction process whose D1 id equals the declared production id would still pair
  // phones, record heartbeats, and execute well-formed commands against production data. The
  // previous build only disabled the Nexus worker in that misconfiguration, which left the
  // device queue writable. Refuse durable device storage entirely instead, so every device route
  // answers 503 and no write can occur. An injected repository is a test/embedded path.
  const environmentConflict = Boolean(
    !repository && !productionRuntimeBlocked && (usesProductionD1 || productionDatabaseUndeclared)
  );
  if (environmentConflict) {
    const reason = usesProductionD1
      ? "HABITAT_D1_DATABASE_ID equals HABITAT_PRODUCTION_D1_DATABASE_ID"
      : "HABITAT_PRODUCTION_D1_DATABASE_ID is not declared, so production isolation cannot be proven";
    log.error?.(
      "DEVICE_COMMAND_BRIDGE_ENVIRONMENT_CONFLICT: " + reason +
      "; durable device storage is disabled for this nonproduction process"
    );
  }

  const hasD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]
    .every(key => String(env[key] || "").trim());
  const store = repository || (hasD1 && !environmentConflict ? createD1DeviceCommandRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);

  const nexusEnabled = String(env.NEXUS_RUNTIME_ENABLED || "").trim().toLowerCase() === "true" &&
    !productionRuntimeBlocked && !usesProductionD1 && !productionDatabaseUndeclared;
  const owners = new Set();
  for (const value of [env.HABITAT_OWNER_DEVICE_ID, env.HABITAT_OWNER_DEVICE_IDS]) {
    String(value || "").split(",").map(part => part.trim()).filter(Boolean).forEach(id => owners.add(id));
  }

  function soleOwner() {
    return owners.size === 1 ? [...owners][0] : null;
  }

  async function audit(event, { actorDeviceId = null, targetDeviceId = null, detail = null } = {}) {
    try {
      if (store && typeof store.audit === "function") {
        await store.audit({ event, actorDeviceId, targetDeviceId, detail });
      }
    } catch (error) {
      // Audit failure must be visible but must not turn a completed security action into a
      // success claim. The action itself remains fail-closed at its own authorization boundary.
      console.error("DEVICE_SECURITY_AUDIT_FAILED", String(error?.message || error));
    }
  }

  /**
   * Authenticate an owner request without writing a response. Used by /chat, which needs to
   * authenticate a device command without becoming a general owner API.
   */
  async function authorizeOwnerRequest(req) {
    if (!owners.size) {
      return { ok: false, status: 503, code: "owner_unconfigured", error: "Owner authorization is not configured." };
    }
    const ownerDeviceId = String(req.headers?.["x-owner-device-id"] || "").trim();
    const token = bearer(req);
    if (!validDeviceId(ownerDeviceId) || !token) {
      return { ok: false, status: 401, code: "owner_required", error: "A valid owner device id and token are required." };
    }
    if (!store) {
      return { ok: false, status: 503, code: "owner_unavailable", error: "Device verification is not configured on this process." };
    }
    try {
      if (!(await store.verifyDeviceToken(token, ownerDeviceId)) || !owners.has(ownerDeviceId)) {
        return { ok: false, status: 401, code: "owner_invalid", error: "The owner device credential is not valid." };
      }
      return { ok: true, deviceId: ownerDeviceId };
    } catch (error) {
      console.error("DEVICE_OWNER_AUTH_FAILED", String(error?.message || error));
      return { ok: false, status: 503, code: "owner_unavailable", error: "Owner verification is temporarily unavailable." };
    }
  }

  /** Authenticate an owner device and return its server-side device id, never a body value. */
  async function authenticateOwner(req, res) {
    const result = await authorizeOwnerRequest(req);
    if (!result.ok) {
      res.status(result.status).json({ ok: false, code: result.code, error: result.error });
      return null;
    }
    return result.deviceId;
  }

  function requireAx(req, res, next) {
    if (!axToken || !safeEqual(bearer(req), axToken)) {
      return res.status(401).json({ ok: false, error: "Ax bridge authentication required." });
    }
    next();
  }
  function requireStore(_req, res, next) {
    if (!store || !ready) {
      return res.status(503).json({
        ok: false,
        error: "Device command bridge is unavailable; durable D1 storage is not ready."
      });
    }
    next();
  }
  async function requireDevice(req, res, next) {
    const deviceId = String(req.query?.deviceId || req.body?.deviceId || "").trim();
    const token = bearer(req);
    try {
      if (!validDeviceId(deviceId) || !token || !await store.verifyDeviceToken(token, deviceId)) {
        return res.status(401).json({ ok: false, error: "Paired device authentication required." });
      }
      await store.touchDevice(deviceId, new Date().toISOString());
      req.habitatDeviceId = deviceId;
      next();
    } catch (error) {
      console.error("DEVICE_COMMAND_AUTH_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Device authentication is temporarily unavailable." });
    }
  }

  let ready = false;

  // Ax creates a short-lived one-time code. Only its SHA-256 digest is persisted.
  app.post("/ax/device/pairings", requireAx, requireStore, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      if (!validDeviceId(deviceId)) {
        return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
      }
      const ownerDeviceId = soleOwner();
      if (!ownerDeviceId) {
        return res.status(409).json({ ok: false, code: "ownership_ambiguous", error: "Exactly one configured owner is required to mint a pairing code." });
      }
      const code = randomBytes(16).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
      if (typeof store.isDeviceRevoked === "function" && await store.isDeviceRevoked(ownerDeviceId)) {
        return res.status(409).json({ ok: false, code: "owner_inactive", error: "The configured owner device is revoked; pairing codes cannot be minted." });
      }
      await store.createPairing({ codeHash: digest(code), deviceId, createdAt, expiresAt, ownerDeviceId });
      await audit("device.pairing.minted", { actorDeviceId: ownerDeviceId, targetDeviceId: deviceId });
      return res.status(201).json({ ok: true, pairing: { code, deviceId, expiresAt, singleUse: true } });
    } catch (error) {
      console.error("DEVICE_PAIRING_CREATE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to create device pairing." });
    }
  });

  // The phone exchanges the one-time code for a per-device bearer token.
  // The raw token is returned once and never stored server-side.
  app.post("/device/heartbeat", requireStore, requireDevice, async (req, res) => {
    const details = sanitizeDeviceDetails(req.body?.details);
    if (!details) return res.status(400).json({ ok: false, error: "A structured device status object is required." });
    try {
      const seenAt = new Date().toISOString();
      await store.updateDeviceInfo(req.habitatDeviceId, seenAt, details);
      return res.json({ ok: true, deviceId: req.habitatDeviceId, lastSeenAt: seenAt });
    } catch (error) {
      console.error("DEVICE_HEARTBEAT_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to record device status." });
    }
  });

  app.post("/device/pair", requireStore, async (req, res) => {
    try {
      // Accept the field names used by both the regular Habitat app and Bridge APK.
      const deviceId = String(req.body?.deviceId || req.body?.phoneId || req.body?.device_id || "").trim();
      const code = String(req.body?.code || req.body?.pairingCode || req.body?.pairing_code || "").trim();
      if (!validDeviceId(deviceId) || code.length < 20 || code.length > 128) {
        return res.status(400).json({ ok: false, error: "A valid deviceId and pairing code are required." });
      }
      const now = new Date().toISOString();
      const codeHash = digest(code);

      // Reject a revoked device before consuming or revealing anything about a pairing code. The
      // same check is repeated in issueToken() to close a revoke racing the exchange.
      if (typeof store.isDeviceRevoked === "function" && await store.isDeviceRevoked(deviceId)) {
        return res.status(403).json({
          ok: false,
          code: "device_revoked",
          error: "This device is revoked. An owner must explicitly restore it before pairing again."
        });
      }

      async function ownerIsActive(ownerDeviceId, targetDeviceId) {
        if (!owners.has(ownerDeviceId)) return { ok: false, code: "ownership_invalid" };
        // A revoked owner must never be able to redeem a code. An owner is allowed to enroll
        // itself before it has a device row (the initial bootstrap), but every other target
        // requires the owner to be actively paired.
        if (typeof store.isDeviceRevoked === "function" && await store.isDeviceRevoked(ownerDeviceId)) {
          return { ok: false, code: "owner_inactive" };
        }
        if (targetDeviceId !== ownerDeviceId && typeof store.isDevicePaired === "function") {
          if (!(await store.isDevicePaired(ownerDeviceId))) return { ok: false, code: "owner_inactive" };
        }
        return { ok: true };
      }

      async function issueToken(recovered, ownerDeviceId) {
        // A revoked device must not be revived by a consumed-code recovery or a fresh code. An
        // owner must explicitly un-revoke it first.
        if (typeof store.isDeviceRevoked === "function" && await store.isDeviceRevoked(deviceId)) {
          return res.status(403).json({
            ok: false,
            code: "device_revoked",
            error: "This device is revoked. An owner must explicitly restore it before pairing again."
          });
        }
        if (!ownerDeviceId) {
          return res.status(409).json({ ok: false, code: "ownership_missing", error: "This pairing code has no recorded owner." });
        }
        if (!owners.has(ownerDeviceId)) {
          return res.status(409).json({ ok: false, code: "ownership_invalid", error: "This pairing code was issued for an owner that is not configured." });
        }
        const ownerActive = await ownerIsActive(ownerDeviceId, deviceId);
        if (!ownerActive.ok) {
          return res.status(409).json({
            ok: false,
            code: ownerActive.code,
            error: ownerActive.code === "owner_inactive"
              ? "This pairing code was issued by an owner device that is not active or is revoked."
              : "This pairing code was issued for an owner that is not configured."
          });
        }
        if (owners.has(deviceId) && deviceId !== ownerDeviceId) {
          return res.status(403).json({ ok: false, code: "owner_mismatch", error: "An owner device may only be assigned to itself." });
        }
        if (typeof store.getDeviceOwner !== "function") {
          return res.status(503).json({ ok: false, code: "ownership_unavailable", error: "Device ownership cannot be verified." });
        }
        const existingOwner = await store.getDeviceOwner(deviceId);
        if (existingOwner && existingOwner !== ownerDeviceId) {
          return res.status(403).json({ ok: false, code: "owned_by_another", error: "This device belongs to another owner." });
        }
        const deviceToken = randomBytes(32).toString("base64url");
        const registered = await store.registerDevice({ deviceId, tokenHash: digest(deviceToken), createdAt: now, ownerDeviceId });
        if (registered === false) {
          return res.status(409).json({ ok: false, code: "ownership_conflict", error: "Device ownership changed before pairing completed." });
        }
        await audit(recovered ? "device.pairing.recovered" : "device.pairing.redeemed", {
          actorDeviceId: ownerDeviceId, targetDeviceId: deviceId, detail: { recovered: Boolean(recovered) }
        });
        // Keep the canonical nested object and expose top-level aliases for older Bridge APK parsers.
        // The raw credential is returned only in this one-time exchange response.
        return res.status(200).json({
          ok: true,
          deviceId,
          recovered,
          token: deviceToken,
          deviceToken,
          device: { deviceId, token: deviceToken, deviceToken }
        });
      }

      // Read the server-side record before consuming so the authenticated request cannot choose
      // an owner. The pairing row and its owner are written by the server when the code is minted.
      let pairing = typeof store.findPairing === "function" ? await store.findPairing({ codeHash }) : null;
      const paired = await store.consumePairing({ codeHash, deviceId, consumedAt: now });
      if (paired) return issueToken(false, pairing?.ownerDeviceId);

      // A concurrent exchange may have consumed the code after our first read. Re-read before
      // deciding this is a replay, so the same device still gets the lost-response recovery path.
      if (typeof store.findPairing === "function") pairing = await store.findPairing({ codeHash });

      // A failed exchange is explained, not just refused: the phone must be able to tell the owner
      // whether to ask for a new code. The code itself is never returned here.
      if (!pairing) {
        return res.status(401).json({
          ok: false,
          code: "pairing_unknown",
          error: "This pairing code was never issued. Generate a fresh code in the Control Center."
        });
      }
      if (Date.parse(pairing.expiresAt) <= Date.parse(now)) {
        return res.status(401).json({
          ok: false,
          code: "pairing_expired",
          error: "This pairing code expired. Generate a fresh code in the Control Center."
        });
      }
      if (pairing.consumedAt) {
        if (pairing.deviceId !== deviceId) {
          return res.status(409).json({
            ok: false,
            code: "pairing_used_other_device",
            error: "This pairing code was already used by another device. Generate a fresh code."
          });
        }
        const consumedAgeMs = Date.parse(now) - Date.parse(pairing.consumedAt);
        if (!Number.isFinite(consumedAgeMs) || consumedAgeMs < 0 || consumedAgeMs > PAIRING_RECOVERY_TTL_MS) {
          return res.status(401).json({
            ok: false,
            code: "pairing_recovery_expired",
            error: "This pairing code was already used and its short lost-response recovery window has closed. Generate a fresh code."
          });
        }
        if (pairing.recoveryAt) {
          return res.status(409).json({
            ok: false,
            code: "pairing_recovery_exhausted",
            error: "This pairing code already used its one bounded recovery. Generate a fresh code."
          });
        }
        if (typeof store.claimPairingRecovery !== "function") {
          return res.status(503).json({ ok: false, error: "Pairing recovery is unavailable on this device store." });
        }
        const consumedAfter = new Date(Date.parse(now) - PAIRING_RECOVERY_TTL_MS).toISOString();
        const recovered = await store.claimPairingRecovery({ codeHash, deviceId, recoveredAt: now, consumedAfter });
        if (!recovered) {
          return res.status(409).json({
            ok: false,
            code: "pairing_recovery_exhausted",
            error: "This pairing code already used its one bounded recovery. Generate a fresh code."
          });
        }
        return issueToken(true, pairing.ownerDeviceId);
      }
      return res.status(401).json({
        ok: false,
        code: "pairing_invalid",
        error: "This pairing code does not match this device. Generate a fresh code."
      });
    } catch (error) {
      console.error("DEVICE_PAIRING_EXCHANGE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to complete device pairing." });
    }
  });

  app.get("/ax/device/devices", requireAx, requireStore, async (_req, res) => {
    try {
      const devices = await store.listDevices();
      return res.json({ ok: true, devices: devices.map(row => ({
        deviceId: row.device_id,
        pairedAt: row.created_at,
        lastSeenAt: row.last_seen_at || null,
        deviceInfo: (() => { try { return row.device_json ? JSON.parse(row.device_json) : null; } catch { return null; } })(),
        revoked: Boolean(row.revoked_at),
        ownerDeviceId: row.owner_device_id || null
      })) });
    } catch (error) {
      console.error("DEVICE_LIST_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to read paired devices." });
    }
  });

  app.post("/ax/device/commands", requireAx, requireStore, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      const type = String(req.body?.type || "").trim();
      if (!validDeviceId(deviceId) || !SAFE_COMMANDS.has(type)) {
        return res.status(400).json({ ok: false, error: "A valid paired deviceId and allowlisted command type are required." });
      }
      if (!await store.isDevicePaired(deviceId)) {
        return res.status(404).json({ ok: false, error: "Device is not paired." });
      }
      const command = {
        id: "dc_" + randomUUID(), deviceId, type, payload: {}, status: "queued",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      };
      await store.enqueue(command);
      return res.status(202).json({ ok: true, command: { id: command.id, type, status: command.status, expiresAt: command.expiresAt } });
    } catch (error) {
      console.error("DEVICE_COMMAND_ENQUEUE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to queue device command." });
    }
  });

  app.get("/device/commands/next", requireStore, requireDevice, async (req, res) => {
    try {
      const command = await store.claimNext(req.habitatDeviceId);
      return res.json({ ok: true, command: command ? {
        id: command.id, type: command.type, payload: command.payload, expiresAt: command.expiresAt
      } : null });
    } catch (error) {
      console.error("DEVICE_COMMAND_CLAIM_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to claim device command." });
    }
  });

  app.post("/device/commands/:id/result", requireStore, requireDevice, async (req, res) => {
    try {
      const result = req.body?.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return res.status(400).json({ ok: false, error: "A structured result is required." });
      }
      const completed = await store.complete({
        id: String(req.params.id || ""),
        deviceId: req.habitatDeviceId,
        result: {
          ok: result.ok === true,
          summary: String(result.summary || "").slice(0, 500),
          details: result.details && typeof result.details === "object" ? result.details : {}
        },
        completedAt: new Date().toISOString()
      });
      if (!completed) return res.status(409).json({ ok: false, error: "Command not found, expired, or not owned by this device." });
      return res.json({ ok: true, status: "completed" });
    } catch (error) {
      console.error("DEVICE_COMMAND_RESULT_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to record device command result." });
    }
  });

  app.get("/ax/device/commands/:id", requireAx, requireStore, async (req, res) => {
    try {
      const command = await store.get(String(req.params.id || ""));
      if (!command) return res.status(404).json({ ok: false, error: "Command not found." });
      return res.json({ ok: true, command });
    } catch (error) {
      console.error("DEVICE_COMMAND_READ_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to read device command." });
    }
  });

  app.post("/ax/device/:deviceId/revoke", requireAx, requireStore, async (req, res) => {
    const deviceId = String(req.params.deviceId || "").trim();
    if (!validDeviceId(deviceId)) return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
    try {
      await store.revokeDevice(deviceId, new Date().toISOString());
      await audit("device.ax.revoked", { actorDeviceId: "ax", targetDeviceId: deviceId });
      return res.json({ ok: true, deviceId, revoked: true });
    } catch (error) {
      console.error("DEVICE_REVOKE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to revoke device." });
    }
  });

  // An authenticated owner may mint a code only for devices assigned to that owner (or a new
  // ownerless device). Ownership comes from the authenticated owner device, never from the body.
  app.post("/device/owner/pairings", requireStore, async (req, res) => {
    const ownerDeviceId = await authenticateOwner(req, res);
    if (!ownerDeviceId) return undefined;
    const deviceId = String(req.body?.deviceId || "").trim();
    if (!validDeviceId(deviceId)) return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
    if (owners.has(deviceId) && deviceId !== ownerDeviceId) {
      return res.status(403).json({ ok: false, code: "owner_mismatch", error: "An owner device may only be assigned to itself." });
    }
    try {
      if (typeof store.getDeviceOwner === "function") {
        const existingOwner = await store.getDeviceOwner(deviceId);
        if (existingOwner && existingOwner !== ownerDeviceId) {
          return res.status(403).json({ ok: false, code: "owned_by_another", error: "This device belongs to another owner." });
        }
        if (!existingOwner) {
          const known = typeof store.isDevicePaired === "function" ? await store.isDevicePaired(deviceId) : false;
          const revoked = typeof store.isDeviceRevoked === "function" ? await store.isDeviceRevoked(deviceId) : false;
          if (known || revoked) {
            return res.status(409).json({ ok: false, code: "ownership_missing", error: "This existing device has no recorded owner." });
          }
        }
      }
      const code = randomBytes(16).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
      await store.createPairing({ codeHash: digest(code), deviceId, createdAt, expiresAt, ownerDeviceId });
      await audit("device.owner.pairing.minted", { actorDeviceId: ownerDeviceId, targetDeviceId: deviceId });
      return res.status(201).json({ ok: true, pairing: { code, deviceId, expiresAt, singleUse: true } });
    } catch (error) {
      console.error("DEVICE_OWNER_PAIRING_CREATE_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Unable to create an owner pairing code." });
    }
  });

  // Revocation is never undone by pairing. This is the only owner-authorized recovery path.
  app.post("/device/owner/devices/:deviceId/unrevoke", requireStore, async (req, res) => {
    const targetDeviceId = String(req.params.deviceId || "").trim();
    const ownerDeviceId = await authenticateOwner(req, res);
    if (!ownerDeviceId) return undefined;
    if (!validDeviceId(targetDeviceId)) return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
    try {
      if (typeof store.unrevokeDevice !== "function" || typeof store.getDeviceOwner !== "function") {
        return res.status(501).json({ ok: false, error: "This device store cannot enforce ownership." });
      }
      const targetOwner = await store.getDeviceOwner(targetDeviceId);
      if (!targetOwner) {
        return res.status(409).json({ ok: false, code: "ownership_missing", error: "This device has no recorded owner." });
      }
      if (targetOwner !== ownerDeviceId) {
        return res.status(403).json({ ok: false, code: "owned_by_another", error: "This device belongs to another owner." });
      }
      if (typeof store.isDeviceRevoked === "function" && !(await store.isDeviceRevoked(targetDeviceId))) {
        return res.status(409).json({ ok: false, code: "device_not_revoked", error: "Only a revoked device can be restored." });
      }
      const restored = await store.unrevokeDevice(targetDeviceId, ownerDeviceId);
      if (!restored) {
        return res.status(409).json({ ok: false, code: "ownership_changed", error: "Device ownership changed before recovery completed." });
      }
      await audit("device.owner.unrevoked", { actorDeviceId: ownerDeviceId, targetDeviceId });
      return res.json({ ok: true, deviceId: targetDeviceId, revoked: false, requiresPairing: true });
    } catch (error) {
      console.error("DEVICE_UNREVOKE_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Unable to restore the device." });
    }
  });

  // Owner-scoped revocation. The Ax bridge credential remains the separate super-admin path.
  app.post("/device/owner/devices/:deviceId/revoke", requireStore, async (req, res) => {
    const targetDeviceId = String(req.params.deviceId || "").trim();
    const ownerDeviceId = await authenticateOwner(req, res);
    if (!ownerDeviceId) return undefined;
    if (!validDeviceId(targetDeviceId)) return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
    if (targetDeviceId === ownerDeviceId) {
      return res.status(409).json({
        ok: false,
        code: "cannot_revoke_self",
        error: "An owner device cannot revoke itself; use another owner or audited break-glass recovery."
      });
    }
    try {
      if (typeof store.revokeDeviceOwned !== "function" || typeof store.getDeviceOwner !== "function") {
        return res.status(501).json({ ok: false, error: "This device store cannot enforce ownership." });
      }
      const targetOwner = await store.getDeviceOwner(targetDeviceId);
      if (!targetOwner) {
        return res.status(409).json({ ok: false, code: "ownership_missing", error: "This device has no recorded owner." });
      }
      if (targetOwner !== ownerDeviceId) {
        return res.status(403).json({ ok: false, code: "owned_by_another", error: "This device belongs to another owner." });
      }
      const revoked = await store.revokeDeviceOwned(targetDeviceId, ownerDeviceId, new Date().toISOString());
      if (!revoked) {
        return res.status(409).json({ ok: false, code: "ownership_changed", error: "Device ownership changed before revocation completed." });
      }
      await audit("device.owner.revoked", { actorDeviceId: ownerDeviceId, targetDeviceId });
      return res.json({ ok: true, deviceId: targetDeviceId, revoked: true });
    } catch (error) {
      console.error("DEVICE_OWNER_REVOKE_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Unable to revoke the device." });
    }
  });

  // Break-glass is deliberately separate from the owner token. It exists only to recover a
  // revoked owner that can no longer authenticate; it is never a general device-management API.
  app.post("/device/break-glass/devices/:deviceId/unrevoke", requireStore, async (req, res) => {
    if (!breakGlassToken) {
      return res.status(503).json({ ok: false, error: "Break-glass recovery is not configured." });
    }
    const supplied = String(req.headers?.["x-break-glass-token"] || "").trim();
    if (!safeEqual(supplied, breakGlassToken)) {
      await audit("device.break_glass.denied", { targetDeviceId: req.params?.deviceId || null });
      return res.status(401).json({ ok: false, code: "break_glass_invalid", error: "Break-glass credential is not valid." });
    }
    const targetDeviceId = String(req.params?.deviceId || "").trim();
    if (!validDeviceId(targetDeviceId)) {
      return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
    }
    try {
      if (typeof store.unrevokeDeviceByBreakGlass !== "function") {
        return res.status(501).json({ ok: false, error: "This device store does not support break-glass recovery." });
      }
      const restored = await store.unrevokeDeviceByBreakGlass(targetDeviceId);
      if (!restored) {
        return res.status(409).json({ ok: false, code: "device_not_revoked_or_unowned", error: "Only a revoked, owned device can be restored." });
      }
      await audit("device.break_glass.unrevoked", {
        actorDeviceId: "break-glass",
        targetDeviceId,
        detail: { reason: String(req.body?.reason || "").slice(0, 200) || null }
      });
      return res.json({ ok: true, deviceId: targetDeviceId, revoked: false, requiresPairing: true, audit: true });
    } catch (error) {
      console.error("DEVICE_BREAK_GLASS_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Unable to complete break-glass recovery." });
    }
  });

  // Home Bridge command center (Ax/Buff/phone/projects). Additive: it only registers
  // /bridge/console routes and never changes the device command bridge above.
  let consoleApi = null;
  try {
    consoleApi = registerHomeBridgeConsole(app, { env, fetchImpl });
  } catch (error) {
    console.error("HOME_BRIDGE_CONSOLE_MOUNT_FAILED", String(error?.message || error));
  }

  // The Control Center mints a fresh pairing code itself, using its own operator session (or the
  // Ax bridge credential). The Ax token stays server-side: the browser never receives it.
  const consolePairingGuard = consoleApi
    ? [consoleApi.requireSameOrigin, consoleApi.requireOperator]
    : [requireAx];
  app.post("/bridge/console/pairing", ...consolePairingGuard, requireStore, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      if (deviceId && !validDeviceId(deviceId)) {
        return res.status(400).json({ ok: false, error: "A valid deviceId is required when one is supplied." });
      }
      const ownerDeviceId = soleOwner();
      if (!ownerDeviceId) {
        return res.status(409).json({ ok: false, code: "ownership_ambiguous", error: "Exactly one configured owner is required to mint a pairing code." });
      }
      if (typeof store.isDeviceRevoked === "function" && await store.isDeviceRevoked(ownerDeviceId)) {
        return res.status(409).json({ ok: false, code: "owner_inactive", error: "The configured owner device is revoked; pairing codes cannot be minted." });
      }
      const code = randomBytes(16).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
      // Without a device id the code is bound to the first device that uses it.
      await store.createPairing({ codeHash: digest(code), deviceId: deviceId || "*", createdAt, expiresAt, ownerDeviceId });
      await audit("device.console.pairing.minted", { actorDeviceId: ownerDeviceId, targetDeviceId: deviceId || null });
      return res.status(201).json({
        ok: true,
        pairing: { code, deviceId: deviceId || null, expiresAt, singleUse: true }
      });
    } catch (error) {
      console.error("CONSOLE_PAIRING_CREATE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to create a pairing code." });
    }
  });

  // The launcher's Habitat panel reads through this endpoint with its own device token, so the
  // relay's ax credential never ships inside the APK.
  try {
    registerDeviceHabitat(app, { env, fetchImpl, repository: store });
  } catch (error) {
    console.error("DEVICE_HABITAT_MOUNT_FAILED", String(error?.message || error));
  }

  // Universal command engine (AX/NEXUS/ORION/SENTINEL/ATLAS). Additive: /ax/command routes only,
  // its own ax-token guard and its own durable table, so worker-task routes are untouched.
  let commandApi = null;
  try {
    commandApi = registerUniversalCommandRoutes(app, {
      env, fetchImpl,
      repository: taskRepository,
      deviceRepository: store,
      ownerDeviceId: env.HABITAT_OWNER_DEVICE_ID,
      audit: entry => audit(entry.event, entry)
    });
  } catch (error) {
    console.error("UNIVERSAL_COMMAND_MOUNT_FAILED", String(error?.message || error));
  }

  // Nexus runtime is mounted against the SAME task store and engine as /ax/command. It is only
  // registered when a store and an atomic query are both available; otherwise no worker starts
  // and the runtime endpoint fails closed. The worker itself starts later, from initialize(),
  // after the device store is ready.
  let nexusRuntime = null;
  let nexusMount = { configured: false, reason: "command_store_unavailable" };
  try {
    const taskStore = commandApi?.store?.() || null;
    const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
    const databaseId = String(env.HABITAT_D1_DATABASE_ID || "").trim();
    const apiToken = String(env.HABITAT_D1_API_TOKEN || "").trim();
    const hasD1 = Boolean(accountId && databaseId && apiToken);
    const runtimeQuery = query || (hasD1 ? createD1Query({ accountId, databaseId, apiToken, fetchImpl }) : null);
    if (nexusEnabled && taskStore && runtimeQuery) {
      const adapterMap = adapters || buildReadOnlyNexusAdapters({
        rootDir: process.cwd(),
        allowedPrefixes: ["src", "tests", "docs", "app/src", "README.md", "package.json"],
        taskRepository: taskStore,
        d1Query: runtimeQuery
      });
      nexusRuntime = registerNexusRuntime(app, {
        env, fetchImpl,
        repository: taskStore,
        query: runtimeQuery,
        engine: commandApi.engine,
        registry: commandApi.registry,
        adapters: adapterMap,
        deviceRepository: store,
        ownerDeviceId: env.HABITAT_OWNER_DEVICE_ID,
        audit: entry => audit(entry.event, entry),
        handleSignals,
        exitOnSignal,
        log
      });
      nexusMount = { configured: true, reason: null };
    } else {
      const environmentBlocked = productionRuntimeBlocked || usesProductionD1;
      const reason = environmentBlocked
        ? (usesProductionD1 ? "configured D1 database is marked as production" : "runtime environment is production")
        : !nexusEnabled ? "NEXUS_RUNTIME_ENABLED is not true"
        : (taskStore ? "D1 query is not configured" : "no command task store is configured");
      nexusMount = { configured: false, reason: environmentBlocked ? "disabled_environment" : (!nexusEnabled ? "disabled_by_config" : nexusMount.reason) };
      log.warn?.("NEXUS_RUNTIME: disabled — " + reason);
    }
  } catch (error) {
    nexusMount = { configured: false, reason: "mount_failed" };
    console.error("NEXUS_RUNTIME_MOUNT_FAILED", String(error?.message || error));
  }

  /**
   * Environment identity and isolation diagnostics.
   *
   * Authenticated with the Ax bridge token. It deliberately contains no database id, no token, no
   * pairing code, and no device identifier: only booleans and this process's runtime version.
   */
  app.get("/diagnostics", requireAx, (_req, res) => {
    res.json({
      ok: true,
      service: serviceName(env),
      environment: {
        runtime: runtimeEnvironment,
        production: productionRuntimeBlocked,
        productionD1Conflict: !productionRuntimeBlocked && usesProductionD1,
        productionDatabaseUndeclared,
        productionD1Configured: Boolean(productionD1Id),
        databaseConfigured: Boolean(configuredD1Id),
        durable: Boolean(store?.durable),
        nexusEnabled
      },
      deviceBridge: {
        ready,
        storeMounted: Boolean(store),
        perDeviceTokens: true,
        axTokenConfigured: Boolean(axToken),
        breakGlassConfigured: Boolean(breakGlassToken),
        ownerDevicesConfigured: owners.size,
        pairingBootstrapConfigured: Boolean(String(env.HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH || "").trim())
      },
      runtime: { node: process.version }
    });
  });

  let initialized = false;
  let nexusInit = null;

  return Object.freeze({
    async initialize({ startWorker = true } = {}) {
      if (initialized) {
        // A failed or deferred Nexus initialization must be retryable without restarting the
        // whole bridge. startWorker=false lets the HTTP listener come up first.
        if (nexusRuntime && nexusInit && nexusInit.started !== true) {
          try {
            nexusInit = await nexusRuntime.initialize({ startWorker });
          } catch (error) {
            nexusInit = { ok: false, durable: false, started: false, reason: "initialize_failed" };
            console.error("NEXUS_RUNTIME_INIT_FAILED", String(error?.message || error));
          }
        }
        return { ok: true, durable: Boolean(store?.durable), alreadyInitialized: true, nexus: nexusInit };
      }
      if (!store) {
        console.warn("DEVICE_COMMAND_BRIDGE: disabled — D1 credentials are not configured");
        return { ok: false, durable: false, nexus: nexusMount };
      }
      await store.initialize();
      const bootstrapHash = String(env.HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH || "").trim().toLowerCase();
      const bootstrapExpiresAt = String(env.HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT || "").trim();
      const bootstrapExpiryMs = Date.parse(bootstrapExpiresAt);
      const bootstrapOwner = soleOwner();
      if (/^[a-f0-9]{64}$/.test(bootstrapHash) && Number.isFinite(bootstrapExpiryMs) && bootstrapExpiryMs > Date.now() && bootstrapOwner) {
        const ownerRevoked = typeof store.isDeviceRevoked === "function" && await store.isDeviceRevoked(bootstrapOwner);
        if (ownerRevoked) {
          console.warn("DEVICE_COMMAND_BRIDGE: bootstrap pairing skipped — owner is revoked");
        } else {
          await store.seedBootstrapPairing({
            codeHash: bootstrapHash,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(bootstrapExpiryMs).toISOString(),
            ownerDeviceId: bootstrapOwner
          });
        }
      } else if (/^[a-f0-9]{64}$/.test(bootstrapHash) && !bootstrapOwner) {
        console.warn("DEVICE_COMMAND_BRIDGE: bootstrap pairing skipped — exactly one owner is required");
      }
      ready = true;
      console.log("DEVICE_COMMAND_BRIDGE: durable D1 queue ready");
      if (nexusRuntime) {
        // Storage is ready; only now may the worker claim. A failure here leaves the device bridge
        // usable but the Nexus worker unstarted, and is reported instead of being swallowed.
        try {
          nexusInit = await nexusRuntime.initialize({ startWorker });
          console.log("NEXUS_RUNTIME_MOUNT", JSON.stringify({
            started: Boolean(nexusInit?.started),
            worker: Boolean(nexusInit?.worker),
            alreadyRunning: Boolean(nexusInit?.alreadyRunning),
            reason: nexusInit?.reason || null
          }));
        } catch (error) {
          nexusInit = { ok: false, durable: false, started: false, reason: "initialize_failed" };
          console.error("NEXUS_RUNTIME_INIT_FAILED", String(error?.message || error));
        }
      }
      initialized = true;
      return { ok: true, durable: true, nexus: nexusInit || nexusMount };
    },
    async listDevices() {
      if (!store || !ready) return [];
      return store.listDevices();
    },
    async authorizeOwnerRequest(req) {
      return authorizeOwnerRequest(req);
    },
    async requestDeviceStatus({ ownerDeviceId = null, targetDeviceId = null } = {}) {
      if (!store || !ready) return { ok: false, error: "Device command bridge is not ready." };
      if (!validDeviceId(ownerDeviceId)) return { ok: false, error: "An authenticated owner device is required." };
      if (targetDeviceId && !validDeviceId(targetDeviceId)) return { ok: false, error: "A valid target deviceId is required." };
      const rows = await store.listDevices();
      const now = Date.now();
      const candidates = rows
        .filter(row => row.owner_device_id === ownerDeviceId)
        .filter(row => !row.revoked_at && row.last_seen_at && validDeviceId(row.device_id))
        .filter(row => now - Date.parse(row.last_seen_at) <= 45 * 60 * 1000)
        .filter(row => !targetDeviceId || row.device_id === targetDeviceId)
        .sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));
      const device = candidates[0];
      if (!device) {
        return {
          ok: false,
          code: targetDeviceId ? "target_not_owned_or_offline" : "no_owned_device_online",
          error: targetDeviceId
            ? "The requested device is not owned by this owner or has not checked in recently."
            : "No device owned by this owner has checked in within the last 45 minutes."
        };
      }
      const createdAt = new Date().toISOString();
      const command = {
        id: "dc_" + randomUUID(),
        deviceId: device.device_id,
        type: "device.status",
        payload: {},
        status: "queued",
        createdAt,
        expiresAt: new Date(now + 2 * 60 * 1000).toISOString()
      };
      await store.enqueue(command);
      await audit("device.status.requested", {
        actorDeviceId: ownerDeviceId,
        targetDeviceId: device.device_id
      });
      return { ok: true, deviceId: device.device_id, commandId: command.id, status: command.status };
    },
    async getCommand(id) {
      if (!store || !ready) return null;
      return store.get(String(id || ""));
    },
    status() {
      return {
        ready,
        durable: Boolean(store?.durable),
        axTokenConfigured: Boolean(axToken),
        breakGlassConfigured: Boolean(breakGlassToken),
        perDeviceTokens: true,
        service: serviceName(env),
        environment: {
          runtime: runtimeEnvironment,
          production: productionRuntimeBlocked,
          productionD1Conflict: !productionRuntimeBlocked && usesProductionD1,
          productionDatabaseUndeclared,
          productionD1Configured: Boolean(productionD1Id),
          databaseConfigured: Boolean(configuredD1Id),
          durable: Boolean(store?.durable),
          nexusEnabled
        },
        nexus: nexusRuntime ? { configured: true, ...nexusRuntime.status() } : nexusMount
      };
    },
    nexus() {
      return nexusRuntime;
    },
    async startNexusWorker() {
      if (!nexusRuntime) return { ok: false, started: false, reason: nexusMount.reason || "not_mounted" };
      try {
        // A deferred startup or a failed initialization is retryable here. This is the path the
        // server uses after listen(), so a transient D1 failure does not permanently disable work.
        if (!ready || !nexusInit || nexusInit.ok === false) {
          nexusInit = await nexusRuntime.initialize({ startWorker: true });
          return { ok: Boolean(nexusInit?.started), ...nexusInit };
        }
        const result = await nexusRuntime.startWorker();
        nexusInit = { ...(nexusInit || {}), ...result };
        return { ok: true, ...result };
      } catch (error) {
        console.error("NEXUS_RUNTIME_START_FAILED", String(error?.message || error));
        return { ok: false, started: false, reason: "start_failed" };
      }
    },
    async shutdown(reason = "shutdown") {
      if (!nexusRuntime) return { ok: false, reason: "not_mounted" };
      await nexusRuntime.shutdown(reason);
      return { ok: true, reason };
    }
  });
}
