import { createHash } from "node:crypto";

/**
 * Ax operational notifications.
 *
 * A notification is a durable *event record*, not a promise that a phone buzzed. The only delivery
 * channel implemented here is `inbox`: the event is written to D1 and surfaces through
 * `GET /ax/command/notifications`. There is no push provider, no SMS and no email integration, so
 * nothing may report those as working.
 *
 * Properties that matter:
 *   - Recording is idempotent. The id is derived from the dedupe key, so a retried finalize or a
 *     repeated reconciliation cannot create a second event for the same fact.
 *   - External delivery is retry-safe and bounded. Attempts are counted in the row, a delivery that
 *     fails stays `pending` until `maxAttempts`, then becomes `failed` with the last error. There is
 *     no unbounded retry loop and no in-memory queue to lose.
 *   - Errors are truncated and redacted; a notification body never carries a credential.
 */

export const NOTIFICATION_CHANNELS = Object.freeze(["inbox", "external"]);

export const NOTIFICATION_STATUSES = Object.freeze(["pending", "recorded", "delivered", "failed", "acknowledged"]);

export const NOTIFICATION_TYPES = Object.freeze([
  "run.completed",
  "run.failed",
  "run.budget_exceeded",
  "run.needs_approval",
  "run.recovery",
  "task.completed",
  "task.failed",
  "task.approval_required",
  "system.recovery"
]);

export const NOTIFICATION_LIMITS = Object.freeze({
  titleMax: 120,
  bodyMax: 600,
  maxAttempts: 5,
  retryBackoffMs: 60_000,
  listMax: 100
});

const TYPE_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function redact(value) {
  return clean(value, 300)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted]");
}

export function notificationId(dedupeKey) {
  return "ntf_" + createHash("sha256").update(String(dedupeKey), "utf8").digest("hex").slice(0, 32);
}

/** Validate and normalize one event. A missing dedupe key is derived from type + reference. */
export function normalizeNotification(input = {}, { now = new Date().toISOString() } = {}) {
  const type = clean(input.type, 64);
  if (!TYPE_PATTERN.test(type)) return { ok: false, code: "invalid_notification_type" };
  const severity = ["info", "warning", "critical"].includes(input.severity) ? input.severity : "info";
  const channel = NOTIFICATION_CHANNELS.includes(input.channel) ? input.channel : "inbox";
  const runId = clean(input.runId, 120) || null;
  const taskId = clean(input.taskId, 120) || null;
  const dedupeKey =
    clean(input.dedupeKey, 200) || type + ":" + (runId || taskId || clean(input.ref, 120) || "global");
  const title = clean(input.title, NOTIFICATION_LIMITS.titleMax) || type;
  const body = redact(input.body);
  return {
    ok: true,
    notification: {
      id: notificationId(dedupeKey),
      project: clean(input.project, 64).toLowerCase() || null,
      type,
      severity,
      title,
      body,
      runId,
      taskId,
      channel,
      dedupeKey,
      status: channel === "external" ? "pending" : "recorded",
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: channel === "inbox" ? now : null,
      acknowledgedAt: null
    }
  };
}

/**
 * The service. `repository` is durable storage; without it every method answers `not_configured`
 * rather than pretending an event was kept.
 */
export function createNotificationService({ repository = null, project = "habitat", log = console, now = () => new Date().toISOString() } = {}) {
  const projectId = clean(project, 64).toLowerCase();

  async function record(input = {}) {
    if (!repository) return { ok: false, code: "notifications_not_configured" };
    const normalized = normalizeNotification({ project: projectId, ...input }, { now: now() });
    if (!normalized.ok) return normalized;
    try {
      const outcome = await repository.create(normalized.notification);
      return { ok: true, created: Boolean(outcome?.created), notification: outcome?.notification || normalized.notification };
    } catch (error) {
      log.error?.("AX_NOTIFICATION_RECORD_FAILED", redact(error?.message || error));
      return { ok: false, code: "notification_store_unavailable" };
    }
  }

  async function list({ status = null, limit = 50 } = {}) {
    if (!repository) return { ok: false, code: "notifications_not_configured", notifications: [] };
    try {
      const notifications = await repository.list({ project: projectId, status, limit });
      return { ok: true, count: notifications.length, notifications };
    } catch (error) {
      log.error?.("AX_NOTIFICATION_LIST_FAILED", redact(error?.message || error));
      return { ok: false, code: "notification_store_unavailable", notifications: [] };
    }
  }

  async function acknowledge({ id, by }) {
    if (!repository) return { ok: false, code: "notifications_not_configured" };
    if (!id) return { ok: false, code: "invalid_notification_id" };
    try {
      const outcome = await repository.acknowledge({ id: String(id), by: redact(by) || "owner", now: now() });
      if (!outcome?.ok) return { ok: false, code: outcome?.code || "notification_not_found" };
      return { ok: true, notification: outcome.notification };
    } catch (error) {
      log.error?.("AX_NOTIFICATION_ACK_FAILED", redact(error?.message || error));
      return { ok: false, code: "notification_store_unavailable" };
    }
  }

  /**
   * Deliver pending external notifications with an injected transport.
   *
   * No transport is configured in this deployment, so the default is an honest no-op. With a
   * transport, attempts are bounded per row and a failure keeps the row pending with backoff until
   * `maxAttempts`, after which it is failed — never retried forever.
   */
  async function deliverPending({
    deliver = null,
    limit = 20,
    maxAttempts = NOTIFICATION_LIMITS.maxAttempts,
    now: at = now()
  } = {}) {
    if (!repository) return { ok: false, code: "notifications_not_configured", delivered: 0, failed: 0, skipped: 0 };
    if (typeof deliver !== "function") {
      return { ok: true, delivered: 0, failed: 0, skipped: 0, reason: "no_external_transport_configured" };
    }
    let pending;
    try {
      pending = await repository.list({ project: projectId, status: "pending", channel: "external", limit });
    } catch (error) {
      log.error?.("AX_NOTIFICATION_DELIVER_READ_FAILED", redact(error?.message || error));
      return { ok: false, code: "notification_store_unavailable", delivered: 0, failed: 0, skipped: 0 };
    }
    let delivered = 0;
    let failed = 0;
    for (const notification of pending) {
      const attempt = Number(notification.attempts || 0) + 1;
      try {
        await deliver(notification);
        await repository.markDelivered({ id: notification.id, attempts: attempt, at: at });
        delivered += 1;
      } catch (error) {
        const exhausted = attempt >= maxAttempts;
        await repository.markFailed({
          id: notification.id,
          attempts: attempt,
          error: redact(error?.message || error),
          exhausted,
          at: at
        });
        if (exhausted) failed += 1;
      }
    }
    return { ok: true, delivered, failed, skipped: pending.length - delivered - failed };
  }

  async function stats() {
    if (!repository || typeof repository.stats !== "function") {
      return { ok: false, code: "notifications_not_configured", byStatus: {}, total: 0 };
    }
    try {
      return { ok: true, ...(await repository.stats({ project: projectId })) };
    } catch (error) {
      log.error?.("AX_NOTIFICATION_STATS_FAILED", redact(error?.message || error));
      return { ok: false, code: "notification_store_unavailable", byStatus: {}, total: 0 };
    }
  }

  return Object.freeze({ record, list, acknowledge, deliverPending, stats });
}

/**
 * Map a settled Ax run to the events the control center should show. Pure, so it can be tested
 * without a store and reused by any caller.
 */
export function notificationEventsForRun(run) {
  if (!run || !run.id) return [];
  const base = { runId: run.id, project: run.project || "habitat" };
  const events = [];
  if (run.status === "completed" && run.verified) {
    events.push({
      ...base,
      type: "run.completed",
      severity: "info",
      title: "Mission completed and verified",
      body: 'Run ' + run.id + " completed: " + clean(run.objective, 200) + ". Evidence items: " + (run.evidence?.length || 0) + "."
    });
  } else if (run.status === "failed") {
    events.push({
      ...base,
      type: "run.failed",
      severity: "critical",
      title: "Mission failed",
      body: 'Run ' + run.id + " failed: " + (run.error || "no verified completion") + "."
    });
  } else if (run.status === "budget_exceeded") {
    events.push({
      ...base,
      type: "run.budget_exceeded",
      severity: "warning",
      title: "Mission stopped by its budget",
      body: 'Run ' + run.id + " spent " + Number(run.costUsd || 0) + " USD and stopped: " + (run.error || "budget exceeded") + "."
    });
  } else if (run.status === "needs_approval") {
    events.push({
      ...base,
      type: "run.needs_approval",
      severity: "warning",
      title: "Owner approval required",
      body: 'Run ' + run.id + " is waiting for the owner to approve a step."
    });
  }
  if (Number(run.recoveries || 0) > 0) {
    events.push({
      ...base,
      type: "run.recovery",
      severity: "warning",
      title: "Mission recovered",
      body: 'Run ' + run.id + " was settled by reconciliation after its driver stopped."
    });
  }
  for (const event of events) event.dedupeKey = "run:" + run.id + ":" + event.type;
  return events;
}
