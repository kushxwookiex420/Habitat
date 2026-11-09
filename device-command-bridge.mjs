import { randomUUID, timingSafeEqual } from "node:crypto";
import { createD1DeviceCommandRepository } from "./d1-device-command-repository.mjs";

const SAFE_COMMANDS = new Set(["device.status"]);

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
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
  const deviceToken = String(env.HABITAT_DEVICE_BRIDGE_TOKEN || "");

  function requireAuth(token, label) {
    return (req, res, next) => {
      if (!token || !safeEqual(bearer(req), token)) {
        return res.status(401).json({ ok: false, error: label + " authentication required." });
      }
      next();
    };
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

  let ready = false;
  const axAuth = requireAuth(axToken, "Ax bridge");
  const phoneAuth = requireAuth(deviceToken, "Device bridge");

  app.post("/ax/device/commands", axAuth, requireStore, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      const type = String(req.body?.type || "").trim();
      if (!deviceId || deviceId.length > 128 || !SAFE_COMMANDS.has(type)) {
        return res.status(400).json({ ok: false, error: "A valid deviceId and allowlisted command type are required." });
      }
      const command = {
        id: "dc_" + randomUUID(),
        deviceId,
        type,
        payload: {},
        status: "queued",
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

  app.get("/device/commands/next", phoneAuth, requireStore, async (req, res) => {
    try {
      const deviceId = String(req.query?.deviceId || "").trim();
      if (!deviceId || deviceId.length > 128) {
        return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
      }
      const command = await store.claimNext(deviceId);
      return res.json({ ok: true, command: command ? {
        id: command.id, type: command.type, payload: command.payload, expiresAt: command.expiresAt
      } : null });
    } catch (error) {
      console.error("DEVICE_COMMAND_CLAIM_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to claim device command." });
    }
  });

  app.post("/device/commands/:id/result", phoneAuth, requireStore, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      const result = req.body?.result;
      if (!deviceId || !result || typeof result !== "object" || Array.isArray(result)) {
        return res.status(400).json({ ok: false, error: "A deviceId and structured result are required." });
      }
      const completed = await store.complete({
        id: String(req.params.id || ""),
        deviceId,
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

  app.get("/ax/device/commands/:id", axAuth, requireStore, async (req, res) => {
    try {
      const command = await store.get(String(req.params.id || ""));
      if (!command) return res.status(404).json({ ok: false, error: "Command not found." });
      return res.json({ ok: true, command });
    } catch (error) {
      console.error("DEVICE_COMMAND_READ_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to read device command." });
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
      return { ready, durable: Boolean(store?.durable), axTokenConfigured: Boolean(axToken), deviceTokenConfigured: Boolean(deviceToken) };
    }
  });
}
