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
  budgetProvider = null,
  // Mission 11 operational surfaces. Same rule: absent means 503, never an invented status.
  securityProvider = null,
  schedulerProvider = null,
  projectProvider = null,
  // Mission 14: the durable Ax <-> NEXUS message channel. Absent, its routes answer 503 rather than
  // pretending a channel exists.
  messageProvider = null,
  // Mission 17: the agent work cycle that turns an objective into specialist work and verifies it.
  workProvider = null,
  plannerProvider = null,
  // Mission 2: the objective → durable mission → real workers pipeline. Absent or disabled, the mission
  // routes answer 503 and name the flag, rather than pretending a pipeline is mounted.
  missionProvider = null,
  // P1 capability network: capabilities, supplier catalog, channel eligibility, approvals and
  // treasury reporting. Absent, its routes answer 503 rather than pretending the surface exists.
  networkProvider = null
} = {}) {
  // Two credentials, two permission sets. The bridge token is device-capable and predates this
  // work. The command token may only reach /ax/command, and it can never satisfy an owner action.
  // Both comparisons always run, in constant time, so a caller cannot learn which one matched from
  // the response time. An empty credential never matches: the API fails closed when unconfigured.
  const bridgeToken = String(env.HABITAT_AX_BRIDGE_TOKEN || "").trim();
  const commandToken = String(env.HABITAT_AX_COMMAND_TOKEN || "").trim();
  const nexusToken = String(env.AX_NEXUS_TOKEN || "").trim();
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
      recordSecurity({ category: "owner.rejection", severity: "high", outcome: "denied", actor: "ax:command-token", summary: label + " refused: the command token cannot perform owner actions", correlationId: req.correlationId || null });
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
      recordSecurity({ category: "owner.rejection", severity: "medium", outcome: "denied", actor: "anonymous", summary: label + " rejected: owner device credential missing" });
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
      recordSecurity({ category: "owner.rejection", severity: "high", outcome: "denied", actor: "device:" + deviceId.slice(0, 80), deviceId: deviceId.slice(0, 120), summary: label + " rejected: invalid device credential" });
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
      recordSecurity({ category: "owner.rejection", severity: "high", outcome: "denied", actor: "device:" + deviceId.slice(0, 80), deviceId: deviceId.slice(0, 120), summary: label + " rejected: device is not a configured owner" });
      res.status(403).json({ ok: false, code: "not_owner", error: "This device is not the configured owner and cannot perform " + label.toLowerCase() + "." });
      return null;
    }
    recordSecurity({ category: "owner.authorization", severity: "info", outcome: "allowed", actor: "owner:" + deviceId, deviceId, summary: label + " authorized by the paired owner device" });
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

  const schedulerToken = String(env.AX_SCHEDULER_TOKEN || "").trim();
  const securityService = () => resolveService(securityProvider);
  function recordSecurity(entry) {
    const service = securityService();
    if (!service || typeof service.record !== "function") return;
    // Fire-and-forget on purpose: an audit write must never turn a refused request into a retried
    // one, and a failed audit write is reported by its own log path.
    Promise.resolve(service.record(entry)).catch(() => {});
  }

  // Per-process limiter for the whole command surface. It is keyed by the verified credential
  // role, never by a caller-supplied header or body field, so one leaked secret cannot be used to
  // exhaust a shared bucket and one caller cannot evade the limit by rotating a client id. The
  // message channel keeps its own stricter per-origin limit; this one covers submit/read/poll and
  // the operator routes an Action must never reach anyway. Behind several instances the effective
  // limit multiplies by the instance count, which is documented rather than hidden.
  // A malformed override must not lock the API out: non-finite or non-positive values fall back to
  // the documented defaults instead of producing a bucket that refuses every request.
  const positiveSetting = (value, fallback, floor) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(floor, Math.floor(parsed)) : fallback;
  };
  const rateMax = positiveSetting(env.AX_COMMAND_RATE_MAX, 240, 1);
  const rateWindowMs = positiveSetting(env.AX_COMMAND_RATE_WINDOW_MS, 60_000, 1000);
  const rateBuckets = new Map();
  function takeRateSlot(role) {
    const now = Date.now();
    const bucket = rateBuckets.get(role);
    if (!bucket || now - bucket.start >= rateWindowMs) {
      rateBuckets.set(role, { start: now, count: 1 });
      return null;
    }
    bucket.count += 1;
    if (bucket.count <= rateMax) return null;
    return { retryAfterMs: Math.max(0, rateWindowMs - (now - bucket.start)), limit: rateMax, windowMs: rateWindowMs };
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
      recordSecurity({
        category: "auth.failure",
        severity: "medium",
        outcome: "denied",
        actor: "anonymous",
        correlationId: String(req.headers?.["x-correlation-id"] || "").slice(0, 120) || null,
        summary: "Rejected command request with no valid Ax credential: " + String(req.method || "?") + " " + String(req.originalUrl || req.path || "?") + "",
        evidence: "authorization header present=" + Boolean(bearer(req))
      });
      return res.status(401).json({ ok: false, code: "invalid_token", error: "Ax command authentication required." });
    }
    // Audit identity comes from the verified credential, never from the request body.
    req.axRole = role;
    const limited = takeRateSlot(role);
    if (limited) {
      recordSecurity({
        category: "auth.rate_limited",
        severity: "medium",
        outcome: "denied",
        actor: "ax:" + role + "-token",
        summary: "Rejected command request over the per-credential rate limit: " + String(req.method || "?") + " " + String(req.originalUrl || req.path || "?")
      });
      res.setHeader("retry-after", String(Math.ceil(limited.retryAfterMs / 1000)));
      return res.status(429).json({
        ok: false,
        code: "rate_limited",
        error: "Too many command requests in the current window; retry after " + Math.ceil(limited.retryAfterMs / 1000) + " seconds.",
        retryAfterMs: limited.retryAfterMs
      });
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

  // ------------------------------------------------------------------- missions
  const missionUnavailable = (res) => res.status(503).json({
    ok: false,
    code: "mission_pipeline_unavailable",
    error: "The mission pipeline is not mounted in this process: set HABITAT_WORKFORCE_ENABLED=true with a complete D1 binding (CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID, HABITAT_D1_API_TOKEN) and apply migration 0010_ax_workforce."
  });

  const missionView = (mission) => mission && ({
    missionId: mission.id,
    project: mission.project,
    objective: mission.objective,
    status: mission.status,
    acceptanceCriteria: mission.acceptanceCriteria,
    approvals: (mission.approvals || []).map((item) => ({ id: item.id, kind: item.kind, status: item.status, reason: item.reason })),
    commandTaskId: (mission.constraints || []).find((item) => String(item).startsWith("command-task:"))?.slice("command-task:".length) || null,
    milestones: mission.milestones,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    tasks: (mission.tasks || []).map((task) => ({
      id: task.id,
      title: task.title,
      requires: task.requires,
      dependsOn: task.dependsOn,
      status: task.status,
      agentId: task.agentId,
      verifierAgentId: task.verifierAgentId,
      evidence: task.evidence,
      verificationEvidence: task.verificationEvidence,
      tests: task.tests,
      error: task.error
    }))
  });

  route.post("/ax/missions", requireAx, serviceGuard(async (req, res) => {
    const missions = resolveService(missionProvider);
    if (!missions || typeof missions.submit !== "function") return missionUnavailable(res);
    const objective = String(req.body?.objective || "").trim();
    if (!objective) return res.status(400).json({ ok: false, code: "objective_required", error: "An objective is required." });
    const outcome = await missions.submit({
      objective,
      acceptanceCriteria: req.body?.acceptanceCriteria,
      tasks: Array.isArray(req.body?.tasks) ? req.body.tasks : null,
      project: req.body?.project,
      constraints: Array.isArray(req.body?.constraints) ? req.body.constraints : [],
      priority: Number.isInteger(req.body?.priority) ? req.body.priority : null,
      signals: req.body?.signals ?? null,
      idempotencyKey: String(req.body?.idempotencyKey || req.headers?.["idempotency-key"] || "").trim() || null,
      submittedBy: "owner"
    });
    if (!outcome.ok) {
      const status = outcome.code === "approval_required_for_task" ? 409 : 400;
      return res.status(status).json({ ok: false, code: outcome.code, error: outcome.detail || outcome.code, taskId: outcome.taskId || null });
    }
    const mission = await missions.get(outcome.missionId);
    return res.status(outcome.replay ? 200 : 201).json({ ok: true, replay: outcome.replay === true, commandTaskId: outcome.commandTaskId || null, mission: missionView(mission) });
  }));

  route.get("/ax/missions/:missionId", requireAx, serviceGuard(async (req, res) => {
    const missions = resolveService(missionProvider);
    if (!missions) return missionUnavailable(res);
    const mission = await missions.get(String(req.params?.missionId || ""));
    if (!mission) return res.status(404).json({ ok: false, code: "mission_not_found" });
    const events = typeof missions.events === "function" ? await missions.events(mission.id) : [];
    return res.json({ ok: true, mission: missionView(mission), events: events.slice(-50) });
  }));

  route.post("/ax/missions/:missionId/run", requireAx, serviceGuard(async (req, res) => {
    const missions = resolveService(missionProvider);
    if (!missions || typeof missions.run !== "function") return missionUnavailable(res);
    const missionId = String(req.params?.missionId || "");
    const existing = await missions.get(missionId);
    if (!existing) return res.status(404).json({ ok: false, code: "mission_not_found" });
    const maxRounds = Math.max(1, Math.min(5, Number(req.body?.maxRounds) || 3));
    const run = await missions.run(missionId, { maxRounds });
    const mission = await missions.get(missionId);
    return res.json({ ok: true, run, mission: missionView(mission) });
  }));

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
      adapter: req.body?.adapter ?? null,
      // Left undefined when absent so the engine can derive a suggestion from the signals.
      priority: req.body?.priority,
      signals: req.body?.signals ?? null
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

  // ---------------------------------------------------------- Ax <-> NEXUS message channel
  //
  // The durable, bidirectional channel. Ax submits and reads; only the NEXUS credential may
  // acknowledge, report progress, complete, fail or ask a question. A message can name only a
  // read-only adapter from the deployment's allowlist, so this endpoint cannot execute arbitrary
  // commands. The channel is a separate store from the task engine; it never invents a task row.
  const messageChannel = () => resolveService(messageProvider);

  function messagesUnavailable(res) {
    res.status(503).json({
      ok: false,
      code: "message_channel_not_configured",
      error: "The Ax-NEXUS message channel is not mounted on this service; no message was stored."
    });
  }

  const MESSAGE_STATUS_BY_CODE = Object.freeze({
    not_found: 404,
    invalid_transition: 409,
    message_conflict: 409,
    invalid_direction: 409,
    rate_limited: 429,
    evidence_required: 400,
    adapter_not_allowed: 403
  });

  function messageReply(res, outcome, created = false) {
    if (outcome?.ok) return res.status(created ? 201 : 200).json(outcome);
    const status = MESSAGE_STATUS_BY_CODE[outcome?.code] || 400;
    return res.status(status).json({
      ok: false,
      code: outcome?.code || "invalid_request",
      error: outcome?.error || "The message could not be stored.",
      ...(outcome?.retryAfterMs ? { retryAfterMs: outcome.retryAfterMs } : {})
    });
  }

  route.post("/ax/command/messages", requireAx, serviceGuard(async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    // `from` is decided here by the authenticated surface, never by the request body.
    const outcome = await channel.submit({
      kind: req.body?.kind,
      body: req.body?.body ?? req.body?.message,
      objective: req.body?.objective,
      adapter: req.body?.adapter ?? null,
      correlationId: req.body?.correlationId ?? null,
      idempotencyKey: req.body?.idempotencyKey,
      from: "ax",
      client: req.axRole === "command" ? "ax-command-token" : "ax-bridge-token",
      project: req.body?.project ?? null
    });
    return messageReply(res, outcome, !outcome.replayed);
  }));

  route.get("/ax/command/messages", requireAx, serviceGuard(async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    const messages = await channel.list({
      status: req.query?.status || null,
      correlationId: req.query?.correlationId || null,
      from: req.query?.from || null,
      limit: req.query?.limit
    });
    res.json({ ok: true, count: messages.length, messages });
  }));

  // Before the :id route: a correlation id is not a message id and must not be read as one.
  route.get("/ax/command/messages/thread/:correlationId", requireAx, serviceGuard(async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.thread({ correlationId: req.params.correlationId, limit: req.query?.limit }));
  }));

  route.get("/ax/command/messages/:id", requireAx, serviceGuard(async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    const message = await channel.get(req.params.id);
    if (!message) return reply(res, { ok: false, code: "not_found", error: "No message with that id." });
    res.json({ ok: true, message });
  }));

  route.post("/ax/command/messages/:id/answer", requireAx, serviceGuard(async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.answer({
      id: req.params.id,
      answer: req.body?.answer,
      by: req.axRole === "command" ? "ax-command-token" : "ax-bridge-token"
    }));
  }));

  // ------------------------------------------------------------ NEXUS runtime surface
  //
  // A credential distinct from Ax's. The direction of a message is decided by which guard admitted
  // the call, so Ax cannot post as NEXUS and NEXUS cannot submit as Ax. When AX_NEXUS_TOKEN is
  // unset the surface fails closed with 503 instead of accepting the bridge token.
  function requireNexus(req, res, next) {
    if (!nexusToken) {
      return res.status(503).json({
        ok: false,
        code: "nexus_auth_unconfigured",
        error: "NEXUS message surface is unavailable: set AX_NEXUS_TOKEN on this service."
      });
    }
    const presented = String(req.headers?.["x-nexus-token"] || "") || bearer(req);
    if (!safeEqual(presented, nexusToken)) {
      recordSecurity({ category: "auth.failure", severity: "medium", outcome: "denied", actor: "nexus", summary: "Rejected NEXUS message call with no valid credential" });
      return res.status(401).json({ ok: false, code: "invalid_nexus_token", error: "NEXUS message authentication required." });
    }
    req.nexusRole = "nexus";
    return next();
  }

  const nexusRoute = {
    get: (path, ...handlers) => app.get(path, ...withEnvelopeList(handlers)),
    post: (path, ...handlers) => app.post(path, ...withEnvelopeList(handlers))
  };

  nexusRoute.get("/ax/nexus/channel", requireNexus, async (_req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    res.json({
      ok: true,
      channel: {
        ...(await channel.stats()),
        allowedAdapters: channel.allowedAdapters,
        limits: channel.limits,
        states: channel.states
      }
    });
  });

  nexusRoute.get("/ax/nexus/inbox", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    const statuses = String(req.query?.status || "queued,acknowledged,working,awaiting_answer").split(",").map(item => item.trim()).filter(Boolean);
    const batches = await Promise.all(statuses.map(status => channel.list({ status, from: "ax", limit: req.query?.limit, order: "oldest" })));
    const messages = batches.flat().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    res.json({ ok: true, count: messages.length, statuses, messages });
  });

  nexusRoute.post("/ax/nexus/messages/:id/acknowledge", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.acknowledge({ id: req.params.id, executor: req.body?.executor || "nexus", note: req.body?.note || null }));
  });

  nexusRoute.post("/ax/nexus/messages/:id/progress", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.progress({ id: req.params.id, note: req.body?.note || null, percent: req.body?.percent ?? null }));
  });

  nexusRoute.post("/ax/nexus/messages/:id/complete", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.complete({
      id: req.params.id,
      summary: req.body?.summary || null,
      evidence: req.body?.evidence,
      taskId: req.body?.taskId || null,
      runId: req.body?.runId || null
    }));
  });

  nexusRoute.post("/ax/nexus/messages/:id/fail", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.fail({
      id: req.params.id,
      code: req.body?.code || "message_failed",
      message: req.body?.message || null,
      retryable: req.body?.retryable === true
    }));
  });

  nexusRoute.post("/ax/nexus/messages/ask", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.ask({
      correlationId: req.body?.correlationId,
      question: req.body?.question ?? req.body?.body,
      options: req.body?.options,
      objectiveId: req.body?.objectiveId || null,
      requiresDecision: req.body?.requiresDecision !== false,
      kind: req.body?.kind || "question"
    }), true);
  });

  nexusRoute.post("/ax/nexus/messages/notify", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.notifyAx({
      correlationId: req.body?.correlationId || null,
      body: req.body?.body,
      kind: req.body?.kind || "note",
      metadata: req.body?.metadata || null
    }), true);
  });

  nexusRoute.get("/ax/nexus/thread/:correlationId", requireNexus, async (req, res) => {
    const channel = messageChannel();
    if (!channel) return messagesUnavailable(res);
    messageReply(res, await channel.thread({ correlationId: req.params.correlationId, limit: req.query?.limit }));
  });

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
      priority: req.body?.priority || "normal",
      project: req.body?.project || "habitat"
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
    res.json({ ok: true, objective, summary: service.summary(objective), accounting: service.accountingOf(objective) });
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
    // Reserve BEFORE the run exists. The execution id is the deterministic run key, so a retry or a
    // concurrent dispatch reserves once and can never spend the same budget twice. The reservation
    // is the smaller of what remains and the run's own maximum, so several child runs cannot jointly
    // exceed the objective's limit.
    const runKey = "objective:" + objective.id;
    const accountingBefore = service.accountingOf(objective);
    const requestedEstimate = Number(req.body?.estimateUsd);
    const estimate = Number.isFinite(requestedEstimate) && requestedEstimate >= 0
      ? requestedEstimate
      : Number(objective.plan?.estimatedCostUsd || 0) > 0
        ? Number(objective.plan.estimatedCostUsd)
        : Math.min(accountingBefore.remainingUsd, Number(orchestrator.budgetUsd || 0.05));
    const reservation = await service.reserveExecution(objective.id, {
      executionId: runKey,
      runKey,
      estimateUsd: Math.max(0, Math.min(estimate, Math.max(0, accountingBefore.remainingUsd))),
      agentId: (objective.plan?.steps || []).map(step => step.agent).filter(Boolean)[0] || null,
      provider: objective.plan?.provider || null
    });
    if (reservation.ok !== true) {
      if (reservation.code === "budget_exhausted") {
        recordSecurity({
          category: "budget.exhausted",
          severity: "high",
          outcome: "denied",
          actor: "ax",
          objectiveId: objective.id,
          summary: "Objective dispatch refused: no budget remaining",
          evidence: reservation.error
        });
      }
      return objectiveReply(res, reservation);
    }
    const outcome = await orchestrator.runObjective({
      objective: objective.objective,
      // Immutable scope: every child run can be traced to exactly one objective.
      objectiveId: objective.id,
      requestedBy: "ax",
      // Deterministic per objective, so a retried dispatch resumes the same run instead of forking.
      runKey
    });
    const run = outcome?.run || null;
    if (!run && outcome?.code === "store_unavailable") {
      await service.releaseExecution(objective.id, { executionId: runKey, reason: "the run store was unavailable" });
    } else if (run) {
      await service.linkExecutionRun(objective.id, { executionId: runKey, runId: run.id });
      const settled = await service.settleExecution(objective.id, {
        executionId: runKey,
        runId: run.id,
        actualUsd: Number(run.costUsd || 0),
        note: "run status " + String(run.status || "unknown")
      });
      if (settled.ok === true && settled.accounting?.exhausted) {
        recordSecurity({
          category: "budget.exhausted",
          severity: "high",
          outcome: "detected",
          actor: "ax",
          objectiveId: objective.id,
          runId: run.id,
          summary: "Objective budget exhausted after run settlement",
          evidence: JSON.stringify(settled.accounting)
        });
      }
    }
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
    const resolvedObjective = await service.get(objective.id);
    res.status(outcome?.code === "store_unavailable" ? 503 : 200).json({
      ok: outcome?.ok === true,
      code: outcome?.code || null,
      run,
      objective: resolvedObjective,
      accounting: resolvedObjective ? service.accountingOf(resolvedObjective) : null
    });
  }));

  // ------------------------------------------------------------------- mission work cycle
  // One objective -> ordered specialist work -> independent verification -> completion.
  // The cycle never approves anything and never completes an objective whose criteria did not pass.
  route.post("/ax/command/objectives/:id/work", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const cycle = typeof workProvider === "function" ? workProvider() : null;
    if (!cycle) return capabilityUnavailable(res, "work_cycle_not_configured", "The NEXUS work cycle is not mounted on this service.");
    const outcome = await cycle.run({
      objectiveId: req.params.id,
      by: "ax",
      correlationId: req.body?.correlationId || null
    });
    res.status(outcome.ok === true ? 200 : (STATUS_BY_CODE[outcome.code] || 409)).json(outcome);
  }));

  route.post("/ax/command/objectives/:id/work/stop", requireAx, serviceGuard(async (req, res) => {
    const service = objectives();
    if (!service) return capabilityUnavailable(res, "objectives_not_configured", "Durable objectives are not mounted on this service.");
    const cycle = typeof workProvider === "function" ? workProvider() : null;
    if (!cycle) return capabilityUnavailable(res, "work_cycle_not_configured", "The NEXUS work cycle is not mounted on this service.");
    const outcome = await cycle.stop({ objectiveId: req.params.id, by: "ax", reason: req.body?.reason || "stopped through the Ax command API" });
    res.status(outcome.ok === true ? 200 : (STATUS_BY_CODE[outcome.code] || 409)).json(outcome);
  }));

  route.post("/ax/command/agents/revoke", requireAx, serviceGuard(async (req, res) => {
    const cycle = typeof workProvider === "function" ? workProvider() : null;
    if (!cycle) return capabilityUnavailable(res, "work_cycle_not_configured", "The NEXUS work cycle is not mounted on this service.");
    const outcome = await cycle.revoke({ by: "ax", reason: req.body?.reason || "agent permissions revoked through the Ax command API" });
    await recordAudit({ event: "agents.revoked", actorDeviceId: "ax", targetDeviceId: null });
    res.json(outcome);
  }));

  // Restoration is explicit and audited: a durable revocation must not expire on its own.
  route.post("/ax/command/agents/restore", requireAx, serviceGuard(async (req, res) => {
    const cycle = typeof workProvider === "function" ? workProvider() : null;
    if (!cycle) return capabilityUnavailable(res, "work_cycle_not_configured", "The NEXUS work cycle is not mounted on this service.");
    if (typeof cycle.restore !== "function") return capabilityUnavailable(res, "work_cycle_not_configured", "This deployment does not support restoring agent permissions yet.");
    const outcome = await cycle.restore({ by: "ax", reason: req.body?.reason || "agent permissions restored through the Ax command API" });
    await recordAudit({ event: "agents.restored", actorDeviceId: "ax", targetDeviceId: null });
    res.json(outcome);
  }));

  route.get("/ax/command/agents", requireAx, serviceGuard(async (_req, res) => {
    const runtime = agents();
    if (!runtime) return capabilityUnavailable(res, "agents_not_configured", "The agent runtime is not mounted on this service.");
    const cycle = typeof workProvider === "function" ? workProvider() : null;
    const planner = typeof plannerProvider === "function" ? plannerProvider() : null;
    res.json({
      ok: true,
      agents: runtime.capabilityMatrix(),
      limits: runtime.limits,
      delegations: runtime.delegations(),
      revoked: typeof cycle?.revoked === "function" ? cycle.revoked() : null,
      // Null means deterministic planning. A model planner reports its provider/model and the shared
      // daily ledger, never a credential.
      planner: planner
        ? {
            mode: planner.mode || null,
            provider: planner.provider || null,
            model: planner.model || null,
            free: planner.free === true,
            budget: typeof planner.status === "function" ? await planner.status() : null
          }
        : null
    });
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

  // ------------------------------------------------------- security audit and scheduler contract
  function requireScheduler(req, res, next) {
    const manual = Boolean(anyAxToken) && axRole(req) !== null;
    const external = Boolean(schedulerToken) && safeEqual(String(req.headers?.["x-scheduler-token"] || ""), schedulerToken);
    if (!manual && !external) {
      recordSecurity({ category: "auth.failure", severity: "medium", outcome: "denied", actor: "scheduler", summary: "Scheduler tick rejected: no valid scheduler or Ax credential" });
      return res.status(401).json({ ok: false, code: "scheduler_auth_required", error: "A scheduler token or Ax credential is required for a tick." });
    }
    next();
  }

  route.get("/ax/command/security/events", requireAx, serviceGuard(async (req, res) => {
    const service = securityService();
    if (!service) return capabilityUnavailable(res, "security_log_not_configured", "The security audit log is not mounted on this service.");
    const listed = await service.list({
      category: req.query?.category || null,
      severity: req.query?.severity || null,
      beforeSeq: req.query?.beforeSeq ?? null,
      limit: req.query?.limit
    });
    if (listed.ok === false) return capabilityUnavailable(res, listed.code, "The security audit log could not be read.");
    res.set("cache-control", "no-store");
    res.json(listed);
  }));

  route.get("/ax/command/security/integrity", requireAx, serviceGuard(async (req, res) => {
    const service = securityService();
    if (!service) return capabilityUnavailable(res, "security_log_not_configured", "The security audit log is not mounted on this service.");
    const verified = await service.integrity({ limit: req.query?.limit });
    if (verified.ok === false) return capabilityUnavailable(res, verified.code, "Security integrity could not be verified.");
    res.set("cache-control", "no-store");
    res.json(verified);
  }));

  route.get("/ax/command/scheduler/status", requireAx, serviceGuard(async (_req, res) => {
    const scheduler = resolveService(schedulerProvider);
    if (!scheduler) return capabilityUnavailable(res, "scheduler_not_configured", "The scheduler contract is not mounted on this service.");
    res.json(await scheduler.status());
  }));

  route.post("/ax/command/scheduler/tick", requireScheduler, serviceGuard(async (req, res) => {
    const scheduler = resolveService(schedulerProvider);
    if (!scheduler) return capabilityUnavailable(res, "scheduler_not_configured", "The scheduler contract is not mounted on this service.");
    const outcome = await scheduler.tick({ trigger: req.body?.trigger || (req.headers?.["x-scheduler-token"] ? "external" : "manual") });
    res.status(outcome.ok === true ? 200 : outcome.code === "tick_overlap" ? 409 : 500).json(outcome);
  }));

  // ------------------------------------------------------------------ project intelligence
  route.get("/ax/command/projects", requireAx, serviceGuard(async (_req, res) => {
    const projects = resolveService(projectProvider);
    if (!projects) return capabilityUnavailable(res, "projects_not_configured", "Project intelligence is not mounted on this service.");
    res.json(await projects.list());
  }));

  route.get("/ax/command/projects/:id", requireAx, serviceGuard(async (req, res) => {
    const projects = resolveService(projectProvider);
    if (!projects) return capabilityUnavailable(res, "projects_not_configured", "Project intelligence is not mounted on this service.");
    const detail = await projects.detail(req.params.id);
    if (!detail) return reply(res, { ok: false, code: "not_found", error: "No project with that id." });
    res.json(detail);
  }));

  // ------------------------------------------- AX capability network (P1: reporting and approval)
  //
  // Capabilities, the supplier catalog, channel eligibility, the approval ledger and treasury
  // reporting. There is deliberately no purchase, order, transfer, OAuth or payout-execution route:
  // P1 stops at a quote decision and a request. Recording a settled amount or a payout observation
  // needs the owner device, so an agent cannot inflate the cash the treasury reports.
  const NETWORK_STATUS_BY_CODE = Object.freeze({
    not_found: 404,
    owner_required: 403,
    invalid_approval_kind: 400,
    invalid_approval_request: 400,
    secret_material_refused: 400,
    quote_expired: 409,
    quote_window_too_long: 400,
    duplicate_request: 409,
    duplicate_event: 409,
    already_decided: 409,
    already_consumed: 409,
    approval_expired: 409,
    not_approved: 409,
    approval_binding_mismatch: 409,
    approval_conflict: 409,
    invalid_revenue_state: 400,
    invalid_amount: 400,
    invalid_currency: 400,
    invalid_occurred_at: 400,
    invalid_payout_state: 400,
    revenue_id_required: 400,
    revenue_source_required: 400,
    cash_evidence_required: 400,
    payout_id_required: 400,
    unknown_capability: 400,
    refund_reference_required: 400,
    duplicate_refund: 409
  });

  const networkService = () => resolveService(networkProvider);

  // Mutating network calls get their own, stricter bucket on top of the shared command limiter. The
  // shared limiter bounds the process; this bounds how often one credential can create approvals or
  // move treasury figures, which is the abuse that matters on this surface. Reads keep the shared
  // limiter only, so a status poll is never starved by a write-heavy caller on another route.
  const networkWriteMax = positiveSetting(env.AX_NETWORK_WRITE_RATE_MAX, 60, 1);
  const networkWriteWindowMs = positiveSetting(env.AX_NETWORK_WRITE_RATE_WINDOW_MS, 60_000, 1000);
  const networkWriteBuckets = new Map();
  function takeNetworkWriteSlot(role) {
    const now = Date.now();
    const bucket = networkWriteBuckets.get(role);
    if (!bucket || now - bucket.start >= networkWriteWindowMs) {
      networkWriteBuckets.set(role, { start: now, count: 1 });
      return null;
    }
    bucket.count += 1;
    if (bucket.count <= networkWriteMax) return null;
    return { retryAfterMs: Math.max(0, networkWriteWindowMs - (now - bucket.start)), limit: networkWriteMax };
  }
  function networkWriteLimit(req, res, next) {
    const role = req.axRole || "unknown";
    const limited = takeNetworkWriteSlot(role);
    if (!limited) return next();
    recordSecurity({
      category: "auth.rate_limited",
      severity: "medium",
      outcome: "denied",
      actor: "ax:" + role + "-token",
      summary: "Rejected network write over the per-credential limit: " + String(req.method || "?") + " " + String(req.originalUrl || req.path || "?")
    });
    res.setHeader("retry-after", String(Math.ceil(limited.retryAfterMs / 1000)));
    return res.status(429).json({
      ok: false,
      code: "network_rate_limited",
      error: "Too many network writes in the current window; retry after " + Math.ceil(limited.retryAfterMs / 1000) + " seconds.",
      retryAfterMs: limited.retryAfterMs
    });
  }

  function networkUnavailable(res) {
    res.status(503).json({
      ok: false,
      code: "network_not_configured",
      error: "The AX capability network is not mounted on this service; nothing was read or written."
    });
  }

  function networkReply(res, outcome, created = false) {
    if (outcome?.ok) return res.status(created ? 201 : 200).json(outcome);
    const status = NETWORK_STATUS_BY_CODE[outcome?.code] || 400;
    return res.status(status).json({
      ok: false,
      code: outcome?.code || "invalid_request",
      error: outcome?.error || "The request could not be completed."
    });
  }

  route.get("/ax/command/network/status", requireAx, serviceGuard(async (_req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.status());
  }));

  route.get("/ax/command/network/capabilities", requireAx, serviceGuard(async (_req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.capabilities());
  }));

  route.get("/ax/command/network/suppliers", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.suppliers({
      layer: req.query?.layer || null,
      orderModel: req.query?.orderModel || null,
      country: req.query?.country || null
    }));
  }));

  route.get("/ax/command/network/suppliers/:id", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    networkReply(res, await service.supplier(req.params.id));
  }));

  route.post("/ax/command/network/suppliers/fit", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.evaluateSupplier(req.body || {}));
  }));

  route.get("/ax/command/network/channels", requireAx, serviceGuard(async (_req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.channels());
  }));

  route.post("/ax/command/network/channels/eligibility", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.evaluateChannel(req.body || {}));
  }));

  route.get("/ax/command/network/treasury", requireAx, serviceGuard(async (_req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.treasury());
  }));

  route.get("/ax/command/network/treasury/events", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.revenueEvents({ limit: req.query?.limit }));
  }));

  route.post("/ax/command/network/treasury/events", requireAx, networkWriteLimit, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    const state = String(req.body?.state || "").trim().toLowerCase();
    let actor = "ax:" + (req.axRole || "unknown");
    // "Money is real" is an owner claim. An agent may record pipeline, but only the paired owner
    // device may move a figure into or out of cash. Refunds and reversals are included: an agent
    // that could post a refund could otherwise make the treasury report a loss that never happened.
    if (["settled", "available", "refunded", "reversed"].includes(state)) {
      const deviceId = await authorizeOwnerAction(req, res, "Recording settled cash");
      if (!deviceId) return undefined;
      actor = "owner:" + deviceId;
    }
    networkReply(res, await service.recordRevenue({ ...(req.body || {}), actor }), true);
  }));

  route.get("/ax/command/network/treasury/payouts", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.payouts({ limit: req.query?.limit }));
  }));

  // An observation, not a transfer: this records where a channel says a payout is. It cannot start,
  // change or cancel one, and it is owner-only because it changes reported in-transit cash.
  route.post("/ax/command/network/treasury/payouts", requireAx, networkWriteLimit, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    const deviceId = await authorizeOwnerAction(req, res, "Recording a payout observation");
    if (!deviceId) return undefined;
    networkReply(res, await service.recordPayout({ ...(req.body || {}), actor: "owner:" + deviceId }), true);
  }));

  route.post("/ax/command/network/approvals", requireAx, networkWriteLimit, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    // `requestedBy` comes from the authenticated surface, never from the body.
    const outcome = await service.requestApproval({
      ...(req.body || {}),
      requestedBy: "ax:" + (req.axRole || "unknown")
    });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "network.approval.requested", actorDeviceId: "ax", targetDeviceId: outcome.approval?.id || null });
    }
    networkReply(res, outcome, outcome?.created === true);
  }));

  route.get("/ax/command/network/approvals", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    res.json(await service.approvals({ status: req.query?.status || null, kind: req.query?.kind || null, limit: req.query?.limit }));
  }));

  route.get("/ax/command/network/approvals/:id", requireAx, serviceGuard(async (req, res) => {
    const service = networkService();
    if (!service) return networkUnavailable(res);
    networkReply(res, await service.approval(req.params.id));
  }));

  route.post("/ax/command/network/approvals/:id/approve", requireAx, networkWriteLimit, serviceGuard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Approval decision");
    if (!deviceId) return undefined;
    const service = networkService();
    if (!service) return networkUnavailable(res);
    const outcome = await service.approve({ id: req.params.id, by: "owner:" + deviceId, reason: req.body?.reason || null });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "network.approval.approved", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    networkReply(res, outcome);
  }));

  route.post("/ax/command/network/approvals/:id/deny", requireAx, networkWriteLimit, serviceGuard(async (req, res) => {
    const deviceId = await authorizeOwnerAction(req, res, "Approval denial");
    if (!deviceId) return undefined;
    const service = networkService();
    if (!service) return networkUnavailable(res);
    const outcome = await service.deny({ id: req.params.id, by: "owner:" + deviceId, reason: req.body?.reason || null });
    if (outcome?.ok !== false) {
      await recordAudit({ event: "network.approval.denied", actorDeviceId: deviceId, targetDeviceId: req.params.id });
    }
    networkReply(res, outcome);
  }));

  return { engine, registry: registryInstance, store: () => store };
}
