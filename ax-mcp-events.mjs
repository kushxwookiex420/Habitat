import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createPinnedCallbackFetch } from "./ax-callback-fetch.mjs";

/**
 * OpenAI MCP Events adapter.
 *
 * Implements the contract documented at developers.openai.com/plugins/build/mcp-events:
 * `initialize`/`server/discover` advertise `events`, `events/list` describes the catalog,
 * `events/subscribe` verifies the callback and stores a subscription, `events/unsubscribe` stops it.
 * Deliveries are one signed Standard Webhooks request per event, with persistent retry state and a
 * cursor that does not skip queued events.
 *
 * This is the MCP Events webhook integration, not generic MCP notifications and not
 * `subscriptions/listen`. It is default-disabled (`HABITAT_MCP_EVENTS_ENABLED`).
 */

export const MCP_FLAG = "HABITAT_MCP_EVENTS_ENABLED";
export const MCP_SCOPE = "mcp:events";
export const MCP_PROTOCOL_VERSIONS = Object.freeze(["2025-03-26", "2025-06-18", "2026-07-28"]);
export const MCP_SERVER_INFO = Object.freeze({ name: "habitat-ax", version: "1.0.0" });
export const MCP_MAX_BODY_BYTES = 256 * 1024;
export const MCP_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MCP_MIN_TTL_MS = 60 * 1000;
export const MCP_SECRET_GRACE_MS = 5 * 60 * 1000;

export function mcpEnabled(env = process.env) {
  return String(env?.[MCP_FLAG] ?? "").trim().toLowerCase() === "true";
}

const FILTERS = {
  project: { type: "string", description: "Only events for this Habitat project (default: all)." },
  mission_id: { type: "string", description: "Only events for this mission id." },
  system: { type: "string", enum: ["habitat", "gateway", "heartbeat", "workforce", "deployment", "business", "security"], description: "Only events from this subsystem." }
};

const PAYLOAD = {
  project: { type: "string" }, missionId: { type: "string" }, status: { type: "string" },
  summary: { type: "string" }, detail: { type: "object" }, occurredAt: { type: "string" }
};

function eventDefinition(name, description, { system = null, payload = PAYLOAD } = {}) {
  return {
    name,
    description,
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: { ...FILTERS, ...(system ? { system: { ...FILTERS.system, enum: [system] } } : {}) },
      required: [],
      additionalProperties: false
    },
    payloadSchema: { type: "object", properties: payload, required: [], additionalProperties: true }
  };
}

export const EVENT_CATALOG = Object.freeze([
  eventDefinition("mission.created", "A mission was accepted into the Habitat mission engine.", { system: "habitat" }),
  eventDefinition("mission.started", "A mission or its first task began executing.", { system: "habitat" }),
  eventDefinition("mission.completed", "A mission reached completed status; verification evidence is described in detail.", { system: "habitat" }),
  eventDefinition("mission.failed", "A mission failed or was blocked and may need recovery.", { system: "habitat" }),
  eventDefinition("verification.completed", "Independent verification finished for a mission task or the whole mission.", { system: "habitat" }),
  eventDefinition("approval.required", "A mission is waiting for an owner approval decision.", { system: "habitat" }),
  eventDefinition("approval.resolved", "A pending approval was approved or rejected.", { system: "habitat" }),
  eventDefinition("worker.unavailable", "A required worker or workforce capability is unavailable.", { system: "workforce" }),
  eventDefinition("recovery.required", "A mission or runtime needs bounded recovery.", { system: "habitat" }),
  eventDefinition("deployment.status.changed", "A deployment or release status changed.", { system: "deployment" }),
  eventDefinition("security.incident", "A security or runtime incident was recorded.", { system: "security" }),
  eventDefinition("business.operation.changed", "An important business operation changed state.", { system: "business" }),
  eventDefinition("heartbeat.reconnect", "Habitat asks ChatGPT to restore context and inspect current state.", {
    system: "heartbeat",
    payload: {
      trigger: { type: "string" }, health: { type: "object" }, gateway: { type: "object" }, heartbeat: { type: "object" },
      active: { type: "array" }, completed: { type: "array" }, failed: { type: "array" }, pendingTasks: { type: "array" },
      approvals: { type: "array" }, changes: { type: "array" }, delivery: { type: "object" }, recommendedAction: { type: "string" }
    }
  })
]);

export const EVENT_NAMES = Object.freeze(EVENT_CATALOG.map(event => event.name));
const CATALOG_BY_NAME = new Map(EVENT_CATALOG.map(event => [event.name, event]));

export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

export function subscriptionIdFor({ principal, name, argsCanonical, url }) {
  return "sub_" + createHash("sha256").update([principal, name, argsCanonical, url].join("\n")).digest("hex").slice(0, 24);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function decodeSecret(secret) {
  const raw = String(secret || "");
  if (!raw.startsWith("whsec_")) return null;
  try {
    const bytes = Buffer.from(raw.slice(6), "base64");
    const roundTrip = bytes.toString("base64").replace(/=+$/, "");
    if (bytes.length < 24 || bytes.length > 64) return null;
    if (roundTrip !== raw.slice(6).replace(/=+$/, "")) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Standard Webhooks signature: `v1,<base64 hmac>` over `${id}.${timestamp}.${body}`. */
export function signWebhook({ secret, id, timestamp, body }) {
  const key = decodeSecret(secret);
  if (!key) return null;
  return "v1," + createHmac("sha256", key).update(id + "." + timestamp + "." + body).digest("base64");
}

export function verifyWebhookSignature({ secret, id, timestamp, body, signature, toleranceSeconds = 300, now = Date.now() }) {
  const key = decodeSecret(secret);
  if (!key) return { ok: false, code: "secret_invalid" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds) return { ok: false, code: "timestamp_invalid" };
  const expected = createHmac("sha256", key).update(String(id) + "." + String(timestamp) + "." + String(body)).digest("base64");
  const candidates = String(signature || "").split(" ").map(part => part.replace(/^v1,/, "")).filter(Boolean);
  return { ok: candidates.some(candidate => safeEqual(candidate, expected)), code: candidates.some(candidate => safeEqual(candidate, expected)) ? "ok" : "signature_invalid" };
}

const PRIVATE_RANGES = [
  ["10.", 8], ["127.", 8], ["169.254.", 16], ["172.16.", 12], ["192.168.", 16], ["0.", 8]
];

function isPrivateAddress(address) {
  const value = String(address || "");
  if (value.includes(":")) {
    const lower = value.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd") || lower === "::";
  }
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet))) return true;
  if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  return false;
}

export async function validateCallbackUrl(url, { allowInsecureCallbacks = false, resolveHost = lookup } = {}) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { ok: false, reason: "url_invalid" }; }
  if (parsed.username || parsed.password) return { ok: false, reason: "url_credentials_forbidden" };
  if (parsed.hash) return { ok: false, reason: "url_fragment_forbidden" };
  if (parsed.protocol !== "https:" && !(allowInsecureCallbacks && parsed.protocol === "http:")) return { ok: false, reason: "https_required" };
  if (allowInsecureCallbacks) return { ok: true, url: parsed.toString() };
  try {
    const addresses = await resolveHost(parsed.hostname, { all: true, verbatim: true });
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (!list.length) return { ok: false, reason: "host_unresolved" };
    if (list.some(entry => isPrivateAddress(entry.address))) return { ok: false, reason: "private_address_forbidden" };
  } catch {
    return { ok: false, reason: "host_unresolved" };
  }
  return { ok: true, url: parsed.toString() };
}

export class McpError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function validateArguments(name, args) {
  const definition = CATALOG_BY_NAME.get(name);
  if (!definition) throw new McpError(-32602, "Unknown event name.", { reason: "event_unknown" });
  if (args === null || args === undefined) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new McpError(-32602, "arguments must be an object.", { reason: "arguments_invalid" });
  for (const [key, value] of Object.entries(args)) {
    const filter = definition.inputSchema.properties[key];
    if (!filter) throw new McpError(-32602, "Unsupported filter " + key, { reason: "filter_unsupported" });
    if (filter.type === "string" && typeof value !== "string") throw new McpError(-32602, "Filter " + key + " must be a string.", { reason: "filter_invalid" });
    if (filter.enum && !filter.enum.includes(value)) throw new McpError(-32602, "Filter " + key + " has an unsupported value.", { reason: "filter_invalid" });
  }
  return args;
}

function eventMatches(event, args) {
  if (args.project && event.data?.project && event.data.project !== args.project) return false;
  if (args.mission_id && event.data?.missionId !== args.mission_id) return false;
  if (args.system && event.data?.system !== args.system) return false;
  return true;
}

export function createMcpEventsServer({
  repository,
  now = () => Date.now(),
  callbackFetch = null,
  resolveHost = lookup,
  allowInsecureCallbacks = false,
  owner = "mcp-worker-" + randomBytes(6).toString("hex"),
  leaseMs = 60_000,
  fetchImpl = fetch,
  maxAttempts = 5,
  retryBaseMs = 30_000,
  verificationTtlMs = 10 * 60 * 1000,
  log = console
} = {}) {
  if (!repository) throw new Error("The MCP events server needs a repository.");

  const iso = () => new Date(now()).toISOString();
  // Default to a DNS-pinned, redirect-rejecting fetch. Tests may inject one explicitly.
  const effectiveFetch = callbackFetch || createPinnedCallbackFetch({ allowInsecure: allowInsecureCallbacks, resolveHost });
  const eventId = () => "evt_" + now().toString(36) + "_" + randomBytes(6).toString("hex");

  async function verifyCallback({ id, url, secret, principal }) {
    const cached = await repository.getVerification({ principal, url });
    if (cached && now() - Date.parse(cached) <= verificationTtlMs) return { ok: true, cached: true };
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    const timestamp = String(Math.floor(now() / 1000));
    const webhookId = "msg_verification_" + randomBytes(8).toString("hex");
    const signature = signWebhook({ secret, id: webhookId, timestamp, body });
    const headers = { "content-type": "application/json", "webhook-id": webhookId, "webhook-timestamp": timestamp, "webhook-signature": signature, "X-MCP-Subscription-Id": id };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await effectiveFetch(url, { method: "POST", headers, body, signal: controller.signal, redirect: "error" });
      if (!response.ok) return { ok: false, reason: "challenge_failed", status: response.status };
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!payload || !safeEqual(payload.challenge, challenge)) return { ok: false, reason: "challenge_failed" };
      await repository.recordVerification({ principal, url, at: iso() });
      return { ok: true, cached: false };
    } catch (error) {
      return { ok: false, reason: error?.name === "AbortError" ? "timeout" : "challenge_failed", error: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  function backoff(attempts) {
    return new Date(now() + Math.min(60 * 60_000, retryBaseMs * Math.pow(2, Math.max(0, attempts)))).toISOString();
  }

  async function subscribe({ principal, params }) {
    const name = String(params?.name || "");
    const args = validateArguments(name, params?.arguments || {});
    const delivery = params?.delivery || {};
    if (delivery.mode !== "webhook") throw new McpError(-32602, "Only webhook delivery is supported.", { reason: "delivery_mode_unsupported" });
    const urlCheck = await validateCallbackUrl(delivery.url, { allowInsecureCallbacks, resolveHost });
    if (!urlCheck.ok) throw new McpError(-32602, "Callback URL is not acceptable.", { reason: urlCheck.reason });
    if (!decodeSecret(delivery.secret)) throw new McpError(-32602, "Signing secret must be whsec_ followed by base64 of 24-64 bytes.", { reason: "secret_invalid" });

    const argsCanonical = canonicalJson(args);
    const id = subscriptionIdFor({ principal, name, argsCanonical, url: urlCheck.url });
    const existing = await repository.findSubscription({ principal, name, argsCanonical, url: urlCheck.url });
    const verification = await verifyCallback({ id, url: urlCheck.url, secret: delivery.secret, principal });
    if (!verification.ok) throw new McpError(-32015, "Callback verification failed.", { reason: verification.reason || "challenge_failed" });

    const requestedTtl = Object.prototype.hasOwnProperty.call(params || {}, "ttlMs") ? params.ttlMs : undefined;
    const ttlMs = requestedTtl === null ? null : Math.min(MCP_MAX_TTL_MS, Math.max(MCP_MIN_TTL_MS, Number(requestedTtl) || MCP_DEFAULT_TTL_MS));
    const refreshBefore = ttlMs === null ? null : new Date(now() + ttlMs).toISOString();

    const rotation = existing && existing.secret !== delivery.secret;
    const subscription = await repository.saveSubscription({
      id,
      principal,
      name,
      arguments: args,
      argsCanonical,
      url: urlCheck.url,
      secret: delivery.secret,
      previousSecret: rotation ? existing.secret : (existing?.previousSecret && existing.secretGraceUntil && Date.parse(existing.secretGraceUntil) > now() ? existing.previousSecret : null),
      secretGraceUntil: rotation ? new Date(now() + MCP_SECRET_GRACE_MS).toISOString() : existing?.secretGraceUntil || null,
      createdAt: existing?.createdAt || iso(),
      refreshBefore,
      lastCursor: existing?.lastCursor ?? null,
      verifiedAt: iso()
    });

    // Replay: from the supplied cursor (or the stored one) to the current head. A first subscription with
    // no cursor starts at the current head instead of replaying all history.
    const bounds = await repository.eventBounds();
    const requestedCursor = params?.cursor !== null && params?.cursor !== undefined && Number.isFinite(Number(params.cursor)) ? Number(params.cursor) : null;
    const cursor = requestedCursor ?? existing?.lastCursor ?? null;
    const baseline = cursor ?? bounds.maxSeq ?? 0;
    const replay = await repository.listEvents({ afterSeq: baseline });
    let enqueued = 0;
    for (const event of replay) {
      if (event.name !== name || !eventMatches(event, args)) continue;
      const queued = await repository.enqueueDelivery({ subscriptionId: id, eventSeq: event.seq, eventId: event.eventId });
      if (queued.created) enqueued += 1;
    }
    const truncated = bounds.minSeq !== null && baseline > 0 && baseline < bounds.minSeq - 1;
    return { id, refreshBefore, cursor, truncated, replayed: enqueued };
  }

  async function unsubscribe({ principal, params }) {
    const name = String(params?.name || "");
    const argsCanonical = canonicalJson(params?.arguments || {});
    const url = String(params?.delivery?.url || "");
    const existing = await repository.findSubscription({ principal, name, argsCanonical, url });
    if (existing) await repository.revokeSubscription(existing.id, { at: iso() });
    return {};
  }

  async function listEvents(params = {}) {
    const pageSize = 50;
    const start = Number.isFinite(Number(params.cursor)) ? Math.max(0, Number(params.cursor)) : 0;
    const slice = EVENT_CATALOG.slice(start, start + pageSize);
    return { events: slice, ...(start + pageSize < EVENT_CATALOG.length ? { nextCursor: String(start + pageSize) } : {}) };
  }

  async function emit({ name, data = {}, eventId: providedId = null, occurredAt = iso() }) {
    if (!EVENT_NAMES.includes(name)) return { ok: false, code: "event_unknown" };
    const appended = await repository.appendEvent({ eventId: providedId || eventId(), name, data, occurredAt });
    if (!appended.created) return { ok: true, duplicate: true, event: appended.event, queued: 0 };
    let queued = 0;
    for (const subscription of await repository.listSubscriptions({ activeOnly: true })) {
      if (subscription.name !== name) continue;
      if (subscription.refreshBefore && Date.parse(subscription.refreshBefore) <= now()) continue;
      if (!eventMatches(appended.event, subscription.arguments)) continue;
      const delivery = await repository.enqueueDelivery({ subscriptionId: subscription.id, eventSeq: appended.event.seq, eventId: appended.event.eventId });
      if (delivery.created) queued += 1;
    }
    return { ok: true, duplicate: false, event: appended.event, queued };
  }

  async function ingestHeartbeatEvents(events = []) {
    const emitted = [];
    for (const source of events) {
      const status = String(source?.payload?.status || "");
      const missionId = source?.payload?.missionId || null;
      const base = { project: "habitat", missionId, status, summary: source?.payload?.objective || null, sourceEventId: source.id, system: "habitat" };
      const names = [];
      if (source.kind === "approval_pending" || status === "approval_required") names.push("approval.required");
      if (status === "planned") names.push("mission.created");
      if (["running", "assigned", "in_progress", "executing"].includes(status)) names.push("mission.started");
      if (status === "completed") names.push("mission.completed", "verification.completed");
      if (["failed", "blocked", "error"].includes(status)) names.push("mission.failed");
      for (const name of names) {
        emitted.push(await emit({ name, data: base, eventId: "mcp_" + source.id + "_" + name.replace(/\./g, "_") }));
      }
    }
    return emitted;
  }

  async function deliverOne({ subscription, event, delivery }) {
    const body = JSON.stringify({ eventId: event.eventId, name: event.name, timestamp: event.occurredAt, data: event.data, cursor: event.seq });
    if (Buffer.byteLength(body, "utf8") > MCP_MAX_BODY_BYTES) {
      await repository.markDead(delivery.id, { at: iso(), error: "payload_too_large" });
      return { ok: false, status: 413 };
    }
    const timestamp = String(Math.floor(now() / 1000));
    const signatures = [];
    const current = signWebhook({ secret: subscription.secret, id: event.eventId, timestamp, body });
    if (current) signatures.push(current);
    if (subscription.previousSecret && subscription.secretGraceUntil && Date.parse(subscription.secretGraceUntil) > now()) {
      const previous = signWebhook({ secret: subscription.previousSecret, id: event.eventId, timestamp, body });
      if (previous) signatures.push(previous);
    }
    const headers = {
      "content-type": "application/json",
      "webhook-id": event.eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signatures.join(" "),
      "X-MCP-Subscription-Id": subscription.id
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await effectiveFetch(subscription.url, { method: "POST", headers, body, signal: controller.signal, redirect: "error" });
      if (response.ok) {
        await repository.markDelivered(delivery.id, { at: iso() });
        // Record progress only after a 2xx; a refresh cursor will not skip anything still queued.
        await repository.updateCursor(subscription.id, event.seq);
        return { ok: true, status: response.status };
      }
      if (response.status === 410 || response.status === 413) {
        await repository.markDead(delivery.id, { at: iso(), error: "webhook_status_" + response.status });
        return { ok: false, status: response.status, dead: true };
      }
      const attempts = (delivery.attempts || 0) + 1;
      if (attempts >= maxAttempts) {
        await repository.markDead(delivery.id, { at: iso(), error: "webhook_status_" + response.status });
        return { ok: false, status: response.status, dead: true };
      }
      await repository.markAttempt(delivery.id, { at: iso(), nextAttemptAt: backoff(attempts), error: "webhook_status_" + response.status });
      return { ok: false, status: response.status, retry: true };
    } catch (error) {
      const attempts = (delivery.attempts || 0) + 1;
      if (attempts >= maxAttempts) {
        await repository.markDead(delivery.id, { at: iso(), error: String(error?.message || error) });
        return { ok: false, dead: true, error: String(error?.message || error) };
      }
      await repository.markAttempt(delivery.id, { at: iso(), nextAttemptAt: backoff(attempts), error: String(error?.message || error) });
      return { ok: false, retry: true, error: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function dispatch({ limit = 20 } = {}) {
    await repository.expireSubscriptions({ at: iso() });
    const due = await repository.dueDeliveries({ at: iso(), limit });
    let delivered = 0;
    let failed = 0;
    let dead = 0;
    let skipped = 0;
    for (const delivery of due) {
      const subscription = await repository.getSubscription(delivery.subscriptionId);
      if (subscription?.secretUnreadable) {
        await repository.markDead(delivery.id, { at: iso(), error: "signing_secret_unreadable" });
        dead += 1;
        continue;
      }
      if (!subscription || subscription.revokedAt || (subscription.refreshBefore && Date.parse(subscription.refreshBefore) <= now())) {
        await repository.markDead(delivery.id, { at: iso(), error: "subscription_inactive" });
        dead += 1;
        continue;
      }
      const event = (await repository.listEvents({ afterSeq: delivery.eventSeq - 1, name: subscription.name, limit: 1 })).find(item => item.seq === delivery.eventSeq);
      if (!event) {
        await repository.markDead(delivery.id, { at: iso(), error: "event_missing" });
        dead += 1;
        continue;
      }
      if (!eventMatches(event, subscription.arguments)) {
        await repository.markDead(delivery.id, { at: iso(), error: "filter_no_longer_matches" });
        skipped += 1;
        continue;
      }
      // Claim before sending: another replica must not send the same delivery while this lease is live.
      const claim = typeof repository.claimDelivery === "function"
        ? await repository.claimDelivery(delivery.id, { owner, leaseMs, at: iso() })
        : { claimed: true, delivery };
      if (!claim.claimed) { skipped += 1; continue; }
      const result = await deliverOne({ subscription, event, delivery: claim.delivery || delivery });
      if (result.ok) delivered += 1;
      else if (result.dead) dead += 1;
      else failed += 1;
    }
    return { ok: true, attempted: due.length, delivered, failed, dead, skipped };
  }

  async function handleRpc(message, { principal } = {}) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    const id = message.id ?? null;
    const params = message.params || {};
    const respond = result => ({ jsonrpc: "2.0", id, result });
    try {
      if (message.id === undefined && message.method.startsWith("notifications/")) return null;
      switch (message.method) {
        case "initialize": {
          const requested = String(params.protocolVersion || "");
          const negotiated = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : "2025-06-18";
          return respond({ protocolVersion: negotiated, capabilities: { events: {} }, serverInfo: MCP_SERVER_INFO });
        }
        case "server/discover":
          return respond({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { events: {} }, serverInfo: MCP_SERVER_INFO });
        case "tools/list":
          return respond({ tools: [] });
        case "events/list":
          return respond(await listEvents(params));
        case "events/subscribe": {
          if (!principal) return { jsonrpc: "2.0", id, error: { code: -32001, message: "Authentication required" } };
          return respond(await subscribe({ principal, params }));
        }
        case "events/unsubscribe": {
          if (!principal) return { jsonrpc: "2.0", id, error: { code: -32001, message: "Authentication required" } };
          return respond(await unsubscribe({ principal, params }));
        }
        case "ping":
          return respond({});
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      }
    } catch (error) {
      if (error instanceof McpError) return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message, data: error.data } };
      log.error?.("MCP_RPC_FAILED", String(error?.message || error).slice(0, 160));
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
    }
  }

  return Object.freeze({
    listEvents, subscribe, unsubscribe, emit, ingestHeartbeatEvents, dispatch, deliverOne,
    handleRpc, verifyCallback, catalog: EVENT_CATALOG
  });
}

/**
 * Express registration. Authentication is injected: the caller resolves a gateway client from the
 * bearer token and checks the `mcp:events` scope. One JSON-RPC POST endpoint, no session state.
 */
export function registerMcpEvents(app, {
  enabled = mcpEnabled(),
  server = null,
  authenticate = null,
  log = console
} = {}) {
  app.post("/mcp", async (req, res) => {
    if (!enabled) return res.status(503).json({ ok: false, code: "mcp_events_disabled" });
    if (!server || typeof server.handleRpc !== "function") return res.status(503).json({ ok: false, code: "mcp_events_not_configured" });
    if (typeof authenticate !== "function") return res.status(503).json({ ok: false, code: "mcp_events_auth_not_configured" });
    let authenticated = null;
    try {
      authenticated = await authenticate(req);
    } catch (error) {
      log.error?.("MCP_AUTH_FAILED", String(error?.message || error).slice(0, 160));
    }
    if (!authenticated || (authenticated.ok === false && !authenticated.client)) {
      return res.status(authenticated?.status || 401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: authenticated?.code || "Unauthorized" } });
    }
    const client = authenticated.client || authenticated;
    const message = req.body;
    const response = await server.handleRpc(message, { principal: client.id });
    if (response === null) return res.status(202).end();
    return res.status(200).json(response);
  });
}
