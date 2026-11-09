import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createD1DeviceCommandRepository } from "./d1-device-command-repository.mjs";

const SAFE_COMMANDS = new Set(["device.status"]);
const PAIRING_TTL_MS = 10 * 60 * 1000;

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

export function registerDeviceCommandBridge(app, {
  env = process.env,
  fetchImpl = fetch,
  repository = null
} = {}) {
  const hasD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]
    .every(key => String(env[key] || "").trim());
  const store = repository || (hasD1 ? createD1DeviceCommandRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);

  const axToken = String(env.HABITAT_AX_BRIDGE_TOKEN || "");

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
      const code = randomBytes(16).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
      await store.createPairing({ codeHash: digest(code), deviceId, createdAt, expiresAt });
      return res.status(201).json({ ok: true, pairing: { code, deviceId, expiresAt, singleUse: true } });
    } catch (error) {
      console.error("DEVICE_PAIRING_CREATE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to create device pairing." });
    }
  });

  // The phone exchanges the one-time code for a per-device bearer token.
  // The raw token is returned once and never stored server-side.
  app.post("/device/pair", requireStore, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      const code = String(req.body?.code || "").trim();
      if (!validDeviceId(deviceId) || code.length < 20 || code.length > 128) {
        return res.status(400).json({ ok: false, error: "A valid deviceId and pairing code are required." });
      }
      const now = new Date().toISOString();
      const paired = await store.consumePairing({ codeHash: digest(code), deviceId, consumedAt: now });
      if (!paired) return res.status(401).json({ ok: false, error: "Pairing code is invalid, expired, or already used." });
      const deviceToken = randomBytes(32).toString("base64url");
      await store.registerDevice({ deviceId, tokenHash: digest(deviceToken), createdAt: now });
      return res.status(200).json({ ok: true, device: { deviceId, token: deviceToken } });
    } catch (error) {
      console.error("DEVICE_PAIRING_EXCHANGE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to complete device pairing." });
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
      return res.json({ ok: true, deviceId, revoked: true });
    } catch (error) {
      console.error("DEVICE_REVOKE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to revoke device." });
    }
  });

  return Object.freeze({
    async initialize() {
      if (!store) {
        console.warn("DEVICE_COMMAND_BRIDGE: disabled — D1 credentials are not configured");
        return { ok: false, durable: false };
      }
      await store.initialize();
      ready = true;
      console.log("DEVICE_COMMAND_BRIDGE: durable D1 queue ready");
      return { ok: true, durable: true };
    },
    status() {
      return { ready, durable: Boolean(store?.durable), axTokenConfigured: Boolean(axToken), perDeviceTokens: true };
    }
  });
}
