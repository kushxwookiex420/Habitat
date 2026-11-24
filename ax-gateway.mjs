import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticated Ax ↔ Habitat gateway.
 *
 * This is the interface ChatGPT (or any integration) uses to read Habitat and submit missions. It is
 * not a chat screen and not a second orchestrator: reads are projections of the runtime, writes call
 * the existing mission runtime, and approvals still require an owner attestation.
 *
 * Security model, deliberately simple and testable:
 *  - a dedicated integration identity per client, token shown once and stored as a SHA-256 hash;
 *  - least-privilege scopes checked per route;
 *  - expiry and revocation checked on every request;
 *  - POST requests need a timestamp and a single-use nonce (database-level replay guard);
 *  - per-client rate limiting in memory (documented as single-instance only);
 *  - every request is audited with its outcome;
 *  - no anonymous fallback and no credential in a response.
 *
 * Disabled by default: with `HABITAT_GATEWAY_ENABLED` unset every route answers 503 and no token is
 * checked, so attaching it changes no existing behavior.
 */

export const GATEWAY_FLAG = "HABITAT_GATEWAY_ENABLED";
export const GATEWAY_MIGRATION = "0012_ax_gateway";

export const GATEWAY_SCOPES = Object.freeze([
  "status:read",
  "missions:read",
  "missions:write",
  "missions:approve",
  "recovery:write",
  "events:write",
  "mcp:events"
]);

export const SCOPE_DESCRIPTIONS = Object.freeze({
  "status:read": "Read system status, worker counts, mission list and the request audit.",
  "missions:read": "Read mission detail, tasks, evidence and approvals.",
  "missions:write": "Submit missions; cannot approve or recover.",
  "missions:approve": "Decide a pending approval; still requires a valid owner attestation.",
  "recovery:write": "Run bounded mission recovery (never approves or deploys).",
  "events:write": "Acknowledge delivered heartbeat events; cannot submit or approve work.",
  "mcp:events": "Use the MCP Events endpoint: list events, subscribe and unsubscribe."
});

const NONCE_WINDOW_MS = 5 * 60 * 1000;
const TOKEN_PATTERN = /^axg_([a-z0-9][a-z0-9-]{2,31})_([A-Za-z0-9_-]{32,120})$/;

export function gatewayEnabled(env = process.env) {
  return String(env?.[GATEWAY_FLAG] ?? "").trim().toLowerCase() === "true";
}

export function hashToken(secret) {
  return createHash("sha256").update(String(secret)).digest("hex");
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function summarizeMission(mission) {
  const tasks = Array.isArray(mission.tasks) ? mission.tasks : [];
  return {
    id: mission.id,
    status: mission.status,
    objective: String(mission.objective || "").slice(0, 200),
    createdAt: mission.createdAt || null,
    updatedAt: mission.updatedAt || null,
    tasks: {
      total: tasks.length,
      completed: tasks.filter(task => task.status === "completed").length,
      failed: tasks.filter(task => task.status === "failed").length,
      blocked: tasks.filter(task => task.status === "blocked").length
    },
    approvals: (mission.approvals || []).map(item => ({ reason: item.reason, status: item.status }))
  };
}

/**
 * Create one integration client. The plaintext token is returned once and never stored.
 * Admin action by design: there is no HTTP route that mints credentials.
 */
export async function resolveClientToken({ repository, authorization, scope = null, now = () => Date.now() } = {}) {
  if (!repository) return { ok: false, code: "gateway_not_configured", status: 503 };
  const header = String(authorization || "");
  if (!header.startsWith("Bearer ")) return { ok: false, code: "gateway_token_required", status: 401 };
  const match = TOKEN_PATTERN.exec(header.slice(7).trim());
  if (!match) return { ok: false, code: "gateway_token_invalid", status: 401 };
  const client = await repository.getClient(match[1]).catch(() => null);
  if (!client) return { ok: false, code: "gateway_client_unknown", status: 401 };
  if (!safeEqualHex(client.tokenHash, hashToken(match[2]))) return { ok: false, code: "gateway_token_invalid", status: 401 };
  if (client.revokedAt) return { ok: false, code: "gateway_client_revoked", status: 401 };
  if (client.expiresAt && Date.parse(client.expiresAt) <= now()) return { ok: false, code: "gateway_client_expired", status: 401 };
  if (scope && !client.scopes.includes(scope)) return { ok: false, code: "gateway_scope_required", status: 403, required: scope };
  try { await repository.touchClient(client.id); } catch { /* best effort */ }
  return { ok: true, client };
}

export async function issueClientToken({ repository, label, scopes, expiresAt = null, now = () => new Date().toISOString() } = {}) {
  if (!repository || typeof repository.createClient !== "function") return { ok: false, code: "gateway_repository_required" };
  const wanted = (Array.isArray(scopes) ? scopes : []).map(scope => String(scope).trim());
  const invalid = wanted.filter(scope => !GATEWAY_SCOPES.includes(scope));
  if (wanted.length === 0) return { ok: false, code: "scopes_required" };
  if (invalid.length) return { ok: false, code: "scope_unknown", invalid };
  const id = "gw-" + randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const tokenHash = hashToken(secret);
  const client = await repository.createClient({ id, label: String(label || id).slice(0, 80), tokenHash, scopes: wanted, expiresAt });
  return { ok: true, clientId: id, token: "axg_" + id + "_" + secret, scopes: wanted, createdAt: client?.createdAt || now() };
}

export function registerAxGateway(app, {
  enabled = gatewayEnabled(),
  repository = null,
  missionRuntime = null,
  heartbeat = null,
  statusProvider = null,
  ownerVerifier = null,
  rateLimit = { windowMs: 60_000, max: 60 },
  now = () => Date.now(),
  log = console
} = {}) {
  const windows = new Map();
  const requestId = () => "gw_" + now().toString(36) + "_" + randomBytes(4).toString("hex");

  async function audit(req, { clientId = null, status = 0, outcome = "unknown", detail = {} } = {}) {
    if (!repository || typeof repository.appendAudit !== "function") return;
    try {
      await repository.appendAudit({ clientId, method: req.method, path: req.path, status, outcome, detail });
    } catch (error) {
      log.error?.("AX_GATEWAY_AUDIT_FAILED", String(error?.message || error).slice(0, 160));
    }
  }

  function fail(res, req, status, code, extra = {}, outcome = code) {
    const payload = { ok: false, code, requestId: req.axRequestId || null, ...extra };
    audit(req, { clientId: req.axClient?.id || null, status, outcome, detail: { code, ...(extra.missionId ? { missionId: extra.missionId } : {}) } });
    return res.status(status).json(payload);
  }

  async function rateLimited(clientId) {
    // Prefer the shared counter: with more than one gateway instance, a process-local window lets each
    // instance spend the full budget. Fall back to memory only when 0014 is absent.
    if (repository && typeof repository.consumeRateLimit === "function") {
      try {
        const shared = await repository.consumeRateLimit({ clientId, windowMs: rateLimit.windowMs, max: rateLimit.max, at: now() });
        if (shared.shared) return !shared.ok;
      } catch { /* fall through to the in-process window */ }
    }
    const at = now();
    const current = windows.get(clientId);
    if (!current || current.resetAt <= at) {
      windows.set(clientId, { count: 1, resetAt: at + rateLimit.windowMs });
      return false;
    }
    current.count += 1;
    return current.count > rateLimit.max;
  }

  async function authenticate(req, res, scope) {
    if (!enabled) return { ok: false, response: fail(res, req, 503, "gateway_disabled") };
    if (!repository) return { ok: false, response: fail(res, req, 503, "gateway_not_configured") };
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return { ok: false, response: fail(res, req, 401, "gateway_token_required") };
    const match = TOKEN_PATTERN.exec(header.slice(7).trim());
    if (!match) return { ok: false, response: fail(res, req, 401, "gateway_token_invalid") };

    const client = await repository.getClient(match[1]).catch(() => null);
    if (!client) return { ok: false, response: fail(res, req, 401, "gateway_client_unknown") };
    if (!safeEqualHex(client.tokenHash, hashToken(match[2]))) return { ok: false, response: fail(res, req, 401, "gateway_token_invalid") };
    if (client.revokedAt) return { ok: false, response: fail(res, req, 401, "gateway_client_revoked") };
    if (client.expiresAt && Date.parse(client.expiresAt) <= now()) return { ok: false, response: fail(res, req, 401, "gateway_client_expired") };
    if (await rateLimited(client.id)) return { ok: false, response: fail(res, req, 429, "gateway_rate_limited") };
    if (scope && !client.scopes.includes(scope)) return { ok: false, response: fail(res, req, 403, "gateway_scope_required", { required: scope, granted: client.scopes }) };

    req.axClient = client;
    if (String(req.method).toUpperCase() !== "GET") {
      const nonce = String(req.headers["x-ax-nonce"] || "").trim();
      const timestamp = Number(req.headers["x-ax-timestamp"]);
      if (!nonce || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return { ok: false, response: fail(res, req, 400, "gateway_nonce_required") };
      if (!Number.isFinite(timestamp) || Math.abs(now() - timestamp) > NONCE_WINDOW_MS) return { ok: false, response: fail(res, req, 400, "gateway_timestamp_invalid") };
      const nonceResult = await repository.useNonce(client.id, nonce, new Date(now() + NONCE_WINDOW_MS).toISOString());
      if (!nonceResult.ok) return { ok: false, response: fail(res, req, 409, "gateway_nonce_replayed") };
    }
    try { await repository.touchClient(client.id); } catch { /* best effort */ }
    return { ok: true, client };
  }

  function route(method, path, scope, handler) {
    app[method](path, async (req, res) => {
      req.axRequestId = requestId();
      res.setHeader("X-Ax-Request-Id", req.axRequestId);
      const auth = await authenticate(req, res, scope);
      if (!auth.ok) return;
      try {
        await handler(req, res, auth.client);
      } catch (error) {
        log.error?.("AX_GATEWAY_HANDLER_FAILED", String(error?.message || error).slice(0, 160));
        return fail(res, req, 500, "gateway_handler_failed");
      }
    });
  }

  const ok = (res, req, body, status = 200, outcome = "ok") => {
    audit(req, { clientId: req.axClient?.id || null, status, outcome, detail: { missionId: body?.missionId || null } });
    return res.status(status).json({ ok: true, requestId: req.axRequestId, ...body });
  };

  route("get", "/ax/v1/status", "status:read", async (req, res) => {
    const status = statusProvider ? await statusProvider() : null;
    const components = status?.components || {};
    return ok(res, req, {
      habitat: { version: status?.version || null, commit: status?.commit || null, uptimeSeconds: status?.uptimeSeconds ?? null },
      identity: components.identity || null,
      workforce: components.workforce || null,
      missions: components.missions || null,
      storage: components.storage || null,
      execution: components.workers?.execution || null,
      delivery: { received: true, executed: true, verified: components.identity?.persisted === true }
    });
  });

  route("get", "/ax/v1/heartbeat", "status:read", async (req, res) => {
    if (!heartbeat) return fail(res, req, 503, "heartbeat_not_attached");
    const reconnected = await heartbeat.reconnect({ clientId: req.axClient.id });
    return ok(res, req, reconnected);
  });

  route("post", "/ax/v1/heartbeat/ack", "events:write", async (req, res) => {
    if (!heartbeat) return fail(res, req, 503, "heartbeat_not_attached");
    const ids = Array.isArray(req.body?.eventIds) ? req.body.eventIds.map(String).filter(Boolean).slice(0, 100) : [];
    if (ids.length === 0) return fail(res, req, 400, "event_ids_required");
    const acknowledged = await heartbeat.acknowledge(ids);
    return ok(res, req, { acknowledged: acknowledged.acknowledged, duplicate: acknowledged.duplicate, requested: acknowledged.requested });
  });

  route("get", "/ax/v1/missions", "status:read", async (req, res) => {
    if (!missionRuntime) return fail(res, req, 503, "missions_not_attached");
    const listed = await missionRuntime.missions({ status: req.query.status || null, limit: Math.min(50, Number(req.query.limit) || 20) });
    if (!listed.ok) return fail(res, req, 503, listed.code || "missions_unavailable");
    return ok(res, req, { missions: listed.missions.map(summarizeMission), count: listed.missions.length });
  });

  route("get", "/ax/v1/missions/:id", "missions:read", async (req, res) => {
    if (!missionRuntime) return fail(res, req, 503, "missions_not_attached");
    const found = await missionRuntime.mission(req.params.id);
    if (!found.ok) return fail(res, req, found.code === "mission_not_found" ? 404 : 503, found.code || "mission_unavailable");
    const mission = found.mission;
    const verified = mission.status === "completed";
    return ok(res, req, {
      mission,
      summary: summarizeMission(mission),
      delivery: { received: true, executed: mission.status !== "planned", verified }
    });
  });

  route("post", "/ax/v1/missions", "missions:write", async (req, res) => {
    if (!missionRuntime) return fail(res, req, 503, "missions_not_attached");
    const body = req.body || {};
    const spec = {
      project: body.project,
      objective: body.objective,
      acceptanceCriteria: body.acceptanceCriteria,
      requirements: body.requirements,
      constraints: body.constraints,
      risks: body.risks,
      tasks: body.tasks
    };
    if (!String(spec.objective || "").trim()) return fail(res, req, 400, "objective_required");
    if (!Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.length === 0) return fail(res, req, 400, "acceptance_criteria_required");
    const submitted = await missionRuntime.intake(spec, {
      submittedBy: "gateway:" + req.axClient.id,
      idempotencyKey: String(req.headers["idempotency-key"] || "").trim() || null
    });
    if (!submitted.ok) return fail(res, req, 503, submitted.code || "mission_not_accepted", { details: submitted });
    return ok(res, req, {
      missionId: submitted.missionId,
      status: submitted.mission?.status || "planned",
      duplicate: submitted.replay === true,
      approvals: submitted.approvals || [],
      delivery: { received: true, executed: false, verified: false }
    }, 202, submitted.replay ? "duplicate" : "accepted");
  });

  route("post", "/ax/v1/missions/:id/decision", "missions:approve", async (req, res) => {
    if (!missionRuntime) return fail(res, req, 503, "missions_not_attached");
    if (!ownerVerifier) return fail(res, req, 503, "owner_attestation_unavailable");
    const body = req.body || {};
    const decided = await missionRuntime.approve({
      missionId: req.params.id,
      decision: body.decision,
      attestation: body.attestation,
      reason: body.reason,
      by: "owner"
    });
    if (!decided.ok) {
      const status = ["owner_attestation_invalid", "owner_attestation_required", "owner_attestation_expired", "owner_attestation_replayed", "owner_attestation_key_revoked"].includes(decided.code) ? 403 : 409;
      return fail(res, req, status, decided.code || "approval_failed");
    }
    return ok(res, req, { missionId: req.params.id, status: decided.status, delivery: { received: true, executed: true, verified: decided.status === "completed" } });
  });

  route("post", "/ax/v1/recover", "recovery:write", async (req, res) => {
    if (!missionRuntime) return fail(res, req, 503, "missions_not_attached");
    const recovered = await missionRuntime.tick();
    if (!recovered.ok) return fail(res, req, 503, recovered.code || "recovery_failed");
    return ok(res, req, { recovered: recovered.recovered || 0, results: recovered.results || [], delivery: { received: true, executed: true, verified: false } });
  });

  route("get", "/ax/v1/audit", "status:read", async (req, res) => {
    const entries = await repository.listAudit({ limit: Math.min(200, Number(req.query.limit) || 50) });
    return ok(res, req, { entries, count: entries.length });
  });

  app.get("/ax/v1/openapi.json", (_req, res) => {
    // The schema is not secret, but a disabled gateway does not advertise itself either.
    if (!enabled) return res.status(503).json({ ok: false, code: "gateway_disabled", requestId: requestId() });
    res.setHeader("cache-control", "public, max-age=300");
    return res.json(OPENAPI);
  });

  return Object.freeze({
    enabled,
    scopes: GATEWAY_SCOPES,
    migration: GATEWAY_MIGRATION
  });
}

/** Minimal, real OpenAPI 3.1 description that ChatGPT Actions can import. */
const ERROR_SCHEMA = { type: "object", required: ["ok", "code"], properties: { ok: { type: "boolean" }, code: { type: "string" }, requestId: { type: ["string", "null"] } } };
const MISSION_SUBMISSION_SCHEMA = { type: "object", required: ["objective", "acceptanceCriteria"], additionalProperties: false, properties: { project: { type: "string" }, objective: { type: "string", maxLength: 2000 }, acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } }, requirements: { type: "array", items: { type: "string" } }, constraints: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, tasks: { type: "array", items: { type: "object" } } } };
const OK_ENVELOPE = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" }, requestId: { type: "string" } } };

function jsonResponse(description, schema, extra = {}) {
  return { description, content: { "application/json": { schema: schema || { ...OK_ENVELOPE, additionalProperties: true } } }, ...extra };
}

function errorResponses(statuses = {}) {
  const base = { 400: "Bad request", 401: "Unauthorized", 403: "Scope or attestation refused", 409: "Replay or conflict", 429: "Rate limited", 503: "Disabled or storage unavailable" };
  return Object.fromEntries(Object.keys(statuses).map(code => [code, jsonResponse(base[code] || "Error", ERROR_SCHEMA)]));
}

export const OPENAPI = Object.freeze({
  openapi: "3.1.0",
  info: {
    title: "Ax ↔ Habitat Gateway",
    version: "1.0.0",
    summary: "Scoped, authenticated access to Habitat.",
    description: "Read status, mission results and heartbeat events; submit missions, decide approvals with an owner attestation, and run bounded recovery. Disabled unless HABITAT_GATEWAY_ENABLED=true. Every POST requires x-ax-timestamp and x-ax-nonce. A 202 means received, not executed; a completed mission is verified only when its detail reports verification evidence."
  },
  servers: [{ url: "/", description: "Set this to the public HTTPS origin of the Habitat gateway before importing into ChatGPT." }],
  tags: [{ name: "status" }, { name: "missions" }, { name: "heartbeat" }, { name: "audit" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "axg_<client>_<secret>", description: "Dedicated integration token, shown once, stored hashed, revocable." } },
    parameters: {
      nonce: { name: "x-ax-nonce", in: "header", required: true, description: "16-128 chars, single use within the timestamp window.", schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" } },
      timestamp: { name: "x-ax-timestamp", in: "header", required: true, description: "Epoch milliseconds, within five minutes.", schema: { type: "integer" } },
      idempotency: { name: "Idempotency-Key", in: "header", required: false, description: "Same key returns the same mission; duplicate:true.", schema: { type: "string" } },
      missionId: { name: "id", in: "path", required: true, schema: { type: "string" } }
    },
    schemas: { Error: ERROR_SCHEMA, MissionSubmission: MISSION_SUBMISSION_SCHEMA, OkEnvelope: OK_ENVELOPE }
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/ax/v1/status": { get: { tags: ["status"], operationId: "getStatus", summary: "Habitat status (identity, workforce, missions, storage, heartbeat)", responses: { 200: jsonResponse("Status", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/missions": {
      get: { tags: ["missions"], operationId: "listMissions", summary: "List missions", parameters: [{ name: "status", in: "query", required: false, schema: { type: "string" } }, { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } }], responses: { 200: jsonResponse("Missions", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, missions: { type: "array", items: { type: "object" } }, count: { type: "integer" } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } },
      post: {
        tags: ["missions"], operationId: "submitMission", summary: "Submit a mission",
        parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }, { $ref: "#/components/parameters/idempotency" }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MissionSubmission" } } } },
        responses: { 202: jsonResponse("Accepted: received, not yet executed", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, missionId: { type: "string" }, status: { type: "string" }, duplicate: { type: "boolean" }, delivery: { type: "object", properties: { received: { type: "boolean" }, executed: { type: "boolean" }, verified: { type: "boolean" } } } } }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 409: 1, 429: 1, 503: 1 }) }
      }
    },
    "/ax/v1/missions/{id}": { get: { tags: ["missions"], operationId: "getMission", summary: "Mission detail with evidence", parameters: [{ $ref: "#/components/parameters/missionId" }], responses: { 200: jsonResponse("Mission", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 404: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/missions/{id}/decision": {
      post: {
        tags: ["missions"], operationId: "decideMission", summary: "Approve or reject a pending mission (owner attestation required)",
        parameters: [{ $ref: "#/components/parameters/missionId" }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["decision", "attestation"], properties: { decision: { type: "string", enum: ["approve", "reject"] }, attestation: { type: "object" }, reason: { type: "string" } } } } } },
        responses: { 200: jsonResponse("Decided", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 409: 1, 429: 1, 503: 1 }) }
      }
    },
    "/ax/v1/heartbeat": { get: { tags: ["heartbeat"], operationId: "getHeartbeat", summary: "Reconnect trigger with current status, missions, pending work and queued events", responses: { 200: jsonResponse("Reconnect payload", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, trigger: { type: "string" }, generatedAt: { type: "string" }, connection: { type: "string" }, missions: { type: "object" }, queued: { type: "array", items: { type: "object" } }, delivery: { type: "object" } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/heartbeat/ack": { post: { tags: ["heartbeat"], operationId: "acknowledgeHeartbeatEvents", summary: "Acknowledge delivered events", parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["eventIds"], properties: { eventIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } } } } } }, responses: { 200: jsonResponse("Acknowledged", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, acknowledged: { type: "integer" }, duplicate: { type: "boolean" } } }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/recover": { post: { tags: ["missions"], operationId: "recoverMissions", summary: "Bounded mission recovery (never approves or deploys)", parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], responses: { 200: jsonResponse("Recovered", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/audit": { get: { tags: ["audit"], operationId: "gatewayAudit", summary: "Recent gateway requests", responses: { 200: jsonResponse("Audit", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, entries: { type: "array", items: { type: "object" } } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } }
  }
});
