import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createD1DeviceCommandRepository } from "./d1-device-command-repository.mjs";
import { registerHomeBridgeConsole } from "./home-bridge-console.mjs";
import { registerDeviceHabitat } from "./device-habitat.mjs";
import { registerUniversalCommandRoutes } from "./command-routes.mjs";
import { createD1Query, registerNexusRuntime } from "./nexus-runtime.mjs";
import { buildReadOnlyNexusAdapters } from "./nexus-adapter-registration.mjs";

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
  const hasD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]
    .every(key => String(env[key] || "").trim());
  const store = repository || (hasD1 ? createD1DeviceCommandRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);

  const axToken = String(env.HABITAT_AX_BRIDGE_TOKEN || "");
  const nexusEnabled = String(env.NEXUS_RUNTIME_ENABLED || "").trim().toLowerCase() === "true";
  const owners = new Set();
  for (const value of [env.HABITAT_OWNER_DEVICE_ID, env.HABITAT_OWNER_DEVICE_IDS]) {
    String(value || "").split(",").map(part => part.trim()).filter(Boolean).forEach(id => owners.add(id));
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

      async function issueToken(recovered) {
        // A revoked device must not be revived by a consumed-code recovery or a fresh code. An
        // owner must explicitly un-revoke it first.
        if (typeof store.isDeviceRevoked === "function" && await store.isDeviceRevoked(deviceId)) {
          return res.status(403).json({
            ok: false,
            code: "device_revoked",
            error: "This device is revoked. An owner must explicitly restore it before pairing again."
          });
        }
        const deviceToken = randomBytes(32).toString("base64url");
        await store.registerDevice({ deviceId, tokenHash: digest(deviceToken), createdAt: now });
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

      const paired = await store.consumePairing({ codeHash, deviceId, consumedAt: now });
      if (paired) return issueToken(false);

      // A failed exchange is explained, not just refused: the phone must be able to tell the owner
      // whether to ask for a new code. The code itself is never returned here.
      const pairing = typeof store.findPairing === "function" ? await store.findPairing({ codeHash }) : null;
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
        // The same code, already consumed by this device, means the first response was lost
        // (app closed, network dropped). Recover instead of punishing the owner with a new code;
        // the old token stops working because registerDevice replaces its hash.
        if (pairing.deviceId === deviceId) return issueToken(true);
        return res.status(409).json({
          ok: false,
          code: "pairing_used_other_device",
          error: "This pairing code was already used by another device. Generate a fresh code."
        });
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
        revoked: Boolean(row.revoked_at)
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
      return res.json({ ok: true, deviceId, revoked: true });
    } catch (error) {
      console.error("DEVICE_REVOKE_FAILED", String(error?.message || error));
      return res.status(500).json({ ok: false, error: "Unable to revoke device." });
    }
  });

  // Revocation is never undone by pairing. This is the only owner-authorized recovery path.
  app.post("/device/owner/devices/:deviceId/unrevoke", requireStore, async (req, res) => {
    const targetDeviceId = String(req.params.deviceId || "").trim();
    const ownerDeviceId = String(req.headers?.["x-owner-device-id"] || "").trim();
    const ownerToken = bearer(req);
    if (!validDeviceId(targetDeviceId)) return res.status(400).json({ ok: false, error: "A valid deviceId is required." });
    if (!owners.size) return res.status(503).json({ ok: false, error: "Owner authorization is not configured." });
    try {
      if (!validDeviceId(ownerDeviceId) || !ownerToken || !(await store.verifyDeviceToken(ownerToken, ownerDeviceId)) || !owners.has(ownerDeviceId)) {
        return res.status(401).json({ ok: false, error: "A valid configured owner device is required." });
      }
      if (typeof store.unrevokeDevice !== "function") {
        return res.status(501).json({ ok: false, error: "This device store cannot un-revoke devices." });
      }
      await store.unrevokeDevice(targetDeviceId);
      return res.json({ ok: true, deviceId: targetDeviceId, revoked: false });
    } catch (error) {
      console.error("DEVICE_UNREVOKE_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Unable to restore the device." });
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
  app.post("/bridge/console/pairing", (consoleApi?.requireOperator || requireAx), requireStore, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      if (deviceId && !validDeviceId(deviceId)) {
        return res.status(400).json({ ok: false, error: "A valid deviceId is required when one is supplied." });
      }
      const code = randomBytes(16).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
      // Without a device id the code is bound to the first device that uses it.
      await store.createPairing({ codeHash: digest(code), deviceId: deviceId || "*", createdAt, expiresAt });
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
      ownerDeviceId: env.HABITAT_OWNER_DEVICE_ID
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
        handleSignals,
        exitOnSignal,
        log
      });
      nexusMount = { configured: true, reason: null };
    } else {
      const reason = !nexusEnabled ? "NEXUS_RUNTIME_ENABLED is not true" :
        (taskStore ? "D1 query is not configured" : "no command task store is configured");
      nexusMount = { configured: false, reason: !nexusEnabled ? "disabled_by_config" : nexusMount.reason };
      log.warn?.("NEXUS_RUNTIME: disabled — " + reason);
    }
  } catch (error) {
    nexusMount = { configured: false, reason: "mount_failed" };
    console.error("NEXUS_RUNTIME_MOUNT_FAILED", String(error?.message || error));
  }

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
      if (/^[a-f0-9]{64}$/.test(bootstrapHash) && Number.isFinite(bootstrapExpiryMs) && bootstrapExpiryMs > Date.now()) {
        await store.seedBootstrapPairing({
          codeHash: bootstrapHash,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(bootstrapExpiryMs).toISOString()
        });
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
    async requestDeviceStatus() {
      if (!store || !ready) return { ok: false, error: "Device command bridge is not ready." };
      const rows = await store.listDevices();
      const now = Date.now();
      const device = rows
        .filter(row => !row.revoked_at && row.last_seen_at && validDeviceId(row.device_id))
        .filter(row => now - Date.parse(row.last_seen_at) <= 45 * 60 * 1000)
        .sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at))[0];
      if (!device) return { ok: false, error: "No paired device has checked in within the last 45 minutes." };
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
        perDeviceTokens: true,
        nexus: nexusRuntime ? { configured: true, ...nexusRuntime.status() } : nexusMount
      };
    },
    nexus() {
      return nexusRuntime;
    },
    async startNexusWorker() {
      if (!nexusRuntime) return { ok: false, started: false, reason: nexusMount.reason || "not_mounted" };
      if (!ready) return { ok: false, started: false, reason: "not_initialized" };
      try {
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
