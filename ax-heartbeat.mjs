import { createHmac, randomBytes } from "node:crypto";

/**
 * Ax connection monitor.
 *
 * Habitat keeps its own heartbeat whether or not any integration is listening. Meaningful state changes
 * become durable, deduplicated events; delivery is attempted through a notifier only when one is
 * configured; and a reconnect payload lets an authorized integration restore shared mission context.
 *
 * This module does not pretend that an ordinary API call can wake an inactive ChatGPT conversation.
 * ChatGPT integrations are pull-based unless the workspace supports MCP Events webhook delivery; the
 * webhook notifier here can target such a relay, and the pull endpoint is the guaranteed path. The
 * exact trigger string is always the same so instructions can recognize it.
 *
 * Disabled by default: `HABITAT_HEARTBEAT_ENABLED` must be "true" before a loop is started.
 */

export const HEARTBEAT_FLAG = "HABITAT_HEARTBEAT_ENABLED";
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_STALE_AFTER_MS = 10 * 60_000;
export const TRIGGER_MESSAGE = "AX RECONNECT — HABITAT HEARTBEAT.";

export function heartbeatEnabled(env = process.env) {
  return String(env?.[HEARTBEAT_FLAG] ?? "").trim().toLowerCase() === "true";
}

const ACTIVE_STATUSES = new Set(["running", "assigned", "in_progress", "executing", "planned", "approval_required"]);
const FAILED_STATUSES = new Set(["failed", "blocked", "error"]);

function missionSummary(mission) {
  const tasks = Array.isArray(mission.tasks) ? mission.tasks : [];
  return {
    id: mission.id,
    status: mission.status,
    objective: String(mission.objective || "").slice(0, 240),
    updatedAt: mission.updatedAt || null,
    tasks: {
      total: tasks.length,
      completed: tasks.filter(task => task.status === "completed").length,
      failed: tasks.filter(task => FAILED_STATUSES.has(task.status)).length
    },
    approvals: (mission.approvals || []).filter(item => item.status === "pending" || item.status === "required").map(item => ({ reason: item.reason, status: item.status }))
  };
}

export function summarizeSnapshot(missions = []) {
  const active = missions.filter(mission => ACTIVE_STATUSES.has(mission.status)).map(missionSummary);
  const completed = missions.filter(mission => mission.status === "completed").map(missionSummary);
  const failed = missions.filter(mission => FAILED_STATUSES.has(mission.status)).map(missionSummary);
  const approvals = missions.flatMap(mission => (mission.approvals || [])
    .filter(item => item.status === "pending" || item.status === "required")
    .map(item => ({ missionId: mission.id, reason: item.reason, status: item.status })));
  const pendingTasks = missions.flatMap(mission => (mission.tasks || [])
    .filter(task => !["completed", "cancelled"].includes(task.status))
    .map(task => ({ missionId: mission.id, taskId: task.id, title: task.title || null, status: task.status })));
  return { activeMissions: active, completedWork: completed, failures: failed, approvals, pendingTasks };
}

function ago(iso, nowMs) {
  const parsed = Date.parse(iso || "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : Infinity;
}

export function createHeartbeatMonitor({
  repository,
  integration = "chatgpt",
  missionRuntime = null,
  statusProvider = null,
  notifier = null,
  now = () => Date.now(),
  intervalMs = HEARTBEAT_INTERVAL_MS,
  staleAfterMs = HEARTBEAT_STALE_AFTER_MS,
  maxAttempts = 3,
  maxEventsPerBeat = 25,
  log = console
} = {}) {
  if (!repository || typeof repository.saveState !== "function") throw new Error("The heartbeat monitor needs a repository.");

  const eventId = () => "evt_" + now().toString(36) + "_" + randomBytes(4).toString("hex");

  async function currentState() {
    return (await repository.getState(integration)) || {
      integration, status: "never_connected", lastBeatAt: null, lastSeenAt: null,
      lastDeliveryAt: null, lastAckAt: null, missedBeats: 0, failures: 0, detail: {}
    };
  }

  async function snapshot() {
    const [status, listed] = await Promise.all([
      statusProvider ? statusProvider().catch(error => ({ error: String(error?.message || error) })) : Promise.resolve(null),
      missionRuntime && typeof missionRuntime.missions === "function"
        ? missionRuntime.missions({ limit: 50 }).catch(error => ({ ok: false, code: "missions_unavailable", error: String(error?.message || error) }))
        : Promise.resolve({ ok: false, code: "missions_not_attached" })
    ]);
    const missions = listed?.ok ? listed.missions || [] : [];
    const components = status?.components || {};
    return {
      at: new Date(now()).toISOString(),
      habitat: { version: status?.version || null, commit: status?.commit || null, uptimeSeconds: status?.uptimeSeconds ?? null },
      components: {
        identity: components.identity || null,
        workforce: components.workforce || null,
        missions: components.missions || null,
        gateway: components.gateway || null
      },
      missionsAvailable: Boolean(listed?.ok),
      missionsCode: listed?.ok ? null : listed?.code || null,
      missions,
      ...summarizeSnapshot(missions)
    };
  }

  async function collectEvents(snap) {
    const enqueued = [];
    const approvals = new Set();
    for (const mission of snap.missions) {
      const stateChanged = await repository.enqueueEvent({
        id: eventId(),
        integration,
        kind: "mission_status",
        dedupeKey: "mission:" + mission.id + ":" + String(mission.status),
        priority: FAILED_STATUSES.has(mission.status) ? 1 : mission.status === "approval_required" ? 2 : 5,
        payload: { missionId: mission.id, status: mission.status, objective: String(mission.objective || "").slice(0, 240), updatedAt: mission.updatedAt || null }
      });
      if (stateChanged.created) enqueued.push(stateChanged.event);
      for (const approval of mission.approvals || []) {
        if (!["pending", "required"].includes(approval.status)) continue;
        const key = "approval:" + mission.id + ":" + String(approval.reason || "approval");
        if (approvals.has(key)) continue;
        approvals.add(key);
        const queued = await repository.enqueueEvent({
          id: eventId(), integration, kind: "approval_pending", dedupeKey: key, priority: 2,
          payload: { missionId: mission.id, reason: approval.reason || null, status: approval.status }
        });
        if (queued.created) enqueued.push(queued.event);
      }
    }
    return enqueued;
  }

  function deriveConnection(state) {
    const at = now();
    const beatAge = ago(state.lastBeatAt, at);
    const seenAge = ago(state.lastSeenAt, at);
    if (!state.lastBeatAt) return "never_started";
    if ((state.missedBeats || 0) >= 2) return "disconnected";
    if (beatAge > intervalMs * 2 + 1000) return "disconnected";
    if ((state.failures || 0) > 0) return "delivery_failing";
    if (!state.lastSeenAt) return state.lastDeliveryAt ? "awaiting_ack" : "never_connected";
    if (seenAge > staleAfterMs) return "stale";
    return "connected";
  }

  async function status() {
    const state = await currentState();
    const counts = typeof repository.counts === "function" ? await repository.counts({ integration }) : {};
    return {
      integration,
      flag: HEARTBEAT_FLAG,
      intervalMs,
      staleAfterMs,
      connection: deriveConnection(state),
      lastBeatAt: state.lastBeatAt,
      lastSeenAt: state.lastSeenAt,
      lastDeliveryAt: state.lastDeliveryAt,
      lastAckAt: state.lastAckAt,
      missedBeats: state.missedBeats,
      failures: state.failures,
      queue: { pending: counts.pending || 0, delivered: counts.delivered || 0, acknowledged: counts.acknowledged || 0, dead: counts.dead || 0 },
      notifier: notifier ? notifier.channel || "configured" : "none"
    };
  }

  async function beat() {
    const at = now();
    const iso = new Date(at).toISOString();
    const previous = await currentState();
    const snap = await snapshot();
    const queued = await collectEvents(snap);

    let missedBeats = previous.missedBeats || 0;
    if (previous.lastBeatAt) {
      const gap = at - Date.parse(previous.lastBeatAt);
      if (gap > intervalMs * 1.5) missedBeats += Math.max(1, Math.floor(gap / intervalMs) - 1);
    }
    const next = {
      ...previous,
      integration,
      status: deriveConnection({ ...previous, lastBeatAt: iso }),
      lastBeatAt: iso,
      missedBeats,
      detail: {
        habitat: snap.habitat,
        missionCount: snap.missions.length,
        active: snap.activeMissions.length,
        completed: snap.completedWork.length,
        failures: snap.failures.length,
        approvals: snap.approvals.length,
        missionsAvailable: snap.missionsAvailable
      }
    };
    const saved = await repository.saveState(next);
    return { ok: true, at: iso, queued: queued.length, events: queued, state: saved, connection: deriveConnection(saved) };
  }

  async function deliver({ limit = maxEventsPerBeat } = {}) {
    const at = now();
    const pending = await repository.pendingEvents({ integration, limit });
    if (!notifier) return { ok: true, attempted: 0, delivered: 0, failed: 0, dead: 0, pending: pending.length, code: "notifier_not_configured" };
    let delivered = 0;
    let failed = 0;
    let dead = 0;
    const state = await currentState();
    for (const event of pending) {
      let result;
      try {
        result = await notifier.send({
          trigger: TRIGGER_MESSAGE,
          event: { id: event.id, kind: event.kind, payload: event.payload, createdAt: event.createdAt },
          integration
        });
      } catch (error) {
        result = { ok: false, error: String(error?.message || error) };
      }
      if (result?.ok) {
        await repository.markDelivered(event.id, { at: new Date(now()).toISOString() });
        await repository.recordDelivery({ eventId: event.id, channel: notifier.channel || "webhook", status: "delivered", detail: { status: result.status || 200 } });
        delivered += 1;
        state.lastDeliveryAt = new Date(now()).toISOString();
        state.failures = 0;
      } else {
        const attempt = (event.attempts || 0) + 1;
        if (attempt >= maxAttempts) {
          await repository.markDead(event.id, { at: new Date(now()).toISOString(), error: result?.error || "delivery_failed" });
          await repository.recordDelivery({ eventId: event.id, channel: notifier.channel || "webhook", status: "dead", detail: { error: result?.error || "delivery_failed", attempts: attempt } });
          dead += 1;
        } else {
          await repository.markAttempt(event.id, { at: new Date(now()).toISOString(), error: result?.error || "delivery_failed" });
          await repository.recordDelivery({ eventId: event.id, channel: notifier.channel || "webhook", status: "failed", detail: { error: result?.error || "delivery_failed", attempts: attempt } });
          failed += 1;
        }
        state.failures = (state.failures || 0) + 1;
      }
    }
    await repository.saveState(state);
    return { ok: true, attempted: pending.length, delivered, failed, dead, pending: Math.max(0, pending.length - delivered - dead) };
  }

  /**
   * Build the reconnect payload. This is the guaranteed delivery path: an authorized integration asks,
   * and receives the trigger plus the current state. Reading it records that the integration was seen.
   */
  async function reconnect({ clientId = null } = {}) {
    const at = now();
    const state = await currentState();
    const snap = await snapshot();
    const pending = await repository.pendingEvents({ integration, limit: maxEventsPerBeat });
    const recent = (await repository.listEvents({ integration, limit: 20 })).filter(event => event.status !== "acknowledged");
    const since = state.lastSeenAt;
    const changes = recent.filter(event => !since || Date.parse(event.updatedAt) > Date.parse(since));
    const next = {
      ...state,
      integration,
      status: "connected",
      lastSeenAt: new Date(at).toISOString(),
      lastAckAt: state.lastAckAt,
      missedBeats: 0,
      failures: 0,
      detail: { ...(state.detail || {}), lastClientId: clientId }
    };
    await repository.saveState(next);
    return {
      ok: true,
      trigger: TRIGGER_MESSAGE,
      generatedAt: new Date(at).toISOString(),
      connection: deriveConnection(next),
      heartbeat: await status(),
      habitat: snap.habitat,
      components: snap.components,
      missions: {
        available: snap.missionsAvailable,
        active: snap.activeMissions,
        completed: snap.completedWork,
        failures: snap.failures,
        approvals: snap.approvals,
        pendingTasks: snap.pendingTasks
      },
      changes: { since, events: changes.map(event => ({ id: event.id, kind: event.kind, payload: event.payload, status: event.status, at: event.updatedAt })) },
      queued: pending.map(event => ({ id: event.id, kind: event.kind, payload: event.payload, attempts: event.attempts })),
      delivery: { received: true, executed: false, verified: false }
    };
  }

  async function acknowledge(ids = []) {
    const at = new Date(now()).toISOString();
    const clean = (Array.isArray(ids) ? ids : []).map(String).slice(0, 100);
    const result = await repository.markAcknowledged(clean, { at });
    const state = await currentState();
    await repository.saveState({ ...state, integration, status: "connected", lastAckAt: at, lastSeenAt: state.lastSeenAt || at, failures: 0 });
    return { ...result, duplicate: result.acknowledged === 0 };
  }

  return Object.freeze({ status, beat, deliver, reconnect, acknowledge, snapshot, TRIGGER_MESSAGE });
}

/**
 * Best-effort webhook notifier (Standard Webhooks style signature). It is suitable for a relay that
 * can place the event into a supported ChatGPT surface (for example an MCP Events webhook receiver).
 * It cannot by itself wake an inactive conversation.
 */
export function createWebhookNotifier({ url, secret = null, channel = "webhook", fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!url) return null;
  return Object.freeze({
    channel,
    async send({ trigger, event }) {
      const body = JSON.stringify({ trigger, event });
      const id = "axh_" + randomBytes(8).toString("hex");
      const timestamp = Math.floor(Date.now() / 1000);
      const headers = { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp) };
      if (secret) {
        const signature = createHmac("sha256", secret).update(id + "." + timestamp + "." + body).digest("base64");
        headers["webhook-signature"] = "v1," + signature;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
        if (!response.ok) return { ok: false, status: response.status, error: "webhook_status_" + response.status };
        return { ok: true, status: response.status };
      } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 200) };
      } finally {
        clearTimeout(timer);
      }
    }
  });
}
