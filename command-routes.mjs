import { timingSafeEqual } from "node:crypto";
import { createD1CommandTaskRepository } from "./d1-command-task-repository.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { createUniversalCommandEngine } from "./universal-command-engine.mjs";
import { describeRoles } from "./agent-roles.mjs";
import { applyMemoryImport, deriveMemoryCandidates } from "./ax-memory-import.mjs";
import { buildMissionHistory, missionSummary } from "./mission-history.mjs";
import { memoryInsights } from "./ax-memory-insights.mjs";
import { auditPairingLifecycle, capabilityManifest, deriveDeviceState, pairingGuidance } from "./ax-device-capabilities.mjs";

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
  attempt_limit_reached: 409,
  approval_required: 409,
  verification_required: 409,
  objective_conflict: 409,
  budget_exhausted: 409,
  objective_terminal: 409,
  key_reused: 409
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
  presenceProvider = null,
  // Optional Habitat-native Ax. Absent or disabled, the run routes answer 503 instead of pretending
  // an agent exists.
  orchestratorProvider = null,
  // Optional durable Ax memory repository. Absent, memory routes answer 503 and the planner simply
  // receives no memory context.
  memoryProvider = null,
  memoryProject = "habitat",
  // Optional notification service and diagnostics/producer views supplied by the mounted runtime.
  notificationProvider = null,
  diagnosticsProvider = null,
  providerStatusProvider = null,
  // Mission 10 capabilities. Each is a provider so a surface that is not mounted answers 503
  // instead of inventing state. None of these owns a second task store.
  objectiveProvider = null,
  agentProvider = null,
  recoveryProvider = null,
  incidentProvider = null,
  deviceStateProvider = null,
  circuitProvider = null,
  budgetProvider = null
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

  // Capabilities that own their own durable store (objectives, agents, incidents) do not need the
  // command-task table to be initialised, but they must still fail closed with a typed answer.
  const serviceGuard = fn => async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error) {
      console.error("COMMAND_SERVICE_ROUTE_FAILED", String(error?.message || error));
      return res.status(502).json({ ok: false, error: "The capability could not complete the request." });
    }
  };

  function resolveService(provider) {
    try {
      return typeof provider === "function" ? provider() : provider;
    } catch {
      return null;
    }
  }

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

  function resolveOrchestrator() {
    try { return typeof orchestratorProvider === "function" ? orchestratorProvider() : null; }
    catch { return null; }
  }

  /** Shared closed-door answer: no agent, no route, and a reason the caller can act on. */
  function orchestratorUnavailable(res) {
    const orchestrator = resolveOrchestrator();
    if (orchestrator?.enabled) return orchestrator;
    res.status(503).json({
      ok: false,
      code: orchestrator?.code || "orchestrator_disabled",
      error: orchestrator?.error || "Habitat-native Ax is not available on this service."
    });
    return null;
  }

  // Ax's own entrypoint. An objective goes in; a run record with a plan, task ids, verified
  // evidence and its token cost comes out. It is not part of the ChatGPT OpenAPI document: this is
  // Habitat's own agent, not a tool for an external model.
  route.post("/ax/command/runs", requireAx, guard(async (req, res) => {
    const orchestrator = orchestratorUnavailable(res);
    if (!orchestrator) return undefined;
    const objective = String(req.body?.objective || "").trim();
    if (!objective) {
      return reply(res, { ok: false, code: "invalid_objective", error: "An objective is required." });
    }
    try {
      await orchestrator.initialize?.();
    } catch (error) {
      console.error("AX_RUN_STORE_INIT_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, code: "run_store_unavailable", error: "The Ax run store could not be initialized." });
    }
    const outcome = await orchestrator.runObjective({
      objective,
      requestedBy: "ax",
      runKey: req.body?.runKey ?? null
    });
    // A run that could not be made durable is a server failure, not a created run.
    if (outcome.code === "store_unavailable") {
      return res.status(503).json({ ok: false, code: "store_unavailable", error: outcome.error });
    }
    // Input mistakes are 400; anything else is 201 because a run record exists. The run's own
    // status and `verified` flag carry whether the work succeeded.
    const inputError = ["invalid_objective", "invalid_run_key", "run_key_reused"].includes(outcome.code);
    return res.status(inputError ? 400 : 201).json({
      ok: outcome.ok === true,
      code: outcome.code ?? null,
      error: outcome.error ?? null,
      resumed: outcome.resumed === true,
      run: outcome.run
    });
  }));

  route.get("/ax/command/runs", requireAx, guard(async (req, res) => {
    const orchestrator = orchestratorUnavailable(res);
    if (!orchestrator) return undefined;
    res.json({ ok: true, runs: await orchestrator.listRuns({ limit: req.query?.limit }) });
  }));

  route.get("/ax/command/runs/:id", requireAx, guard(async (req, res) => {
    const orchestrator = orchestratorUnavailable(res);
    if (!orchestrator) return undefined;
    const run = await orchestrator.getRun(req.params.id);
    if (!run) return reply(res, { ok: false, code: "not_found", error: "No Ax run with that id." });
    res.json({ ok: true, run });
  }));

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

  // ------------------------------------------------------------------ durable memory
  //
  // Memory is its own store, separate from every task table. Reads need the Ax credential; a write
  // may never claim `verified_fact` unless the paired owner device performs it, and deletion is
  // owner-only with the current version required.
  const memoryRepository = () => {
    try {
      return typeof memoryProvider === "function" ? memoryProvider() : memoryProvider;
    } catch {
      return null;
    }
  };
  const projectOf = req => String(req.query?.project || req.body?.project || memoryProject || "habitat").trim().toLowerCase();

  function memoryUnavailable(res) {
    res.status(503).json({
      ok: false,
      code: "memory_not_configured",
      error: "Durable Ax memory is unavailable on this service; no memory was read or written."
    });
  }

  function memoryWrite(req, { source, actor }) {
    return {
      project: projectOf(req),
      key: req.body?.key,
      kind: String(req.body?.kind || "claim"),
      statement: req.body?.statement,
      provenance: {
        source,
        actor,
        ref: req.body?.ref ?? null,
        observedAt: req.body?.observedAt ?? new Date().toISOString()
      },
      tags: req.body?.tags,
      confidence: req.body?.confidence
    };
  }

  route.get("/ax/command/memory/stats", requireAx, guard(async (req, res) => {
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    res.json({ ok: true, stats: await repository.stats({ project: projectOf(req) }) });
  }));

  route.get("/ax/command/memory/search", requireAx, guard(async (req, res) => {
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const project = projectOf(req);
    const results = await repository.search({
      project,
      query: String(req.query?.q || ""),
      kind: req.query?.kind || null,
      limit: req.query?.limit
    });
    res.json({ ok: true, project, count: results.length, results });
  }));

  route.get("/ax/command/memory", requireAx, guard(async (req, res) => {
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const project = projectOf(req);
    const results = await repository.list({ project, kind: req.query?.kind || null, limit: req.query?.limit });
    res.json({ ok: true, project, count: results.length, results });
  }));

  // Named import routes are registered before the two-segment key route so they cannot be shadowed.
  route.post("/ax/command/memory/import/preview", requireAx, guard(async (req, res) => {
    const exported = req.body?.export ?? req.body?.conversations ?? null;
    if (!exported) return reply(res, { ok: false, code: "invalid_export", error: "A ChatGPT export is required." });
    const derived = deriveMemoryCandidates(exported, { project: projectOf(req) });
    // Candidates only. Nothing is written and no candidate can be a verified fact.
    res.status(derived.ok ? 200 : 400).json({
      ok: derived.ok,
      code: derived.code || null,
      candidates: derived.candidates,
      rejected: derived.rejected,
      stats: derived.stats
    });
  }));

  route.post("/ax/command/memory/import/apply", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Memory import approval");
    if (!deviceId) return undefined;
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const exported = req.body?.export ?? req.body?.conversations ?? null;
    if (!exported) return reply(res, { ok: false, code: "invalid_export", error: "A ChatGPT export is required." });
    // Re-derived on the server: the client can name approved ids, never supply candidate content.
    const derived = deriveMemoryCandidates(exported, { project: projectOf(req) });
    if (!derived.ok) return res.status(400).json({ ok: false, code: derived.code, error: "The export could not be read." });
    const approvedIds = Array.isArray(req.body?.approvedIds) ? req.body.approvedIds : [];
    if (!approvedIds.length) {
      return res.status(400).json({ ok: false, code: "owner_approval_required", error: "Name the candidate ids to accept; an empty approval set is refused." });
    }
    const outcome = await applyMemoryImport(repository, derived.candidates, { approvedIds });
    await recordAudit({ event: "command.memory.imported", actorDeviceId: deviceId, inserted: outcome.inserted, skipped: outcome.skipped });
    res.status(outcome.ok ? 200 : 400).json({ ok: outcome.ok, project: projectOf(req), rejected: derived.rejected, ...outcome });
  }));

  route.post("/ax/command/memory/owner", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Owner memory write");
    if (!deviceId) return undefined;
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const outcome = await repository.put(
      memoryWrite(req, { source: "owner", actor: "owner:" + deviceId }),
      { expectedVersion: req.body?.expectedVersion ?? null, allowKindChange: Boolean(req.body?.allowKindChange) }
    );
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.memory.written", actorDeviceId: deviceId, key: req.body?.key || null, kind: req.body?.kind || null });
    }
    reply(res, outcome);
  }));

  route.post("/ax/command/memory", requireAx, guard(async (req, res) => {
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const kind = String(req.body?.kind || "").trim().toLowerCase();
    if (kind === "verified_fact") {
      return res.status(403).json({
        ok: false,
        code: "verified_fact_owner_only",
        error: "Only the paired owner device may record a verified fact. Ax can record a claim or an observation."
      });
    }
    const outcome = await repository.put(
      memoryWrite(req, { source: "ax", actor: "ax" }),
      { expectedVersion: req.body?.expectedVersion ?? 0 }
    );
    reply(res, outcome);
  }));

  route.get("/ax/command/memory/:project/:key/history", requireAx, guard(async (req, res) => {
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const history = await repository.history({ project: req.params.project, key: req.params.key });
    res.json({ ok: true, project: String(req.params.project).toLowerCase(), key: String(req.params.key).toLowerCase(), history });
  }));

  route.get("/ax/command/memory/:project/:key", requireAx, guard(async (req, res) => {
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const entry = await repository.get({ project: req.params.project, key: req.params.key });
    if (!entry) return reply(res, { ok: false, code: "not_found", error: "No active memory entry with that project and key." });
    res.json({ ok: true, entry });
  }));

  route.post("/ax/command/memory/:project/:key/delete", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Memory deletion");
    if (!deviceId) return undefined;
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const outcome = await repository.remove({
      project: req.params.project,
      key: req.params.key,
      expectedVersion: req.body?.expectedVersion,
      actor: "owner"
    });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "command.memory.deleted", actorDeviceId: deviceId, key: req.params.key });
    }
    reply(res, outcome);
  }));

  // ------------------------------------------------------- notifications and history
  const notificationService = () => {
    try {
      return typeof notificationProvider === "function" ? notificationProvider() : notificationProvider;
    } catch {
      return null;
    }
  };

  function notificationsUnavailable(res) {
    res.status(503).json({
      ok: false,
      code: "notifications_not_configured",
      error: "Notification storage is unavailable on this service; no event was recorded."
    });
  }

  route.get("/ax/command/notifications", requireAx, guard(async (req, res) => {
    const service = notificationService();
    if (!service) return notificationsUnavailable(res);
    const outcome = await service.list({ status: req.query?.status || null, limit: req.query?.limit });
    if (outcome.ok === false) return res.status(503).json(outcome);
    res.json({ ...outcome, channel: "inbox", externalTransport: false });
  }));

  route.post("/ax/command/notifications/:id/ack", requireAx, guard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Notification acknowledgement");
    if (!deviceId) return undefined;
    const service = notificationService();
    if (!service) return notificationsUnavailable(res);
    reply(res, await service.acknowledge({ id: req.params.id, by: "owner:" + deviceId }));
  }));

  route.get("/ax/command/history", requireAx, guard(async (req, res) => {
    const orchestrator = resolveOrchestrator();
    if (!orchestrator?.enabled) {
      return res.status(503).json({
        ok: false,
        code: orchestrator?.code || "orchestrator_disabled",
        error: orchestrator?.error || "Mission history needs the Habitat-native Ax run store."
      });
    }
    const runs = await orchestrator.listRuns({ limit: req.query?.limit });
    const service = notificationService();
    let notifications = [];
    if (service) {
      const listed = await service.list({ limit: 100 });
      notifications = listed.notifications || [];
    }
    const missions = buildMissionHistory({ runs, notifications, limit: req.query?.limit });
    res.json({ ok: true, missions, summary: missionSummary(missions) });
  }));

  route.get("/ax/command/recovery", requireAx, guard(async (_req, res) => {
    const orchestrator = resolveOrchestrator();
    const runs = orchestrator?.enabled ? await orchestrator.listRuns({ limit: 20 }) : [];
    let presence = null;
    try {
      presence = typeof presenceProvider === "function" ? await presenceProvider() : null;
    } catch {
      presence = null;
    }
    const unsettledRuns = runs
      .filter(run => run && !run.settled && run.status !== "error")
      .map(run => ({
        runId: run.id,
        status: run.status,
        objective: String(run.objective || "").slice(0, 200),
        updatedAt: run.updatedAt || null,
        deadlineAt: run.deadlineAt || null,
        recoveries: Number(run.recoveries || 0),
        openSteps: (run.steps || [])
          .filter(step => step.taskId && step.terminal !== true)
          .map(step => ({ taskId: step.taskId, status: step.status, adapter: step.adapter || null }))
      }));
    res.json({
      ok: true,
      // Read-only view. Recovery itself is the orchestrator's reconciliation and the worker's lease
      // reclamation; this route must never mutate a task.
      recovery: {
        unsettledRuns,
        workers: presence?.heartbeat || null,
        queue: presence?.queue || null,
        observedAt: new Date().toISOString()
      }
    });
  }));

  // ------------------------------------------------------------- providers and diagnostics
  route.get("/ax/command/providers", requireAx, (_req, res) => {
    let providers = null;
    try {
      providers = typeof providerStatusProvider === "function" ? providerStatusProvider() : null;
    } catch {
      providers = null;
    }
    const breaker = resolveService(circuitProvider);
    const budget = resolveService(budgetProvider);
    res.json({
      ok: true,
      providers: providers || { enabled: false, code: "provider_not_configured", primary: null, fallbacks: [] },
      circuit: breaker && typeof breaker.snapshot === "function" ? breaker.snapshot() : [],
      budget: budget || null,
      health: {
        checked: false,
        note: "Configuration only. This endpoint makes no model call, so it cannot report an account as healthy."
      },
      decisions: {
        recorded: true,
        note: "A run's planner result carries a decision record naming the provider that answered, every skipped provider and why fallback occurred."
      }
    });
  });

  route.get("/ax/command/diagnostics", requireAx, guard(async (_req, res) => {
    if (typeof diagnosticsProvider !== "function") {
      return res.status(503).json({ ok: false, code: "diagnostics_unavailable", error: "Diagnostics are not mounted on this service." });
    }
    const diagnostics = await diagnosticsProvider();
    res.json({ ok: true, diagnostics });
  }));

  // ------------------------------------------------------------------ Mission 10 capabilities
  //
  // Objectives are the durable mission lifecycle; agents are real bounded handlers; recovery is
  // read-only scanning plus allowlisted reversible repairs; device state is derived from durable
  // rows. Every one of these answers 503 when its surface is not mounted, and none of them can mark
  // work complete without evidence.
  const objectives = () => resolveService(objectiveProvider);
  const agents = () => resolveService(agentProvider);
  const recoveryService = () => resolveService(recoveryProvider);
  const incidentService = () => resolveService(incidentProvider);
  const deviceSnapshot = () => resolveService(deviceStateProvider);

  function capabilityUnavailable(res, code, message) {
    res.status(503).json({ ok: false, code, error: message });
  }

  function objectiveReply(res, outcome, created = false) {
    if (outcome?.ok) return res.status(created ? 201 : 200).json(outcome);
    const status = STATUS_BY_CODE[outcome?.code] || 400;
    return res.status(status).json({ ok: false, code: outcome?.code || "invalid_request", error: outcome?.error || "The objective could not be updated." });
  }

  route.post("/ax/command/objectives", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const outcome = await service.create({
      objective: req.body?.objective,
      requestedBy: "ax",
      key: req.body?.key ?? null,
      criteria: req.body?.criteria,
      budgetUsd: req.body?.budgetUsd,
      deadlineAt: req.body?.deadlineAt ?? null,
      priority: req.body?.priority || "normal"
    });
    return objectiveReply(res, outcome, !outcome.replayed);
  }));

  route.get("/ax/command/objectives", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const status = req.query?.status || null;
    const list = await service.list({ status, limit: req.query?.limit });
    const summary = list.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    res.json({ ok: true, count: list.length, byStatus: summary, objectives: list.map(item => service.summary(item)) });
  }));

  route.get("/ax/command/objectives/:id", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const objective = await service.get(req.params.id);
    if (!objective) return reply(res, { ok: false, code: "not_found", error: "No objective with that id." });
    res.json({ ok: true, objective, summary: service.summary(objective) });
  }));

  route.post("/ax/command/objectives/:id/understand", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.understand(req.params.id, {
      summary: req.body?.summary,
      constraints: req.body?.constraints,
      missingInformation: req.body?.missingInformation,
      questions: req.body?.questions,
      by: "ax"
    }));
  }));

  route.post("/ax/command/objectives/:id/plan", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.plan(req.params.id, {
      steps: req.body?.steps,
      provider: req.body?.provider ?? null,
      estimatedCostUsd: req.body?.estimatedCostUsd,
      risk: req.body?.risk,
      permissions: req.body?.permissions,
      by: "ax"
    }));
  }));

  route.post("/ax/command/objectives/:id/request-approval", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.requestApproval(req.params.id, { reason: req.body?.reason || null, by: "ax" }));
  }));

  route.post("/ax/command/objectives/:id/authorize", requireAx, serviceGuard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Objective authorization");
    if (!deviceId) return undefined;
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    // The proof is derived from the owner device and the objective, so a double tap is an idempotent
    // replay rather than a second authorization record.
    const outcome = await service.authorize(req.params.id, {
      approvalId: req.body?.approvalId || "owner-approval:" + req.params.id + ":" + deviceId,
      by: "owner:" + deviceId,
      budgetUsd: req.body?.budgetUsd ?? null
    });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "objective.authorized", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    objectiveReply(res, outcome);
  }));

  route.post("/ax/command/objectives/:id/deny", requireAx, serviceGuard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Objective denial");
    if (!deviceId) return undefined;
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const outcome = await service.deny(req.params.id, { by: "owner:" + deviceId, reason: req.body?.reason || null });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "objective.denied", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    objectiveReply(res, outcome);
  }));

  route.post("/ax/command/objectives/:id/start", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.start(req.params.id, { by: "ax" }));
  }));

  route.post("/ax/command/objectives/:id/tasks", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.attachTask(req.params.id, {
      taskId: req.body?.taskId,
      agent: req.body?.agent ?? null,
      step: req.body?.step ?? null,
      by: "ax"
    }));
  }));

  route.post("/ax/command/objectives/:id/evidence", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.addEvidence(req.params.id, { items: req.body?.items, by: "ax" }));
  }));

  route.post("/ax/command/objectives/:id/checkpoint", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.checkpoint(req.params.id, { note: req.body?.note, taskIds: req.body?.taskIds, by: "ax" }));
  }));

  route.post("/ax/command/objectives/:id/verify", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const current = await service.get(req.params.id);
    if (!current) return reply(res, { ok: false, code: "not_found", error: "No objective with that id." });
    if (current.status === "executing") {
      const moved = await service.transition(req.params.id, "verifying", { by: "ax", reason: "evidence verification started" });
      if (moved.ok !== true) return objectiveReply(res, moved);
    }
    objectiveReply(res, await service.verify(req.params.id, { checks: req.body?.checks, by: "ax" }));
  }));

  route.post("/ax/command/objectives/:id/complete", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.complete(req.params.id, { summary: req.body?.summary || null, by: "ax" }));
  }));

  route.post("/ax/command/objectives/:id/fail", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.fail(req.params.id, { error: req.body?.error, code: req.body?.code || null, by: "ax" }));
  }));

  route.post("/ax/command/objectives/:id/cancel", requireAx, serviceGuard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Objective cancellation");
    if (!deviceId) return undefined;
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const outcome = await service.cancel(req.params.id, { by: "owner:" + deviceId, reason: req.body?.reason || "cancelled by owner" });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "objective.cancelled", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    objectiveReply(res, outcome);
  }));

  route.post("/ax/command/objectives/:id/recover", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    objectiveReply(res, await service.recover(req.params.id, { by: "ax", reason: req.body?.reason || "recovered after interruption" }));
  }));

  // ------------------------------------------------------------------------ specialized agents
  // The objective drives the existing Ax run path. This is the integration point between the
  // durable lifecycle and the task engine: one dispatch, one deterministic run key, tasks attached
  // to the objective. It never completes the objective; acceptance checks still decide that.
  route.post("/ax/command/objectives/:id/dispatch", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const orchestrator = orchestratorUnavailable(res);
    if (!orchestrator) return undefined;
    const objective = await service.get(req.params.id);
    if (!objective) return reply(res, { ok: false, code: "not_found", error: "No objective with that id." });
    if (objective.status !== "executing") {
      return objectiveReply(res, { ok: false, code: "invalid_transition", error: "Start the objective before dispatching work.", from: objective.status });
    }
    const outcome = await orchestrator.runObjective({
      objective: objective.objective,
      requestedBy: "ax",
      // Deterministic per objective, so a retried dispatch resumes the same run instead of forking.
      runKey: "objective:" + objective.id
    });
    const run = outcome?.run || null;
    if (run) {
      for (const step of run.steps || []) {
        if (step.taskId) await service.attachTask(objective.id, { taskId: step.taskId, agent: step.agent || null, step: step.index });
      }
      if (Array.isArray(run.evidence) && run.evidence.length) {
        await service.addEvidence(objective.id, { items: run.evidence.map(line => ({ summary: line, source: "run:" + run.id })) });
      }
      await service.checkpoint(objective.id, {
        note: "Ax run " + run.id + " dispatched from this objective",
        taskIds: (run.steps || []).map(step => step.taskId).filter(Boolean)
      });
    }
    res.status(outcome?.code === "store_unavailable" ? 503 : 200).json({
      ok: outcome?.ok === true,
      code: outcome?.code || null,
      run,
      objective: await service.get(objective.id)
    });
  }));

  route.get("/ax/command/agents", requireAx, serviceGuard(async (_req, res) => {
    const runtime = agents();
    if (!runtime) return capabilityUnavailable(res, "agents_not_configured", "The agent runtime is not mounted on this service.");
    res.json({ ok: true, agents: runtime.capabilityMatrix(), limits: runtime.limits, delegations: runtime.delegations() });
  }));

  route.post("/ax/command/agents/select", requireAx, serviceGuard(async (req, res) => {
    const runtime = agents();
    if (!runtime) return capabilityUnavailable(res, "agents_not_configured", "The agent runtime is not mounted on this service.");
    const objective = String(req.body?.objective || "").trim();
    if (!objective) return reply(res, { ok: false, code: "invalid_objective", error: "An objective is required." });
    res.json({ ok: true, selection: runtime.selectAgent(objective) });
  }));

  route.post("/ax/command/agents/delegate", requireAx, serviceGuard(async (req, res) => {
    const runtime = agents();
    if (!runtime) return capabilityUnavailable(res, "agents_not_configured", "The agent runtime is not mounted on this service.");
    const outcome = await runtime.delegateAndReview({
      objective: req.body?.objective,
      role: req.body?.role || null,
      depth: Math.max(0, Math.min(3, Number(req.body?.depth) || 0)),
      chain: Array.isArray(req.body?.chain) ? req.body.chain.slice(0, 8) : [],
      budgetUsd: req.body?.budgetUsd
    });
    res.status(outcome.envelope?.code === "unknown_agent" ? 400 : 200).json({ ok: outcome.ok === true, ...outcome });
  }));

  // --------------------------------------------------------------- phone state and capabilities
  async function readDeviceSnapshot(res) {
    // The provider is awaited, not invoked through resolveService: that helper calls synchronous
    // factories, and this one returns a promise from an async store read.
    const provider = typeof deviceStateProvider === "function" ? deviceStateProvider : null;
    if (!provider) {
      capabilityUnavailable(res, "device_state_not_configured", "Phone state is not mounted on this service.");
      return null;
    }
    let snapshot;
    try {
      snapshot = await provider();
    } catch (error) {
      console.error("DEVICE_STATE_PROBE_FAILED", String(error?.message || error));
      capabilityUnavailable(res, "device_state_unavailable", "Phone state could not be read.");
      return null;
    }
    if (!snapshot || snapshot.ok === false) {
      capabilityUnavailable(res, "device_state_unavailable", snapshot?.error || "Phone state could not be read.");
      return null;
    }
    return snapshot;
  }

  route.get("/ax/command/device/capabilities", requireAx, serviceGuard(async (_req, res) => {
    const snapshot = await readDeviceSnapshot(res);
    if (!snapshot) return undefined;
    res.json({ ok: true, capabilities: capabilityManifest({ device: snapshot.device }), manifestOnly: !snapshot.device });
  }));

  route.get("/ax/command/device/state", requireAx, serviceGuard(async (_req, res) => {
    const snapshot = await readDeviceSnapshot(res);
    if (!snapshot) return undefined;
    const state = deriveDeviceState({ device: snapshot.device, commands: snapshot.commands || [], now: Date.now() });
    const pairing = snapshot.pairing ? auditPairingLifecycle({ pairing: snapshot.pairing, device: snapshot.device, now: Date.now() }) : null;
    res.json({
      ok: true,
      state,
      pairing,
      guidance: pairing?.code ? pairingGuidance(pairing.code) : null
    });
  }));

  route.get("/ax/command/device/pairing/audit", requireAx, serviceGuard(async (_req, res) => {
    const snapshot = await readDeviceSnapshot(res);
    if (!snapshot) return undefined;
    const audit = auditPairingLifecycle({ pairing: snapshot.pairing || null, device: snapshot.device || null, now: Date.now() });
    res.json({ ok: true, audit, guidance: pairingGuidance(audit.code) });
  }));

  // ------------------------------------------------------------ monitoring and safe recovery
  route.get("/ax/command/recovery/incidents", requireAx, serviceGuard(async (req, res) => {
    const service = incidentService();
    if (!service) return capabilityUnavailable(res, "incidents_not_configured", "Incident history is not mounted on this service.");
    const listed = await service.list({ status: req.query?.status || "open", limit: req.query?.limit });
    if (listed.ok === false) return capabilityUnavailable(res, listed.code, "Incident history could not be read.");
    res.json({ ok: true, ...listed });
  }));

  route.post("/ax/command/recovery/scan", requireAx, serviceGuard(async (_req, res) => {
    const service = recoveryService();
    if (!service) return capabilityUnavailable(res, "recovery_not_configured", "Self-monitoring is not mounted on this service.");
    const report = await service.scanAndRecord();
    res.json({ ok: true, report });
  }));

  route.post("/ax/command/recovery/incidents/:id/recover", requireAx, serviceGuard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Incident recovery");
    if (!deviceId) return undefined;
    const service = recoveryService();
    if (!service) return capabilityUnavailable(res, "recovery_not_configured", "Self-monitoring is not mounted on this service.");
    const outcome = await service.recover(req.params.id, { action: req.body?.action || null, by: "owner:" + deviceId });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "incident.recovered", actorDeviceId: deviceId, targetDeviceId: req.params.id, action: req.body?.action || null });
    }
    res.status(outcome.ok ? 200 : STATUS_BY_CODE[outcome.code] || 400).json(outcome);
  }));

  // ------------------------------------------------------------------ memory intelligence
  route.get("/ax/command/memory/insights", requireAx, serviceGuard(async (req, res) => {
    const repository = memoryRepository();
    if (!repository) return memoryUnavailable(res);
    const project = projectOf(req);
    const entries = await repository.list({ project, limit: 200 });
    const insights = memoryInsights({ entries, objective: String(req.query?.q || ""), now: Date.now() });
    res.json({ ok: true, project, insights });
  }));

  return { engine, registry: registryInstance, store: () => store };
}
