import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { capabilitiesFingerprint, workforceOwnerStatement } from "./ax-worker-auth.mjs";

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
  "workforce:read",
  "workforce:admin",
  "workforce:write",
  "recovery:write",
  "events:write",
  "mcp:events"
]);

export const SCOPE_DESCRIPTIONS = Object.freeze({
  "status:read": "Read system status, worker counts, mission list and the request audit.",
  "missions:read": "Read mission detail, tasks, evidence and approvals.",
  "missions:write": "Submit missions; cannot approve or recover.",
  "missions:approve": "Decide a pending approval; still requires a valid owner attestation.",
  "workforce:read": "Read workforce status, workers, leases, health, recovery history and mission-to-worker links.",
  "workforce:admin": "Owner-attested workforce administration: register or revoke a worker, issue, rotate or revoke a credential, and reconcile an uncertain attempt. Every call also needs an owner attestation.",
  "workforce:write": "Legacy workforce write scope. Worker heartbeats and leases are signed by worker credentials, not by this scope.",
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
  // Workforce v1 lease layer: an object, or a provider called per request so a lazily-initialised runtime
  // does not leave the routes permanently detached.
  workforceV1 = null,
  statusProvider = null,
  ownerVerifier = null,
  rateLimit = { windowMs: 60_000, max: 60 },
  now = () => Date.now(),
  log = console
} = {}) {
  const windows = new Map();
  const requestId = () => "gw_" + now().toString(36) + "_" + randomBytes(4).toString("hex");
  const leases = () => (typeof workforceV1 === "function" ? workforceV1() : workforceV1);

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
    audit(req, {
      clientId: req.axClient?.id || null,
      status,
      outcome,
      detail: {
        missionId: body?.missionId || null,
        workerId: body?.workerId || req.axWorker?.workerId || null,
        credentialId: req.axWorker?.credentialId || null
      }
    });
    return res.status(status).json({ ok: true, requestId: req.axRequestId, ...body });
  };

  /**
   * Owner attestation for a workforce mutation. The gateway verifies the signature and hands the engine the
   * exact statement it covers, so the engine can refuse a signature that was issued for something else.
   */
  async function ownerAuthorize(req, { operation, workerId = null, credentialId = null, detail = "" }) {
    if (!ownerVerifier) return { ok: false, status: 503, code: "owner_attestation_unavailable" };
    const statement = workforceOwnerStatement({ operation, workerId, credentialId, detail });
    const verified = ownerVerifier.verify(
      {
        operation: "workforce." + operation,
        project: "habitat",
        key: workerId || credentialId || "",
        kind: "workforce",
        statement,
        tags: [],
        confidence: null
      },
      req.body?.attestation
    );
    if (!verified.ok) return { ok: false, status: 403, code: verified.code || "owner_attestation_invalid" };
    return { ok: true, by: "owner:" + (verified.keyId || "owner-1"), statement, keyId: verified.keyId || null };
  }

  const WORKER_UNAUTHENTICATED = [
    "worker_credential_invalid",
    "worker_credential_unknown",
    "worker_credential_revoked",
    "worker_credential_rotated",
    "worker_credential_expired",
    "worker_signature_invalid",
    "worker_deregistered",
    "worker_unknown"
  ];

  function workerHeaders(req) {
    const header = String(req.headers.authorization || "");
    return {
      presented: header.startsWith("Worker ")
        ? header.slice(7).trim()
        : String(req.headers["x-ax-worker-credential"] || "").trim(),
      signature: String(req.headers["x-ax-signature"] || "").trim(),
      nonce: String(req.headers["x-ax-nonce"] || "").trim(),
      timestamp: Number(req.headers["x-ax-timestamp"])
    };
  }

  /**
   * A worker route is authenticated by the worker's own signed request, not by a gateway client token. The
   * identity used by the handler is always the one the credential proves; the URL never supplies it.
   */
  function workerRoute(method, path, operation, handler) {
    app[method](path, async (req, res) => {
      req.axRequestId = requestId();
      res.setHeader("X-Ax-Request-Id", req.axRequestId);
      if (!enabled) return fail(res, req, 503, "gateway_disabled");
      const layer = leases();
      if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
      if (typeof layer.authenticateWorkerRequest !== "function") return fail(res, req, 503, "workforce_identity_not_attached");
      const headers = workerHeaders(req);
      const identity = await layer.authenticateWorkerRequest({
        presented: headers.presented,
        operation,
        nonce: headers.nonce,
        timestamp: headers.timestamp,
        signature: headers.signature,
        body: req.body || {}
      });
      if (!identity.ok) {
        const status = identity.code === "workforce_identity_schema_missing" ? 503
          : identity.code === "worker_request_replayed" ? 409
          : ["worker_request_timestamp_invalid", "worker_request_nonce_invalid", "worker_operation_invalid", "worker_replay_store_unavailable"].includes(identity.code) ? 400
          : WORKER_UNAUTHENTICATED.includes(identity.code) ? 401
          : 400;
        return fail(res, req, status, identity.code || "worker_request_refused", { workerId: identity.workerId || null });
      }
      if (await rateLimited("worker:" + identity.credentialId)) return fail(res, req, 429, "gateway_rate_limited");
      req.axWorker = { workerId: identity.workerId, credentialId: identity.credentialId };
      try {
        await handler(req, res, identity);
      } catch (error) {
        log.error?.("AX_GATEWAY_WORKER_HANDLER_FAILED", String(error?.message || error).slice(0, 160));
        return fail(res, req, 500, "gateway_handler_failed");
      }
    });
  }

  function leaseRefusal(code, fallback) {
    if (code === "lease_not_owned") return 403;
    if (["lease_expired", "worker_at_capacity", "worker_executing", "lease_held"].includes(code)) return 409;
    return fallback;
  }

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
      taskId: body.taskId ? String(body.taskId) : null,
      approvalId: body.approvalId ? String(body.approvalId) : null,
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

  /* ── workforce v1 ───────────────────────────────────────────────────────────────────────────── */

  async function missionList() {
    if (!missionRuntime) return [];
    try {
      const listed = await missionRuntime.missions({ limit: 50 });
      return listed?.ok ? listed.missions || [] : [];
    } catch { return []; }
  }

  route("get", "/ax/v1/workforce", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const status = await layer.status({ missions: await missionList() });
    return ok(res, req, { workforce: status });
  });

  route("get", "/ax/v1/workforce/workers", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const workers = await layer.workers({
      capability: req.query.capability || null,
      state: req.query.state || null,
      healthyOnly: String(req.query.healthy || "") === "true"
    });
    return ok(res, req, { workers, count: workers.length, generatedAt: new Date(now()).toISOString() });
  });

  route("get", "/ax/v1/workforce/workers/:id", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const detail = await layer.worker(req.params.id);
    if (!detail.ok) return fail(res, req, detail.code === "worker_unknown" ? 404 : 400, detail.code || "worker_unavailable");
    return ok(res, req, detail);
  });

  // Registration is owner-attested: a gateway client token alone must not create identities, and a worker
  // must never be able to register itself.
  route("post", "/ax/v1/workforce/workers", "workforce:admin", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const body = req.body || {};
    const defaultConcurrency = Number(layer.configuration?.().defaultMaxConcurrent || 1);
    const requested = Number(body.maxConcurrent);
    const concurrency = Number.isInteger(requested) && requested > 0 ? requested : defaultConcurrency;
    const authority = await ownerAuthorize(req, {
      operation: "worker.register",
      workerId: String(body.id || ""),
      detail: capabilitiesFingerprint(body.capabilities) + ":" + concurrency
    });
    if (!authority.ok) return fail(res, req, authority.status, authority.code);
    const registered = await layer.registerWorker({
      id: body.id,
      label: body.label,
      specialty: body.specialty,
      adapterId: body.adapterId,
      capabilities: body.capabilities,
      maxConcurrent: concurrency,
      accepting: body.accepting,
      authorization: authority
    });
    if (!registered.ok) return fail(res, req, 400, registered.code || "worker_not_registered", { details: registered });
    return ok(res, req, { worker: registered.worker, created: registered.created === true, authorizedBy: registered.authorizedBy || null });
  });

  route("post", "/ax/v1/workforce/workers/:id/deregister", "workforce:admin", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const body = req.body || {};
    const authority = await ownerAuthorize(req, { operation: "worker.revoke", workerId: req.params.id });
    if (!authority.ok) return fail(res, req, authority.status, authority.code);
    const outcome = await layer.deregisterWorker({
      id: req.params.id,
      reason: body.reason || null,
      force: body.force === true,
      authorization: authority
    });
    if (!outcome.ok) {
      const status = outcome.code === "worker_unknown" ? 404 : outcome.code === "worker_has_active_leases" ? 409 : 400;
      return fail(res, req, status, outcome.code || "worker_not_deregistered", { activeLeases: outcome.activeLeases || null });
    }
    return ok(res, req, { worker: outcome.worker, abandoned: outcome.abandoned || [], credentialsRevoked: outcome.credentialsRevoked || 0 });
  });

  /* ── worker credentials (owner-attested) ───────────────────────────────────────────────────── */

  route("get", "/ax/v1/workforce/workers/:id/credentials", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const listed = await layer.workerCredentials({ workerId: req.params.id });
    if (!listed.ok) return fail(res, req, listed.code === "workforce_identity_schema_missing" ? 503 : 400, listed.code);
    return ok(res, req, { workerId: req.params.id, credentials: listed.credentials, count: listed.credentials.length });
  });

  route("post", "/ax/v1/workforce/credentials", "workforce:admin", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const body = req.body || {};
    const authority = await ownerAuthorize(req, { operation: "credential.issue", workerId: String(body.workerId || "") });
    if (!authority.ok) return fail(res, req, authority.status, authority.code);
    const issued = await layer.issueCredential({
      workerId: body.workerId,
      label: body.label || null,
      scopes: body.scopes || ["worker"],
      ttlMs: body.ttlMs ?? null,
      authorization: authority
    });
    if (!issued.ok) {
      const status = issued.code === "workforce_identity_schema_missing" ? 503 : issued.code === "worker_unknown" ? 404 : 400;
      return fail(res, req, status, issued.code || "credential_not_issued");
    }
    // The secret appears in this response and nowhere else, ever.
    return ok(res, req, { workerId: body.workerId, credential: issued.credential, secret: issued.secret, secretShownOnce: true }, 201);
  });

  route("post", "/ax/v1/workforce/credentials/:id/rotate", "workforce:admin", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const body = req.body || {};
    const authority = await ownerAuthorize(req, {
      operation: "credential.rotate",
      workerId: String(body.workerId || ""),
      credentialId: req.params.id
    });
    if (!authority.ok) return fail(res, req, authority.status, authority.code);
    const rotated = await layer.rotateCredential({
      credentialId: req.params.id,
      label: body.label || null,
      graceMs: body.graceMs,
      ttlMs: body.ttlMs ?? null,
      authorization: authority
    });
    if (!rotated.ok) {
      const status = rotated.code === "workforce_identity_schema_missing" ? 503 : rotated.code === "worker_credential_unknown" ? 404 : rotated.code === "owner_authorization_mismatch" ? 403 : 400;
      return fail(res, req, status, rotated.code || "credential_not_rotated", { expected: rotated.expected || null });
    }
    return ok(res, req, { credential: rotated.credential, previous: rotated.previous, secret: rotated.secret, secretShownOnce: true });
  });

  route("post", "/ax/v1/workforce/credentials/:id/revoke", "workforce:admin", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const body = req.body || {};
    const authority = await ownerAuthorize(req, { operation: "credential.revoke", credentialId: req.params.id });
    if (!authority.ok) return fail(res, req, authority.status, authority.code);
    const revoked = await layer.revokeCredential({ credentialId: req.params.id, reason: body.reason || null, authorization: authority });
    if (!revoked.ok) {
      const status = revoked.code === "workforce_identity_schema_missing" ? 503 : revoked.code === "worker_credential_unknown" ? 404 : 400;
      return fail(res, req, status, revoked.code || "credential_not_revoked");
    }
    return ok(res, req, { credential: revoked.credential, idempotent: revoked.idempotent === true });
  });

  /* ── signed worker operations ──────────────────────────────────────────────────────────────── */

  workerRoute("post", "/ax/v1/workforce/workers/:id/heartbeat", "heartbeat", async (req, res, identity) => {
    const layer = leases();
    if (req.params.id !== identity.workerId) {
      return fail(res, req, 403, "worker_identity_mismatch", { authenticatedWorkerId: identity.workerId });
    }
    const body = req.body || {};
    const beat = await layer.heartbeat({ id: identity.workerId, state: body.state || null, detail: body.detail || null });
    if (!beat.ok) {
      const status = beat.code === "worker_unknown" ? 404 : beat.code === "worker_deregistered" ? 409 : 400;
      return fail(res, req, status, beat.code || "heartbeat_refused");
    }
    return ok(res, req, { workerId: identity.workerId, credentialId: identity.credentialId, worker: beat.worker, health: beat.health });
  });

  workerRoute("post", "/ax/v1/workforce/leases/acquire", "lease.acquire", async (req, res, identity) => {
    const layer = leases();
    const body = req.body || {};
    const claimed = await layer.acquire({
      missionId: body.missionId,
      taskId: body.taskId,
      workerId: identity.workerId,
      requires: body.requires || [],
      ttlMs: body.ttlMs,
      attempt: body.attempt
    });
    if (!claimed.ok) return fail(res, req, leaseRefusal(claimed.code, 400), claimed.code || "lease_not_acquired", { holder: claimed.holder || null, health: claimed.health || null });
    return ok(res, req, { workerId: identity.workerId, credentialId: identity.credentialId, ...claimed });
  });

  workerRoute("post", "/ax/v1/workforce/leases/:leaseId/renew", "lease.renew", async (req, res, identity) => {
    const layer = leases();
    const body = req.body || {};
    const renewed = await layer.renew({ leaseId: req.params.leaseId, workerId: identity.workerId, ttlMs: body.ttlMs, attempt: body.attempt ?? null });
    if (!renewed.ok) return fail(res, req, leaseRefusal(renewed.code, 400), renewed.code || "lease_not_renewed");
    return ok(res, req, { workerId: identity.workerId, credentialId: identity.credentialId, ...renewed });
  });

  workerRoute("post", "/ax/v1/workforce/leases/:leaseId/release", "lease.release", async (req, res, identity) => {
    const layer = leases();
    const body = req.body || {};
    const released = await layer.release({ leaseId: req.params.leaseId, workerId: identity.workerId, state: body.state || "released", reason: body.reason || null });
    if (!released.ok) return fail(res, req, leaseRefusal(released.code, 400), released.code || "lease_not_released");
    return ok(res, req, { workerId: identity.workerId, credentialId: identity.credentialId, ...released });
  });

  /* ── uncertain operations, recovery queue, reassignment history ──────────────────────────── */

  route("get", "/ax/v1/workforce/uncertain", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const items = await layer.uncertainOperations({
      missionId: req.query.missionId || null,
      limit: Math.min(200, Number(req.query.limit) || 50)
    });
    return ok(res, req, { uncertain: items, count: items.length });
  });

  route("get", "/ax/v1/workforce/uncertain/:key", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const inspected = await layer.inspectUncertain({ idempotencyKey: req.params.key });
    if (!inspected.ok) return fail(res, req, inspected.code === "execution_missing" ? 404 : 400, inspected.code || "execution_unavailable");
    return ok(res, req, inspected);
  });

  route("post", "/ax/v1/workforce/uncertain/:key/reconcile", "workforce:admin", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const body = req.body || {};
    const verdict = String(body.verdict || "unknown");
    const authority = await ownerAuthorize(req, {
      operation: "reconcile",
      credentialId: req.params.key,
      detail: verdict
    });
    if (!authority.ok) return fail(res, req, authority.status, authority.code);
    const reconciled = await layer.reconcileUncertain({
      idempotencyKey: req.params.key,
      verdict,
      proof: body.proof || null,
      providerReference: body.providerReference || null,
      provider: body.provider || null,
      by: authority.by,
      authorization: authority
    });
    if (!reconciled.ok) {
      const status = reconciled.code === "execution_missing" ? 404
        : reconciled.code === "reconciliation_proof_required" ? 422
        : ["execution_not_uncertain", "reconciliation_verdict_invalid"].includes(reconciled.code) ? 409
        : reconciled.code === "workforce_identity_schema_missing" ? 503
        : 400;
      return fail(res, req, status, reconciled.code || "reconciliation_refused", { execution: reconciled.execution || null });
    }
    return ok(res, req, reconciled);
  });

  route("get", "/ax/v1/workforce/recovery/queue", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const queue = await layer.recoveryQueue({ limit: Math.min(200, Number(req.query.limit) || 100) });
    return ok(res, req, queue);
  });

  route("get", "/ax/v1/workforce/reassignments", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const listed = await layer.reassignments({
      missionId: req.query.missionId || null,
      limit: Math.min(200, Number(req.query.limit) || 100)
    });
    return ok(res, req, listed);
  });

  route("get", "/ax/v1/workforce/missions", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const tracked = await missionList();
    const status = await layer.status({ missions: tracked });
    const failed = tracked
      .filter((mission) => ["failed", "verification_failed"].includes(mission.status))
      .map(summarizeMission);
    return ok(res, req, {
      failed: { count: failed.length, items: failed },
      stalled: { count: status.missions.stalled, items: status.missions.items }
    });
  });

  route("get", "/ax/v1/workforce/assignments", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const status = await layer.status({ missions: await missionList() });
    return ok(res, req, { assignments: status.activeAssignments.items, count: status.activeAssignments.count });
  });

  route("get", "/ax/v1/workforce/health", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const status = await layer.status({ missions: await missionList() });
    return ok(res, req, {
      health: status.health,
      workers: { byHealth: status.workers.byHealth, stalled: status.workers.stalled, accepting: status.workers.accepting },
      heartbeat: status.workers.health.map((entry) => ({
        workerId: entry.workerId,
        status: entry.health.status,
        heartbeatAgeMs: entry.health.heartbeatAgeMs,
        lastHeartbeatAt: entry.health.heartbeatAgeMs === null ? null : new Date(now() - entry.health.heartbeatAgeMs).toISOString()
      }))
    });
  });

  route("get", "/ax/v1/workforce/recovery", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const events = await layer.recoveryHistory({
      missionId: req.query.missionId || null,
      kind: req.query.kind || null,
      limit: Math.min(200, Number(req.query.limit) || 50)
    });
    return ok(res, req, { events, count: events.length });
  });

  route("get", "/ax/v1/workforce/missions/:id", "workforce:read", async (req, res) => {
    const layer = leases();
    if (!layer) return fail(res, req, 503, "workforce_leases_not_attached");
    const linked = await layer.missionWorkers({ missionId: req.params.id });
    if (!linked.ok) return fail(res, req, 400, linked.code || "mission_id_invalid");
    return ok(res, req, linked);
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
  tags: [{ name: "status" }, { name: "missions" }, { name: "workforce" }, { name: "heartbeat" }, { name: "audit" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "axg_<client>_<secret>", description: "Dedicated integration token, shown once, stored hashed, revocable." },
      workerCredential: { type: "apiKey", in: "header", name: "x-ax-worker-credential", description: "axw_<credentialId>_<secret>. Each request is HMAC-signed over worker, credential, operation, nonce, timestamp and body hash, and carries a single-use nonce." }
    },
    parameters: {
      nonce: { name: "x-ax-nonce", in: "header", required: true, description: "16-128 chars, single use within the timestamp window.", schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" } },
      workerSignature: { name: "x-ax-signature", in: "header", required: true, description: "HMAC-SHA256 of the canonical worker statement, base64url, prefixed v1,", schema: { type: "string" } },
      ownerAttestation: { name: "attestation", in: "body", required: true, description: "Owner HMAC over the exact workforce statement being mutated." },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["decision", "attestation"], properties: { decision: { type: "string", enum: ["approve", "reject"] }, attestation: { type: "object" }, reason: { type: "string" }, taskId: { type: "string", description: "Names the one task approval this decision authorises; omit to answer only the mission-scope signal." }, approvalId: { type: "string" } } } } } },
        responses: { 200: jsonResponse("Decided", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 409: 1, 429: 1, 503: 1 }) }
      }
    },
    "/ax/v1/heartbeat": { get: { tags: ["heartbeat"], operationId: "getHeartbeat", summary: "Reconnect trigger with current status, missions, pending work and queued events", responses: { 200: jsonResponse("Reconnect payload", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, trigger: { type: "string" }, generatedAt: { type: "string" }, connection: { type: "string" }, missions: { type: "object" }, queued: { type: "array", items: { type: "object" } }, delivery: { type: "object" } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/heartbeat/ack": { post: { tags: ["heartbeat"], operationId: "acknowledgeHeartbeatEvents", summary: "Acknowledge delivered events", parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["eventIds"], properties: { eventIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } } } } } }, responses: { 200: jsonResponse("Acknowledged", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, acknowledged: { type: "integer" }, duplicate: { type: "boolean" } } }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/recover": { post: { tags: ["missions"], operationId: "recoverMissions", summary: "Bounded mission recovery (never approves or deploys)", parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], responses: { 200: jsonResponse("Recovered", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce": { get: { tags: ["workforce"], operationId: "getWorkforce", summary: "Workforce status: workers, health, assignments, lease expirations, retries, failed tasks, stalled missions and durations", responses: { 200: jsonResponse("Workforce status", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, workforce: { type: "object" } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/workers": {
      get: { tags: ["workforce"], operationId: "listWorkforceWorkers", summary: "List worker identities with derived health", parameters: [{ name: "capability", in: "query", required: false, schema: { type: "string" } }, { name: "state", in: "query", required: false, schema: { type: "string" } }, { name: "healthy", in: "query", required: false, schema: { type: "boolean" } }], responses: { 200: jsonResponse("Workers", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, workers: { type: "array", items: { type: "object" } }, count: { type: "integer" } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } },
      post: { tags: ["workforce"], operationId: "registerWorkforceWorker", summary: "Owner-attested registration or update of a worker identity and its capability declaration", parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["id", "capabilities", "attestation"], properties: { id: { type: "string" }, label: { type: "string" }, specialty: { type: "string" }, adapterId: { type: "string" }, capabilities: { type: "array", minItems: 1, items: { type: "string" } }, maxConcurrent: { type: "integer", minimum: 1, maximum: 32 }, accepting: { type: "boolean" }, attestation: { type: "object" } } } } } }, responses: { 200: jsonResponse("Registered", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 429: 1, 503: 1 }) } }
    },
    "/ax/v1/workforce/workers/{id}": { get: { tags: ["workforce"], operationId: "getWorkforceWorker", summary: "Worker detail with health, active assignments and lease history", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: jsonResponse("Worker", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 404: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/workers/{id}/deregister": { post: { tags: ["workforce"], operationId: "deregisterWorkforceWorker", summary: "Owner-attested deregistration; revokes every worker credential and is refused while a live lease exists unless force is set", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["attestation"], properties: { reason: { type: "string" }, force: { type: "boolean" }, attestation: { type: "object" } } } } } }, responses: { 200: jsonResponse("Deregistered", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 409: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/workers/{id}/heartbeat": { post: { tags: ["workforce"], operationId: "workforceHeartbeat", summary: "Signed worker heartbeat; the path id must equal the credential's worker, and every nonce works once", security: [{ workerCredential: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }, { $ref: "#/components/parameters/workerSignature" }], requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { state: { type: "string" }, detail: { type: "string" } } } } } }, responses: { 200: jsonResponse("Heartbeat recorded", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 409: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/assignments": { get: { tags: ["workforce"], operationId: "listWorkforceAssignments", summary: "Active leases: which worker owns which mission task, and until when", responses: { 200: jsonResponse("Assignments", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, assignments: { type: "array", items: { type: "object" } }, count: { type: "integer" } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/health": { get: { tags: ["workforce"], operationId: "getWorkforceHealth", summary: "Worker health and heartbeat ages", responses: { 200: jsonResponse("Health", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/recovery": { get: { tags: ["workforce"], operationId: "listWorkforceRecovery", summary: "Recovery history: expiries, reassignments, resumes, uncertain outcomes", parameters: [{ name: "missionId", in: "query", required: false, schema: { type: "string" } }, { name: "kind", in: "query", required: false, schema: { type: "string" } }, { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } }], responses: { 200: jsonResponse("Recovery events", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, events: { type: "array", items: { type: "object" } }, count: { type: "integer" } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/missions/{id}": { get: { tags: ["workforce"], operationId: "getMissionWorkforce", summary: "Mission-to-worker relationships, attempts and lease history", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: jsonResponse("Mission workforce", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/missions": { get: { tags: ["workforce"], operationId: "listWorkforceMissionHealth", summary: "Failed missions and stalled missions, with the workers attached to each", responses: { 200: jsonResponse("Mission health", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/workers/{id}/credentials": { get: { tags: ["workforce"], operationId: "listWorkerCredentials", summary: "Credential metadata for a worker (never the secret)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: jsonResponse("Credentials", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/credentials": { post: { tags: ["workforce"], operationId: "issueWorkerCredential", summary: "Owner-attested credential issue; the secret is returned once and never again", parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["workerId", "attestation"], properties: { workerId: { type: "string" }, label: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, ttlMs: { type: "integer" }, attestation: { type: "object" } } } } } }, responses: { 201: jsonResponse("Issued", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/credentials/{id}/rotate": { post: { tags: ["workforce"], operationId: "rotateWorkerCredential", summary: "Owner-attested rotation: same durable worker identity, new key, old key usable only during the grace window", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["workerId", "attestation"], properties: { workerId: { type: "string" }, label: { type: "string" }, graceMs: { type: "integer" }, ttlMs: { type: "integer" }, attestation: { type: "object" } } } } } }, responses: { 200: jsonResponse("Rotated", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/credentials/{id}/revoke": { post: { tags: ["workforce"], operationId: "revokeWorkerCredential", summary: "Owner-attested credential revocation; effective immediately", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["attestation"], properties: { reason: { type: "string" }, attestation: { type: "object" } } } } } }, responses: { 200: jsonResponse("Revoked", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/leases/acquire": { post: { tags: ["workforce"], operationId: "workerAcquireLease", summary: "Signed worker lease acquisition; identity comes from the credential, never the body", security: [{ workerCredential: [] }], parameters: [{ $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }, { $ref: "#/components/parameters/workerSignature" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["missionId", "taskId"], properties: { missionId: { type: "string" }, taskId: { type: "string" }, requires: { type: "array", items: { type: "string" } }, attempt: { type: "integer", minimum: 1 }, ttlMs: { type: "integer" } } } } } }, responses: { 200: jsonResponse("Acquired", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 409: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/leases/{leaseId}/renew": { post: { tags: ["workforce"], operationId: "workerRenewLease", summary: "Signed renewal; only the credential that owns the lease can renew it", security: [{ workerCredential: [] }], parameters: [{ name: "leaseId", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }, { $ref: "#/components/parameters/workerSignature" }], requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { ttlMs: { type: "integer" }, attempt: { type: "integer" } } } } } }, responses: { 200: jsonResponse("Renewed", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 409: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/leases/{leaseId}/release": { post: { tags: ["workforce"], operationId: "workerReleaseLease", summary: "Signed release; only the owning credential can release", security: [{ workerCredential: [] }], parameters: [{ name: "leaseId", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }, { $ref: "#/components/parameters/workerSignature" }], requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { state: { type: "string" }, reason: { type: "string" } } } } } }, responses: { 200: jsonResponse("Released", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 409: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/uncertain": { get: { tags: ["workforce"], operationId: "listUncertainOperations", summary: "Attempts whose external outcome is unknown, with provider references", parameters: [{ name: "missionId", in: "query", required: false, schema: { type: "string" } }, { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } }], responses: { 200: jsonResponse("Uncertain operations", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/uncertain/{key}": { get: { tags: ["workforce"], operationId: "inspectUncertainOperation", summary: "Read-only inspection of one uncertain attempt and its provider reference", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }], responses: { 200: jsonResponse("Inspection", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 404: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/uncertain/{key}/reconcile": { post: { tags: ["workforce"], operationId: "reconcileUncertainOperation", summary: "Owner-attested verdict: confirmed_success, confirmed_failure, not_executed (proof required to allow a retry) or unknown", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/nonce" }, { $ref: "#/components/parameters/timestamp" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["verdict", "attestation"], properties: { verdict: { type: "string", enum: ["unknown", "confirmed_success", "confirmed_failure", "not_executed"] }, proof: { type: "object", description: "Provider evidence; required unless the verdict is unknown." }, provider: { type: "string" }, providerReference: { type: "string" }, attestation: { type: "object" } } } } } }, responses: { 200: jsonResponse("Reconciled", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 400: 1, 401: 1, 403: 1, 404: 1, 409: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/recovery/queue": { get: { tags: ["workforce"], operationId: "getWorkforceRecoveryQueue", summary: "Expired and abandoned leases with the decision each one needs, plus uncertain attempts", parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } }], responses: { 200: jsonResponse("Recovery queue", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/workforce/reassignments": { get: { tags: ["workforce"], operationId: "listWorkforceReassignments", summary: "Reassignment and recovery decisions: from worker, to worker, reason and decision", parameters: [{ name: "missionId", in: "query", required: false, schema: { type: "string" } }, { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } }], responses: { 200: jsonResponse("Reassignments", { ...OK_ENVELOPE, additionalProperties: true }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } },
    "/ax/v1/audit": { get: { tags: ["audit"], operationId: "gatewayAudit", summary: "Recent gateway requests", responses: { 200: jsonResponse("Audit", { ...OK_ENVELOPE, properties: { ...OK_ENVELOPE.properties, entries: { type: "array", items: { type: "object" } } } }), ...errorResponses({ 401: 1, 429: 1, 503: 1 }) } } }
  }
});
