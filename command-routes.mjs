import { timingSafeEqual } from "node:crypto";
import { createD1CommandTaskRepository } from "./d1-command-task-repository.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { createUniversalCommandEngine } from "./universal-command-engine.mjs";
import { describeRoles } from "./agent-roles.mjs";

/**
 * The universal command API.
 *
 * Every route requires the Ax bridge credential (HABITAT_AX_BRIDGE_TOKEN), compared in constant
 * time. The credential is read from the environment and never returned, logged or echoed; when it
 * is not configured the routes answer 503 and name the variable, so a missing secret is visible
 * without being exposed.
 *
 * Storage is the dedicated habitat_command_tasks table, so a command objective can never appear in
 * the existing worker-task list with an unknown status.
 */
const STATUS_BY_CODE = Object.freeze({
  not_found: 404,
  invalid_transition: 409,
  approval_pending: 409,
  attempt_limit_reached: 409
});

function bearer(req) {
  const value = String(req.headers?.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function reply(res, outcome) {
  if (outcome?.ok) return res.json(outcome);
  const status = STATUS_BY_CODE[outcome?.code] || 400;
  return res.status(status).json({
    ok: false,
    code: outcome?.code || "invalid_request",
    error: outcome?.error || "The request could not be completed."
  });
}

export function registerUniversalCommandRoutes(app, {
  env = process.env,
  fetchImpl = fetch,
  repository = null,
  registry = null,
  deviceRepository = null,
  verifyDevice = null,
  ownerDeviceId = null,
  ownerDeviceIds = null
} = {}) {
  const axToken = String(env.HABITAT_AX_BRIDGE_TOKEN || "").trim();

  // Manual close-out needs an owner device proof on top of the bridge credential. The device
  // verifier comes from the DEVICE repository (verifyDeviceToken); the task repository never had it.
  function resolveVerifier() {
    if (typeof verifyDevice === "function") return verifyDevice;
    const candidate = deviceRepository || verifyDevice;
    if (candidate && typeof candidate.verifyDeviceToken === "function") {
      return (token, deviceId) => candidate.verifyDeviceToken(token, deviceId);
    }
    return null;
  }
  const verifyClose = resolveVerifier();

  const owners = new Set();
  const addOwners = value => String(value || "").split(",").map(part => part.trim()).filter(Boolean).forEach(id => owners.add(id));
  addOwners(ownerDeviceId); addOwners(ownerDeviceIds);
  addOwners(env.HABITAT_OWNER_DEVICE_ID); addOwners(env.HABITAT_OWNER_DEVICE_IDS);
  const registryInstance = registry || createToolRegistry({ env });

  const hasD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]
    .every(key => String(env[key] || "").trim());
  const store = repository || (hasD1
    ? createD1CommandTaskRepository({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: env.HABITAT_D1_DATABASE_ID,
        apiToken: env.HABITAT_D1_API_TOKEN,
        fetchImpl
      })
    : null);

  const engine = store ? createUniversalCommandEngine({ repository: store, registry: registryInstance }) : null;
  let initialized = false;

  async function ready(res) {
    if (!axToken) {
      res.status(503).json({ ok: false, error: "Command API is unavailable: set HABITAT_AX_BRIDGE_TOKEN for this service." });
      return false;
    }
    if (!store) {
      res.status(503).json({ ok: false, error: "Command API is unavailable: this process has no command store configured." });
      return false;
    }
    if (!initialized) {
      try {
        await store.initialize();
        initialized = true;
      } catch (error) {
        console.error("COMMAND_STORE_INIT_FAILED", String(error?.message || error));
        res.status(503).json({ ok: false, error: "Command storage is not ready; the schema could not be initialized." });
        return false;
      }
    }
    return true;
  }

  /**
   * Owner proof for every owner-only action. The bridge token alone is never enough: the caller
   * must present a paired owner device id and its device token, verified by the device repository.
   * Returns the verified device id so audit identity never comes from the request body.
   */
  async function authorizeOwnerAction(req, res, label = "This action") {
    if (typeof verifyClose !== "function") {
      res.status(503).json({ ok: false, error: label + " is unavailable: device verification is not configured." });
      return null;
    }
    const deviceId = String(req.headers?.["x-owner-device-id"] || "").trim();
    const token = String(req.headers?.["x-owner-device-token"] || "").trim();
    if (!deviceId || !token) {
      res.status(401).json({ ok: false, code: "owner_required", error: label + " requires an owner device id and device token." });
      return null;
    }
    let valid = false;
    try {
      valid = (await verifyClose(token, deviceId)) === true;
    } catch (error) {
      console.error("COMMAND_OWNER_VERIFY_FAILED", String(error?.message || error));
      res.status(503).json({ ok: false, error: "Device verification is unavailable; no state was changed." });
      return null;
    }
    if (!valid) {
      res.status(401).json({ ok: false, code: "owner_invalid", error: "The owner device credential is not valid." });
      return null;
    }
    if (!owners.has(deviceId)) {
      res.status(403).json({ ok: false, code: "not_owner", error: "This device is not the configured owner and cannot perform " + label.toLowerCase() + "." });
      return null;
    }
    return deviceId;
  }

  /** A fenced task may only be closed by the worker holding that claim. */
  async function rejectFenced(res, taskId) {
    const task = await store.get(taskId);
    if (!task) {
      reply(res, { ok: false, code: "not_found", error: "No command task with that id." });
      return true;
    }
    if (task.fence) {
      res.status(409).json({
        ok: false,
        code: "task_owned_by_worker",
        error: "This task is owned by an active worker and must be completed or failed through the fenced worker execution path."
      });
      return true;
    }
    return false;
  }

  function requireAx(req, res, next) {
    if (!axToken) return res.status(503).json({ ok: false, error: "Command API is unavailable: set HABITAT_AX_BRIDGE_TOKEN for this service." });
    if (!safeEqual(bearer(req), axToken)) {
      return res.status(401).json({ ok: false, error: "Ax bridge authentication required." });
    }
    return next();
  }

  const guard = fn => async (req, res) => {
    try {
      if (!(await ready(res))) return undefined;
      return await fn(req, res);
    } catch (error) {
      console.error("COMMAND_ROUTE_FAILED", String(error?.message || error));
      return res.status(502).json({ ok: false, error: "The command engine could not complete the request." });
    }
  };

  // Read-only descriptions first: they never touch storage.
  app.get("/ax/command/roles", requireAx, (_req, res) => res.json(describeRoles()));
  app.get("/ax/command/tools", requireAx, (_req, res) => res.json(registryInstance.summary()));

  app.post("/ax/command/tasks", requireAx, guard(async (req, res) => {
    const outcome = await engine.submit({
      objective: req.body?.objective,
      requestedBy: "ax",
      role: req.body?.role || "ax",
      idempotencyKey: req.body?.idempotencyKey || null,
      adapter: req.body?.adapter ?? null
    });
    if (outcome.ok && !outcome.replayed) {
      res.status(201).json(outcome);
      return;
    }
    reply(res, outcome);
  }));

  app.get("/ax/command/tasks", requireAx, guard(async (req, res) => {
    reply(res, await engine.list({ status: req.query?.status || null, limit: req.query?.limit }));
  }));

  app.get("/ax/command/tasks/:id", requireAx, guard(async (req, res) => {
    reply(res, await engine.get(req.params.id));
  }));

  app.post("/ax/command/tasks/:id/plan", requireAx, guard(async (req, res) => {
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.plan({ taskId: req.params.id, steps: req.body?.steps, by: "ax" }));
  }));

  app.post("/ax/command/tasks/:id/checkpoint", requireAx, guard(async (req, res) => {
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.checkpoint({ taskId: req.params.id, note: req.body?.note, by: "ax" }));
  }));

  app.post("/ax/command/tasks/:id/approval", requireAx, guard(async (req, res) => {
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.requestApproval({
      taskId: req.params.id,
      reason: req.body?.reason,
      action: req.body?.action || null,
      by: "ax"
    }));
  }));

  app.post("/ax/command/tasks/:id/approve", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Owner approval");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.approve({ taskId: req.params.id, by: "owner:" + deviceId }));
  }));

  app.post("/ax/command/tasks/:id/deny", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Owner denial");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.deny({
      taskId: req.params.id,
      by: "owner:" + deviceId,
      reason: req.body?.reason || null
    }));
  }));

  app.post("/ax/command/tasks/:id/complete", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Manual close-out");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.complete({
      taskId: req.params.id,
      result: req.body?.result,
      verifiedBy: "owner:" + deviceId
    }));
  }));

  app.post("/ax/command/tasks/:id/fail", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Manual failure");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.fail({ taskId: req.params.id, error: req.body?.error, by: "owner:" + deviceId }));
  }));

  app.post("/ax/command/tasks/:id/retry", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Task retry");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.retry({ taskId: req.params.id, by: "owner:" + deviceId }));
  }));

  return { engine, registry: registryInstance, store: () => store };
}
