import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createD1DeviceCommandRepository } from "./d1-device-command-repository.mjs";
import { registerHomeBridgeConsole } from "./home-bridge-console.mjs";
import { registerDeviceHabitat } from "./device-habitat.mjs";
import { registerUniversalCommandRoutes } from "./command-routes.mjs";
import { createD1Query, registerNexusRuntime } from "./nexus-runtime.mjs";
import { buildReadOnlyNexusAdapters, READ_ONLY_ADAPTER_NAMES, READ_ONLY_ADAPTER_PREFIXES } from "./nexus-adapter-registration.mjs";
import { createAxOrchestrator, resolveAxOrchestratorConfig } from "./ax-orchestrator.mjs";
import {
  createAxPlannerFromProviderConfig,
  createProviderCircuitBreaker,
  describeProviderStatus,
  resolveAxProviderConfig
} from "./ax-providers.mjs";
import { createD1AxRunRepository } from "./d1-ax-run-repository.mjs";
import { createD1AxMemoryRepository } from "./d1-ax-memory-repository.mjs";
import { createAxMemoryContext } from "./ax-memory-context.mjs";
import { createD1AxNotificationRepository } from "./d1-ax-notification-repository.mjs";
import { createNotificationService } from "./ax-notifications.mjs";
import { createAxDiagnostics } from "./ax-diagnostics.mjs";
import { createObjectiveService } from "./ax-objectives.mjs";
import { createD1AxObjectiveRepository } from "./ax-objective-repository.mjs";
import { createAgentRuntime } from "./ax-agents.mjs";
import { createIncidentService, createOperationalMonitor, createRecoveryService } from "./ax-recovery.mjs";
import { createD1AxIncidentRepository } from "./ax-incident-repository.mjs";
import { createSecurityEventService } from "./ax-security-events.mjs";
import { createD1AxSecurityEventRepository } from "./ax-security-event-repository.mjs";
import { createSchedulerService } from "./ax-scheduler.mjs";
import { createD1SchedulerRepository } from "./ax-scheduler-repository.mjs";
import { createProjectRegistry } from "./ax-projects.mjs";
import { resolveAgentTransports } from "./ax-agent-transports.mjs";
import { detectSandbox } from "./nexus-sandbox.mjs";
import { createD1AxMessageRepository } from "./d1-ax-message-repository.mjs";
import { createMessageChannel } from "./ax-message-channel.mjs";
import { autonomousPolicy, dispatchObjective } from "./ax-objective-dispatch.mjs";

const SAFE_COMMANDS = new Set(["device.status"]);
const PAIRING_TTL_MS = 10 * 60 * 1000;
// The read-only adapter path allowlist lives in nexus-adapter-registration so the mounted runtime
// and the one-shot tick cannot drift apart. It resolves symlinks and refuses anything outside these
// prefixes, so a command objective cannot read the host filesystem.

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
  // Optional injection points for tests and embedded use. In a deployment every one of these is
  // derived from the same env object, so /ax/command and the Nexus worker can only ever address
  // one database: the D1 id named by HABITAT_D1_DATABASE_ID.
  taskRepository = null,
  query = null,
  adapters = null,
  // Optional injection for tests/embedders. In a deployment both are derived from the same D1
  // database as every other store, so memory and notifications can never point somewhere else.
  memoryRepository = null,
  notificationRepository = null,
  objectiveRepository = null,
  incidentRepository = null,
  securityRepository = null,
  schedulerRepository = null,
  // Mission 14: the durable Ax <-> NEXUS message store. On a deployment it is created on the same
  // D1 database as every other additive store; embedders and tests may inject one.
  messageRepository = null,
  handleSignals = false,
  exitOnSignal = false,
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

  // Durable Ax memory and notification events are additive stores on the same database. They are
  // independent of task execution: if either is unavailable, planning and execution still work and
  // the control center reports the capability as unavailable instead of losing the run.
  const memoryProject = String(env.HABITAT_AX_MEMORY_PROJECT || "habitat").trim().toLowerCase() || "habitat";
  const memoryStore = memoryRepository || (hasD1 ? createD1AxMemoryRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const notificationStore = notificationRepository || (hasD1 ? createD1AxNotificationRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const notifications = notificationStore ? createNotificationService({ repository: notificationStore, project: memoryProject, log }) : null;
  const memoryContext = memoryStore ? createAxMemoryContext({ repository: memoryStore, project: memoryProject, log }) : null;

  // Mission 10 additive stores: durable objective lifecycles and incident history. Both live on the
  // same D1 database as everything else and neither replaces a task table.
  const objectiveStore = objectiveRepository || (hasD1 ? createD1AxObjectiveRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const objectives = objectiveStore ? createObjectiveService({ repository: objectiveStore, log }) : null;
  const incidentStore = incidentRepository || (hasD1 ? createD1AxIncidentRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const incidents = incidentStore ? createIncidentService({ repository: incidentStore, log }) : null;
  // Append-only security audit and the trigger-agnostic scheduler. Both are additive stores on the
  // same database; if either is absent, its surface reports 503 instead of pretending to work.
  const securityStore = securityRepository || (hasD1 ? createD1AxSecurityEventRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const securityEvents = securityStore ? createSecurityEventService({ repository: securityStore, log }) : null;
  const schedulerStore = schedulerRepository || (hasD1 ? createD1SchedulerRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  // The Ax <-> NEXUS message channel. Only read-only adapters are allowed through it, and the
  // channel never executes anything itself: the scheduler's autonomy pass does, under a lease.
  const messageStore = messageRepository || (hasD1 ? createD1AxMessageRepository({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  }) : null);
  const messages = messageStore ? createMessageChannel({
    repository: messageStore,
    allowedAdapters: READ_ONLY_ADAPTER_NAMES,
    security: securityEvents,
    notifications,
    project: memoryProject,
    log
  }) : null;
  let schedulerRef = null;
  function resolveScheduler() {
    if (!schedulerStore) return null;
    if (schedulerRef) return schedulerRef;
    schedulerRef = createSchedulerService({
      ticks: schedulerStore,
      recovery: resolveRecovery(),
      objectives,
      // Only a configured run store can prove a bound reservation is dead. When it is unavailable,
      // getRun throws and the scheduler keeps the reservation rather than freeing budget blindly.
      runs: {
        async getRun(runId) {
          if (!axOrchestrator?.enabled) throw new Error("run_store_unavailable");
          return axOrchestrator.getRun(runId);
        }
      },
      notifications,
      // One bounded autonomy pass per tick, under the same lease as recovery.
      autonomy: () => runAutonomy(),
      log
    });
    return schedulerRef;
  }

  /**
   * Autonomous execution, run once per scheduler tick while the tick lease is held.
   *
   * 1. Drain the Ax message channel: submit queued messages through the same idempotent engine key,
   *    reconcile working ones from their task rows, and dead-letter after the retry limit.
   * 2. Advance objectives that are eligible under `autonomousPolicy`: owner-authorized work, or a
   *    low-risk plan that needs no approval and names no prohibited permission.
   *
   * Nothing here approves anything, spends outside a reservation, or completes an objective. A
   * failure is reported in the tick report and retried on a later tick, never silently swallowed.
   */
  async function runAutonomy() {
    const report = { ok: true, messages: null, objectives: null };
    if (messages) {
      try {
        report.messages = await messages.drain({
          execute: async message => {
            if (!commandApi?.engine) {
              return { ok: false, code: "executor_unavailable", message: "The command engine is not mounted.", retryable: true };
            }
            const submitted = await commandApi.engine.submit({
              objective: message.objective || message.body,
              requestedBy: "ax",
              role: "ax",
              adapter: message.adapter,
              // Deterministic per message: a crash after the claim re-submits the same key and the
              // engine returns the original task instead of creating a second one.
              idempotencyKey: "message:" + message.id
            });
            if (submitted.ok !== true) {
              return {
                ok: false,
                code: submitted.code || "submit_failed",
                message: submitted.error || null,
                retryable: submitted.code !== "adapter_not_allowed"
              };
            }
            return { ok: true, taskId: submitted.task.id };
          },
          check: async message => {
            if (!commandApi?.engine || !message.taskId) return { status: "working" };
            const read = await commandApi.engine.get(message.taskId);
            if (!read || read.ok === false || !read.task) return { status: "working" };
            const task = read.task;
            if (task.status === "done") {
              return { status: "done", result: { summary: task.result?.summary || "adapter completed", evidence: task.result?.evidence || [] } };
            }
            if (task.status === "failed" || task.status === "cancelled") {
              return { status: "failed", error: { code: task.status, message: task.error || null }, retryable: false };
            }
            return { status: "working" };
          }
        });
      } catch (error) {
        log.error?.("AX_AUTONOMY_MESSAGE_DRAIN_FAILED", String(error?.message || error).slice(0, 160));
        report.messages = { ok: false, code: "message_drain_failed" };
      }
    }

    const orchestrator = typeof orchestratorResolver === "function" ? orchestratorResolver() : null;
    if (objectives && orchestrator?.enabled) {
      const advanced = [];
      let rows = [];
      try {
        rows = await objectives.list({ limit: 20 });
      } catch (error) {
        report.objectives = { ok: false, code: "objective_list_failed" };
      }
      for (const row of rows) {
        const policy = autonomousPolicy(row);
        if (!policy.ok) continue;
        try {
          const started = await objectives.start(row.id, { by: "nexus-autonomy" });
          if (started.ok !== true) {
            advanced.push({ id: row.id, ok: false, code: started.code || "start_failed" });
            continue;
          }
          const dispatched = await dispatchObjective({
            objectives,
            orchestrator,
            objectiveId: row.id,
            recordSecurity: entry => securityEvents?.record(entry),
            by: "nexus-autonomy"
          });
          advanced.push({ id: row.id, ok: dispatched.ok === true, code: dispatched.code || null, runId: dispatched.run?.id || null });
        } catch (error) {
          log.error?.("AX_AUTONOMY_OBJECTIVE_FAILED", String(error?.message || error).slice(0, 160));
          advanced.push({ id: row.id, ok: false, code: "autonomy_error" });
        }
      }
      report.objectives = { ok: true, examined: rows.length, advanced };
    } else if (objectives) {
      report.objectives = { ok: false, code: orchestrator?.code || "orchestrator_not_resolved", reason: "objective autonomy needs a configured Ax run store" };
    }
    return report;
  }
  const projects = createProjectRegistry({ objectives, memory: memoryContext });
  const agentTransports = resolveAgentTransports(env);
  const circuitBreaker = createProviderCircuitBreaker({
    failureThreshold: Number(env.AX_CIRCUIT_FAILURES) || 3,
    cooldownMs: Number(env.AX_CIRCUIT_COOLDOWN_MS) || 60_000
  });

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
      securityEvents?.record({
        category: "device.pairing",
        severity: "info",
        outcome: "recorded",
        actor: "ax",
        deviceId,
        correlationId: String(req.headers?.["x-correlation-id"] || "").slice(0, 120) || null,
        summary: "Pairing challenge issued (single use, short lived)",
        evidence: JSON.stringify({ expiresAt, singleUse: true })
      }).catch?.(() => {});
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
        const deviceToken = randomBytes(32).toString("base64url");
        await store.registerDevice({ deviceId, tokenHash: digest(deviceToken), createdAt: now });
        securityEvents?.record({
          category: "device.pairing",
          severity: "info",
          outcome: "allowed",
          actor: "device:" + deviceId,
          deviceId,
          summary: recovered ? "Pairing exchange recovered after a lost response" : "Pairing exchange completed; device token issued",
          evidence: JSON.stringify({ recovered })
        }).catch?.(() => {});
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
  //
  // Owner-only actions (approve/deny/complete/fail/cancel/retry) are verified against the DEVICE
  // repository, never the command-task repository: only the device store holds token hashes. When
  // no device verifier is available those routes answer 503 instead of trusting the caller.
  // Declared before the command routes because /ax/command/presence reports on the executor
  // mounted further down. The closures read them at request time, after mounting has finished.
  let nexusRuntime = null;
  let nexusMount = { configured: false, reason: "command_store_unavailable" };
  // Resolved on the first run request, once the engine and the runtime exist. `undefined` means
  // "not resolved yet"; a resolved failure is cached as null or a disabled descriptor.
  let axOrchestrator;
  // Captured from the provider closure below so the autonomy pass can resolve the orchestrator
  // without waiting for an HTTP request to do it first.
  let orchestratorResolver = null;
  let commandApi = null;
  // Resolved after mounting, because diagnostics probe the engine and runtime this function builds.
  let diagnosticsRef = () => ({ status: "not_ready", note: "Diagnostics are not mounted yet." });
  let agentRuntimeRef = null;
  let recoveryRef = null;
  try {
    commandApi = registerUniversalCommandRoutes(app, {
      env,
      fetchImpl,
      repository: taskRepository,
      deviceRepository: store,
      ownerDeviceId: env.HABITAT_OWNER_DEVICE_ID,
      ownerDeviceIds: env.HABITAT_OWNER_DEVICE_IDS,
      // Ax asks whether NEXUS can execute. The answer comes from the mounted runtime; without one
      // it is "not mounted" plus the mount reason, never a guess.
      presenceProvider: async () => {
        if (nexusRuntime && typeof nexusRuntime.presence === "function") {
          return nexusRuntime.presence();
        }
        return {
          executor: { configured: false, started: false, state: "not_mounted", reason: nexusMount.reason },
          heartbeat: { verified: false, liveWorkers: 0, asleep: true, lastHeartbeatAgeSeconds: null },
          queue: { ok: false, error: "executor_not_mounted" },
          canExecute: false
        };
      },
      // Habitat-native Ax. Built lazily so it can use the engine this call creates and the runtime
      // mounted after it, without either of them owning a second task store.
      memoryProvider: () => memoryStore,
      memoryProject,
      notificationProvider: () => notifications,
      providerStatusProvider: () => describeProviderStatus(resolveAxProviderConfig(env)),
      // Diagnostics are assembled per request: every subsystem is probed, and a probe failure is
      // reported as unavailable rather than turning into a false green status.
      diagnosticsProvider: () => diagnosticsRef(),
      // Mission 10 surfaces. Each provider closure reads the mounted state at request time.
      objectiveProvider: () => objectives,
      agentProvider: () => resolveAgents(),
      recoveryProvider: () => resolveRecovery(),
      incidentProvider: () => incidents,
      securityProvider: () => securityEvents,
      schedulerProvider: () => resolveScheduler(),
      projectProvider: () => projects,
      deviceStateProvider: () => deviceSnapshot(),
      circuitProvider: () => circuitBreaker,
      budgetProvider: () => ({
        currency: "USD",
        runBudgetUsd: resolveAxOrchestratorConfig(env).budgetUsd,
        enforced: ["per_run", "per_objective"],
        note: "Budgets are enforced before/after paid calls. A configured budget is not a record of spend; see the objective and run records."
      }),
      orchestratorProvider: (orchestratorResolver = () => {
        if (axOrchestrator !== undefined) return axOrchestrator;
        axOrchestrator = null;
        try {
          // The provider layer owns which model account Ax spends against. `AX_PROVIDER` defaults to
          // openai, so an existing OPENAI_API_KEY + AX_MODEL deployment behaves exactly as before;
          // Gemini and OpenRouter (and optional fallbacks) are additive configuration.
          const providerConfig = resolveAxProviderConfig(env);
          const axConfig = {
            ...resolveAxOrchestratorConfig(env),
            enabled: providerConfig.enabled,
            code: providerConfig.code,
            error: providerConfig.error,
            apiKey: providerConfig.primary?.apiKey || "",
            model: providerConfig.primary?.model || "",
            baseUrl: providerConfig.primary?.baseUrl || "",
            provider: describeProviderStatus(providerConfig)
          };
          const runStore = hasD1
            ? createD1AxRunRepository({
                accountId: env.CLOUDFLARE_ACCOUNT_ID,
                databaseId: env.HABITAT_D1_DATABASE_ID,
                apiToken: env.HABITAT_D1_API_TOKEN,
                fetchImpl
              })
            : null;
          if (!axConfig.enabled) {
            axOrchestrator = { enabled: false, code: axConfig.code, error: axConfig.error };
          } else if (!commandApi?.engine || !runStore) {
            axOrchestrator = {
              enabled: false,
              code: "run_store_unavailable",
              error: "Habitat-native Ax needs the command engine and D1 to record its runs."
            };
          } else {
            axOrchestrator = createAxOrchestrator({
              engine: commandApi.engine,
              // In-process execution when the runtime is mounted; otherwise the run is queued for
              // the cron executor and says so instead of spinning.
              execute: nexusRuntime && typeof nexusRuntime.tick === "function" ? () => nexusRuntime.tick() : null,
              planner: createAxPlannerFromProviderConfig(providerConfig, {
                fetchImpl,
                prices: axConfig.prices,
                maxSteps: axConfig.maxSteps,
                maxOutputTokens: axConfig.maxOutputTokens,
                reasoningEffort: axConfig.reasoningEffort,
                failedCallCostUsd: axConfig.failedCallCostUsd,
                // A provider that keeps failing transiently is skipped for a cooldown instead of
                // being paid for on every request. The decision is visible in the run record.
                breaker: circuitBreaker
              }),
              runs: runStore,
              // Approved memory is retrieved before planning and written back after verification.
              memory: memoryContext,
              // Durable operational events for the control center. Inbox only; no push transport.
              notify: notifications ? event => notifications.record(event) : null,
              // The planner may only choose adapters the worker actually has, never the registry's
              // full read-only surface.
              adapters: READ_ONLY_ADAPTER_NAMES,
              config: axConfig,
              log
            });
            Promise.resolve(axOrchestrator.initialize()).catch(error =>
              log.error?.("AX_RUN_STORE_INIT_FAILED", String(error?.message || error))
            );
          }
        } catch (error) {
          axOrchestrator = { enabled: false, code: "orchestrator_init_failed", error: String(error?.message || error) };
        }
        return axOrchestrator;
      }),
      // Mission 14: the durable Ax <-> NEXUS message channel.
      messageProvider: () => messages
    });
  } catch (error) {
    console.error("UNIVERSAL_COMMAND_MOUNT_FAILED", String(error?.message || error));
  }

  // Nexus runtime — the executor for the SAME habitat_command_tasks rows /ax/command writes. It
  // never touches habitat_tasks or the device command queue. Mounting is fail-closed on three
  // independent conditions:
  //   1. NEXUS_RUNTIME_ENABLED is exactly "true". Off by default: an unproven worker must not
  //      start itself on a live service.
  //   2. a command task store exists (D1 configured, or injected by an embedder).
  //   3. the atomic claim query exists, built from the same account/database/token as that store.
  // The worker is constructed here; it starts from initialize(), after storage is ready.
  const nexusRequested = String(env.NEXUS_RUNTIME_ENABLED || "").trim().toLowerCase() === "true";
  try {
    const commandStore = commandApi?.store?.() || null;
    const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
    const databaseId = String(env.HABITAT_D1_DATABASE_ID || "").trim();
    const apiToken = String(env.HABITAT_D1_API_TOKEN || "").trim();
    const hasCommandD1 = Boolean(accountId && databaseId && apiToken);
    const runtimeQuery = query || (hasCommandD1 ? createD1Query({ accountId, databaseId, apiToken, fetchImpl }) : null);
    if (!nexusRequested) {
      nexusMount = { configured: false, reason: "disabled_by_config" };
      log.warn?.("NEXUS_RUNTIME: disabled — NEXUS_RUNTIME_ENABLED is not true");
    } else if (!commandStore || !runtimeQuery) {
      nexusMount = { configured: false, reason: "command_store_unavailable" };
      log.warn?.("NEXUS_RUNTIME: disabled — no D1 command task store is configured");
    } else {
      const adapterMap = adapters || buildReadOnlyNexusAdapters({
        rootDir: process.cwd(),
        allowedPrefixes: READ_ONLY_ADAPTER_PREFIXES,
        taskRepository: commandStore,
        d1Query: runtimeQuery
      });
      nexusRuntime = registerNexusRuntime(app, {
        env,
        fetchImpl,
        repository: commandStore,
        query: runtimeQuery,
        engine: commandApi.engine,
        registry: commandApi.registry,
        adapters: adapterMap,
        deviceRepository: store,
        ownerDeviceId: env.HABITAT_OWNER_DEVICE_ID,
        ownerDeviceIds: env.HABITAT_OWNER_DEVICE_IDS,
        handleSignals,
        exitOnSignal,
        log
      });
      nexusMount = { configured: true, reason: null };
    }
  } catch (error) {
    nexusMount = { configured: false, reason: "mount_failed" };
    console.error("NEXUS_RUNTIME_MOUNT_FAILED", String(error?.message || error));
  }

  /** One agent runtime per process: delegation counters and limits must be shared, not per request. */
  function resolveAgents() {
    if (agentRuntimeRef) return agentRuntimeRef;
    agentRuntimeRef = createAgentRuntime({
      log,
      dependencies: {
        memory: memoryContext,
        diagnostics: () => diagnosticsRef(),
        device: { state: () => deviceSnapshot() },
        adapters: READ_ONLY_ADAPTER_NAMES.slice(),
        allowedAdapters: READ_ONLY_ADAPTER_NAMES.slice(),
        sideEffectsEnabled: false,
        // Off unless AX_AGENT_LOCAL_ROOT names a bounded local repository. With no root, both agents
        // keep reporting capability_unavailable rather than fabricating a result.
        research: agentTransports.research,
        engineering: agentTransports.engineering,
        transportRoot: agentTransports.root || null,
        onSecurityEvent: entry => securityEvents?.record({
          category: "agent.permission_violation",
          severity: "high",
          outcome: "denied",
          actor: "agent:" + (entry?.agent || "unknown"),
          summary: entry?.summary || "Agent result rejected by Ax review",
          evidence: entry?.evidence || null
        })
      }
    });
    return agentRuntimeRef;
  }

  /** The server's honest view of the phone: one device row, its recent receipts and last pairing. */
  async function deviceSnapshot({ deviceId = null } = {}) {
    if (!store || !ready) return { ok: false, error: "device_bridge_not_ready" };
    let rows = [];
    try {
      rows = await store.listDevices();
    } catch (error) {
      return { ok: false, error: "device_store_unavailable: " + String(error?.message || error).slice(0, 120) };
    }
    const active = rows.filter(row => !row.revoked_at);
    const ordered = (active.length ? active : rows).slice().sort((a, b) => Date.parse(b.last_seen_at || b.created_at || 0) - Date.parse(a.last_seen_at || a.created_at || 0));
    const chosen = deviceId ? rows.find(row => row.device_id === deviceId) || null : ordered[0] || null;
    if (!chosen) return { ok: true, device: null, commands: [], pairing: null };
    let commands = [];
    let pairing = null;
    try {
      if (typeof store.listCommands === "function") commands = await store.listCommands({ deviceId: chosen.device_id, limit: 20 });
      if (typeof store.latestPairing === "function") pairing = await store.latestPairing({ deviceId: chosen.device_id });
    } catch {
      // Receipts are optional context for the derived state; the device row is still returned.
    }
    return { ok: true, device: chosen, commands, pairing };
  }

  /**
   * Monitoring and safe recovery. Repairs are listed here explicitly so an audit can see exactly
   * which reversible actions exist; nothing destructive is registered.
   */
  function resolveRecovery() {
    if (!incidents) return null;
    if (recoveryRef) return recoveryRef;
    const monitor = createOperationalMonitor({
      engine: commandApi?.engine || null,
      orchestrator: {
        listRuns: async options => {
          const agent = axOrchestrator;
          return agent && agent.enabled ? agent.listRuns(options) : [];
        }
      },
      presence: async () => {
        if (nexusRuntime && typeof nexusRuntime.presence === "function") return nexusRuntime.presence();
        return {
          executor: { configured: false, started: false, state: "not_mounted", reason: nexusMount.reason },
          heartbeat: { verified: false, liveWorkers: 0, asleep: true },
          queue: { ok: false, error: "executor_not_mounted" },
          canExecute: false
        };
      },
      devices: async () => (store && ready ? store.listDevices() : []),
      notifications,
      log
    });
    const repairs = {
      reconcile_run: async ({ incident }) => {
        const runId = String(incident.subject || "").replace(/^run:/, "");
        const agent = axOrchestrator;
        if (!agent || !agent.enabled || !runId) return { ok: false, detail: "the Ax run store is not available" };
        const run = await agent.getRun(runId);
        if (!run) return { ok: false, detail: "run not found" };
        return {
          ok: true,
          verified: run.settled === true || run.status === "completed",
          detail: "run reconciled: status=" + run.status + " settled=" + Boolean(run.settled)
        };
      },
      probe_subsystems: async () => {
        const report = await diagnosticsRef();
        const statuses = ["database", "memory", "providers", "scheduler", "deviceBridge"]
          .map(key => key + "=" + (report?.[key]?.status || report?.[key]?.state || "unknown"));
        return { ok: true, verified: true, detail: "probed: " + statuses.join(", ") };
      },
      start_scheduler: async () => {
        if (!nexusRuntime) return { ok: false, detail: "the NEXUS runtime is not mounted" };
        await nexusRuntime.startWorker();
        const presence = typeof nexusRuntime.presence === "function" ? await nexusRuntime.presence() : null;
        return {
          ok: true,
          verified: Boolean(presence?.executor?.started),
          detail: "worker started=" + Boolean(presence?.executor?.started)
        };
      },
      request_device_checkin: async () => {
        if (!store || !ready) return { ok: false, detail: "device storage is not ready" };
        const snapshot = await deviceSnapshot();
        if (!snapshot.device) return { ok: false, detail: "no paired device to ask" };
        const command = {
          id: "dc_" + randomUUID(),
          deviceId: snapshot.device.device_id,
          type: "device.status",
          payload: {},
          status: "queued",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        };
        await store.enqueue(command);
        return { ok: true, verified: true, detail: "check-in queued as " + command.id + "; execution is not yet confirmed" };
      },
      notify_owner: async ({ incident }) => {
        if (!notifications) return { ok: false, detail: "notification storage is not available" };
        const recorded = await notifications.record({
          type: "system.recovery",
          severity: "warning",
          title: "Incident needs attention: " + incident.title,
          body: (incident.detail || incident.kind) + " Safe action: " + (incident.safeAction || "none") + ".",
          dedupeKey: "incident:" + incident.id,
          ref: incident.id
        });
        return { ok: recorded.ok === true, verified: recorded.ok === true, detail: recorded.ok ? "notification recorded (inbox)" : "notification failed" };
      }
    };
    recoveryRef = createRecoveryService({ monitor, incidents, repairs, log });
    return recoveryRef;
  }

  // Assigned here so diagnostics can probe the engine and runtime mounted above.
  diagnosticsRef = () => createAxDiagnostics({
    env,
    version: env.HABITAT_VERSION || "0.5.0",
    project: memoryProject,
    engine: commandApi?.engine || null,
    memory: memoryStore,
    notifications,
    providerConfig: resolveAxProviderConfig(env),
    orchestrator: () => (axOrchestrator === undefined ? { enabled: false, code: "orchestrator_not_resolved" } : axOrchestrator),
    presence: () => nexusRuntime,
    deviceBridge: () => ({ ready, durable: Boolean(store?.durable), axTokenConfigured: Boolean(axToken), perDeviceTokens: true }),
    sandbox: () => detectSandbox(),
    capabilities: async () => {
      const [objectiveRows, incidentRows] = await Promise.all([
        objectives ? objectives.list({ limit: 100 }) : Promise.resolve([]),
        incidents ? incidents.list({ status: "open", limit: 50 }) : Promise.resolve({ ok: false, incidents: [] })
      ]);
      const matrix = resolveAgents().capabilityMatrix();
      return {
        status: "checked",
        objectives: {
          available: Boolean(objectives),
          total: objectiveRows.length,
          byStatus: objectiveRows.reduce((counts, item) => {
            counts[item.status] = (counts[item.status] || 0) + 1;
            return counts;
          }, {})
        },
        agents: {
          implemented: matrix.length,
          available: matrix.filter(agent => agent.available).map(agent => agent.id),
          unavailable: matrix.filter(agent => !agent.available).map(agent => agent.id)
        },
        incidents: { available: Boolean(incidents), open: (incidentRows.incidents || []).length },
        circuit: circuitBreaker.snapshot()
      };
    }
  })();

  let initialized = false;
  let nexusInit = null;

  return Object.freeze({
    // Read-only accessor for embedders and tests; the channel itself is only reachable through the
    // authenticated routes.
    messageChannel: () => messages,
    async initialize({ startWorker = true } = {}) {
      if (initialized) {
        // A deferred or failed Nexus startup is retryable without restarting the process.
        if (nexusRuntime && nexusInit && nexusInit.started !== true) {
          try {
            nexusInit = await nexusRuntime.initialize({ startWorker });
          } catch (error) {
            nexusInit = { ok: false, durable: false, started: false, reason: "initialize_failed" };
            console.error("NEXUS_RUNTIME_INIT_FAILED", String(error?.message || error));
          }
        }
        return {
          ok: true,
          durable: Boolean(store?.durable),
          alreadyInitialized: true,
          nexus: nexusRuntime ? { configured: true, ...nexusInit } : nexusMount
        };
      }
      if (!store) {
        console.warn("DEVICE_COMMAND_BRIDGE: disabled — D1 credentials are not configured");
        return { ok: false, durable: false, nexus: nexusMount };
      }
      await store.initialize();
      // Additive schema for memory and notifications. A failure is reported and leaves device
      // commands usable, because neither is a prerequisite for executing a task.
      for (const [label, repository] of [["AX_MEMORY", memoryStore], ["AX_NOTIFICATIONS", notificationStore], ["AX_OBJECTIVES", objectiveStore], ["AX_INCIDENTS", incidentStore], ["AX_SECURITY_EVENTS", securityStore], ["AX_SCHEDULER", schedulerStore], ["AX_MESSAGES", messageStore]]) {
        if (!repository || typeof repository.initialize !== "function") continue;
        try {
          await repository.initialize();
        } catch (error) {
          console.error(label + "_INIT_FAILED", String(error?.message || error));
        }
      }
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
      // Storage is ready, so the worker may claim. A failure here leaves the device bridge usable
      // and the worker unstarted, and is reported instead of being assumed healthy.
      if (nexusRuntime) {
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
      // Same shape as status().nexus in every case: {configured, ...runtime state} or the mount refusal.
      return { ok: true, durable: true, nexus: nexusRuntime ? { configured: true, ...nexusInit } : nexusMount };
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
        // Read-only: whether the worker is mounted, initialized and started. Never part of the
        // HTTP success condition, so a Render health check stays up while an optional worker is off.
        nexus: nexusRuntime ? { configured: true, ...nexusRuntime.status() } : nexusMount
      };
    },
    nexus() {
      return nexusRuntime;
    },
    async startNexusWorker() {
      if (!nexusRuntime) return { ok: false, started: false, reason: nexusMount.reason || "not_mounted" };
      try {
        if (!ready || !nexusInit || nexusInit.ok === false) {
          nexusInit = await nexusRuntime.initialize({ startWorker: true });
          return { ok: Boolean(nexusInit?.started), started: Boolean(nexusInit?.started), ...nexusInit };
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
