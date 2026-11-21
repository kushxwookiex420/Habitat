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

import { buildAxOpenApiSpec } from "./scripts/ax-openapi.mjs";

/**
 * Adds the response envelope exactly once per response. Every /ax/command reply carries
 * schemaVersion so a client deployed separately from this service can refuse a shape it does not
 * understand instead of guessing. Wrapping res.json means new routes cannot forget it.
 */
function withEnvelope(handler) {
  return (req, res, next) => {
    if (!res.__axEnvelope) {
      const send = res.json.bind(res);
      res.json = body => {
        if (body && typeof body === "object" && !Array.isArray(body) && body.schemaVersion === undefined) {
          body = { schemaVersion: 1, ...body };
        }
        return send(body);
      };
      res.__axEnvelope = true;
    }
    return handler(req, res, next);
  };
}

function withEnvelopeList(handlers) {
  return handlers.map(withEnvelope);
}

function parseSince(value) {
  if (value === undefined || value === null || value === "") return "1970-01-01T00:00:00.000Z";
  const at = Date.parse(String(value).trim());
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString();
}

function publicOrigin(req, env = process.env) {
  const configured = String(env.HABITAT_PUBLIC_ORIGIN || "").trim();
  if (configured) return configured;
  const proto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req?.headers?.host || "").trim();
  return host ? proto + "://" + host : "https://habitat-1-szzd.onrender.com";
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
  ownerDeviceIds = null,
  audit = null,
  // Optional live view of the executor, supplied by the caller that mounted the Nexus runtime.
  // Absent or failing, presence reports "not mounted" rather than inventing availability.
  presenceProvider = null
} = {}) {
  // Two credentials, two permission sets. The bridge token is device-capable and predates this
  // work. The command token may only reach /ax/command, and it can never satisfy an owner action.
  // Both comparisons always run, in constant time, so a caller cannot learn which one matched from
  // the response time. An empty credential never matches: the API fails closed when unconfigured.
  const bridgeToken = String(env.HABITAT_AX_BRIDGE_TOKEN || "").trim();
  const commandToken = String(env.HABITAT_AX_COMMAND_TOKEN || "").trim();
  const anyAxToken = Boolean(bridgeToken || commandToken);
  function axRole(req) {
    const token = bearer(req);
    const bridgeMatch = safeEqual(token, bridgeToken);
    const commandMatch = safeEqual(token, commandToken);
    if (bridgeMatch) return "bridge";
    if (commandMatch) return "command";
    return null;
  }
  const recordAudit = async entry => {
    if (typeof audit !== "function") return;
    try { await audit(entry); } catch (error) { console.error("COMMAND_AUDIT_FAILED", String(error?.message || error)); }
  };

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
    if (!anyAxToken) {
      res.status(503).json({
        ok: false,
        code: "command_auth_unconfigured",
        error: "Command API is unavailable: set HABITAT_AX_COMMAND_TOKEN (or the device-capable HABITAT_AX_BRIDGE_TOKEN) for this service."
      });
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
    // Ax's command credential may ask for an approval; it may never satisfy one. Checked before
    // device verification so a leaked owner device header still cannot be used with this token.
    if (req.axRole === "command") {
      res.status(403).json({
        ok: false,
        code: "command_token_cannot_approve",
        error: label + " cannot be performed with the Ax command token. Owner approval requires the owner's paired device."
      });
      return null;
    }
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
    // A valid device with no configured owner is a misconfiguration, not an authorization
    // decision. Report 503 like the /device/command routes do, so an operator fixes the variable
    // instead of hunting a device that is actually fine.
    if (owners.size === 0) {
      res.status(503).json({
        ok: false,
        code: "owner_unconfigured",
        error: label + " requires an owner device: set HABITAT_OWNER_DEVICE_IDS on this service."
      });
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
    if (!anyAxToken) {
      return res.status(503).json({
        ok: false,
        code: "command_auth_unconfigured",
        error: "Command API is unavailable: set HABITAT_AX_COMMAND_TOKEN (or the device-capable HABITAT_AX_BRIDGE_TOKEN) for this service."
      });
    }
    const role = axRole(req);
    if (!role) {
      return res.status(401).json({ ok: false, code: "invalid_token", error: "Ax command authentication required." });
    }
    // Audit identity comes from the verified credential, never from the request body.
    req.axRole = role;
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

  // Register command routes through a wrapper that stamps the envelope on every reply, including
  // auth and storage failures written by requireAx and ready().
  const route = {
    get: (path, ...handlers) => app.get(path, ...withEnvelopeList(handlers)),
    post: (path, ...handlers) => app.post(path, ...withEnvelopeList(handlers))
  };

  const EVENT_TYPES = Object.freeze({
    queued: "task.queued",
    working: "task.working",
    needs_approval: "task.approval_required",
    done: "task.completed",
    failed: "task.failed",
    cancelled: "task.cancelled"
  });

  // Public on purpose: ChatGPT imports this schema before any credential exists in the conversation.
  // It describes endpoint shapes only and carries no secret. Registered on the raw app so the
  // envelope cannot corrupt a valid OpenAPI document.
  app.get("/ax/command/openapi.json", (req, res) => {
    res.json(buildAxOpenApiSpec({ origin: publicOrigin(req, env) }));
  });

  route.get("/ax/command/presence", requireAx, async (req, res) => {
    let report = null;
    try {
      report = typeof presenceProvider === "function" ? await presenceProvider() : null;
    } catch (error) {
      console.error("COMMAND_PRESENCE_FAILED", String(error?.message || error));
      report = null;
    }
    const presence = report || {
      executor: { configured: false, started: false, state: "not_mounted", reason: "runtime_not_mounted" },
      heartbeat: { verified: false, liveWorkers: 0, asleep: true, lastHeartbeatAgeSeconds: null },
      queue: { ok: false, error: "unavailable" },
      canExecute: false
    };
    // Deliberately does not require the store: presence is the one answer that must still arrive
    // when storage is unhealthy, and it says so through queue.ok=false.
    res.json({ ok: true, presence: { reachable: true, ...presence, observedAt: new Date().toISOString() } });
  });

  route.get("/ax/command/events", requireAx, guard(async (req, res) => {
    if (!store || typeof store.listChanged !== "function") {
      return res.status(503).json({ ok: false, code: "events_unavailable", error: "This command store cannot serve a change feed." });
    }
    const since = parseSince(req.query?.since);
    if (!since) {
      return reply(res, { ok: false, code: "invalid_since", error: "since must be an ISO-8601 timestamp." });
    }
    const afterId = String(req.query?.afterId || "").slice(0, 128);
    const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query?.limit) || 50)));
    const rows = await store.listChanged({ since, afterId, limit });
    const events = rows.map(({ task, updatedAt }) => ({
      seq: updatedAt + "|" + task.id,
      at: String(task.updatedAt || updatedAt),
      taskId: task.id,
      type: EVENT_TYPES[task.status] || "task." + String(task.status || "unknown"),
      status: task.status || null,
      objective: String(task.objective || "").slice(0, 200),
      requiresApproval: task.status === "needs_approval",
      // The engine keeps its transition log in statusHistory; older records may only have history.
      changes: (Array.isArray(task.statusHistory) ? task.statusHistory : Array.isArray(task.history) ? task.history : [])
        .filter(entry => String(entry?.at || "") >= since)
        .slice(-20),
      resultSummary: task.result?.summary ?? null,
      error: task.error ?? null
    }));
    const last = rows[rows.length - 1];
    res.json({
      ok: true,
      events,
      nextSince: last ? last.updatedAt : since,
      nextAfterId: last ? last.task.id : afterId,
      hasMore: rows.length === limit
    });
  }));

  // Read-only descriptions next: they never touch storage.
  route.get("/ax/command/roles", requireAx, (_req, res) => res.json(describeRoles()));
  route.get("/ax/command/tools", requireAx, (_req, res) => res.json(registryInstance.summary()));

  route.post("/ax/command/tasks", requireAx, guard(async (req, res) => {
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

  route.get("/ax/command/tasks", requireAx, guard(async (req, res) => {
    reply(res, await engine.list({ status: req.query?.status || null, limit: req.query?.limit }));
  }));

  route.get("/ax/command/tasks/:id", requireAx, guard(async (req, res) => {
    reply(res, await engine.get(req.params.id));
  }));

  route.post("/ax/command/tasks/:id/plan", requireAx, guard(async (req, res) => {
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.plan({ taskId: req.params.id, steps: req.body?.steps, by: "ax" }));
  }));

  route.post("/ax/command/tasks/:id/checkpoint", requireAx, guard(async (req, res) => {
    if (await rejectFenced(res, req.params.id)) return undefined;
    reply(res, await engine.checkpoint({ taskId: req.params.id, note: req.body?.note, by: "ax" }));
  }));

  route.post("/ax/command/tasks/:id/approval", requireAx, guard(async (req, res) => {
    if (await rejectFenced(res, req.params.id)) return undefined;
    const outcome = await engine.requestApproval({
      taskId: req.params.id,
      reason: req.body?.reason,
      action: req.body?.action || null,
      by: "ax"
    });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.approval.requested", actorDeviceId: "ax", targetDeviceId: req.params.id });
    }
    reply(res, outcome);
  }));

  route.post("/ax/command/tasks/:id/approve", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Owner approval");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    const outcome = await engine.approve({ taskId: req.params.id, by: "owner:" + deviceId });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.approved", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    reply(res, outcome);
  }));

  route.post("/ax/command/tasks/:id/deny", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Owner denial");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    const outcome = await engine.deny({
      taskId: req.params.id,
      by: "owner:" + deviceId,
      reason: req.body?.reason || null
    });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.denied", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    reply(res, outcome);
  }));

  route.post("/ax/command/tasks/:id/complete", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Manual close-out");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    const outcome = await engine.complete({
      taskId: req.params.id,
      result: req.body?.result,
      verifiedBy: "owner:" + deviceId
    });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.completed", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    reply(res, outcome);
  }));

  route.post("/ax/command/tasks/:id/fail", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Manual failure");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    const outcome = await engine.fail({ taskId: req.params.id, error: req.body?.error, by: "owner:" + deviceId });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.failed", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    reply(res, outcome);
  }));

  route.post("/ax/command/tasks/:id/cancel", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Task cancellation");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    const outcome = await engine.cancel({
      taskId: req.params.id,
      by: "owner:" + deviceId,
      reason: req.body?.reason || null
    });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.cancelled", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    reply(res, outcome);
  }));

  route.post("/ax/command/tasks/:id/retry", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Task retry");
    if (!deviceId) return undefined;
    if (await rejectFenced(res, req.params.id)) return undefined;
    const outcome = await engine.retry({ taskId: req.params.id, by: "owner:" + deviceId });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.retried", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    reply(res, outcome);
  }));

  return { engine, registry: registryInstance, store: () => store };
}
