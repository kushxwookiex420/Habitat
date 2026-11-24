/**
 * Terminal-failure escalation.
 *
 * When Nexus gives up on a task, the failure is already durable on the task row. That is not enough
 * for Ax to act on it: nothing is pushed, so discovery depends on somebody polling. This module turns
 * a terminal failure into one durable message on Ax's own message channel, with the details Ax needs
 * to triage it, and with a deterministic idempotency key so a retried escalation can never produce a
 * second message.
 *
 * Two rules shape the design:
 *   - escalation is best effort and must never change the task outcome. The task already failed;
 *     a broken message sink is logged, not thrown.
 *   - duplicates are prevented by the channel's own idempotency, not by remembering state here.
 *     A process restart, a lease replay or a double call all collapse onto the same message id.
 */

export const FAILURE_ESCALATION_KIND = "note";
export const FAILURE_ESCALATION_PREFIX = "nexus-failure";
/** Codes the channel uses for a transient condition: worth retrying inside this call. */
export const RETRYABLE_ESCALATION_CODES = Object.freeze([
  "message_store_unavailable",
  "message_conflict",
  "rate_limited",
  "channel_error"
]);

const BODY_MAX = 1800;

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * One key per (task, attempt). A failed task that the owner retries and that fails again is a new
 * failure and must be reported again; the same failure reported twice must not be.
 */
export function failureEscalationKey({ taskId, attempts = 0 } = {}) {
  const id = clean(taskId, 120);
  if (!id) return null;
  const count = Number.isInteger(Number(attempts)) && Number(attempts) >= 0 ? Number(attempts) : 0;
  return FAILURE_ESCALATION_PREFIX + ":" + id + ":" + count;
}

/** The message Ax reads. Everything here is already owner-visible task metadata. */
export function failureEscalationBody({ taskId, objective = null, error = "", attempts = 0, at = null, status = "failed" } = {}) {
  const lines = [
    "NEXUS EXECUTION FAILURE",
    "Task: " + (clean(taskId, 120) || "unknown"),
    "Status: " + clean(status, 40),
    "Attempts: " + (Number.isInteger(Number(attempts)) ? Number(attempts) : 0),
    "Failed at: " + (clean(at, 40) || "unknown"),
    "Reason: " + (clean(error, 600) || "no reason recorded")
  ];
  if (objective) lines.push("Objective: " + clean(objective, 600));
  lines.push("Owner action: review, then retry or cancel the task through the Ax command surface.");
  return lines.join("\n").slice(0, BODY_MAX);
}

function permanentRefusal(outcome) {
  const code = String(outcome?.code || "");
  if (!code) return false;
  return !RETRYABLE_ESCALATION_CODES.includes(code);
}

/**
 * Build the escalation function handed to the Nexus worker.
 *
 * `channel` may be null (no message store configured); in that case escalation reports
 * `message_store_unavailable` and the worker carries on.
 */
export function createFailureEscalator({
  channel = null,
  retries = 2,
  retryDelayMs = 200,
  now = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console
} = {}) {
  const attempts = Math.max(0, Math.min(5, Number(retries) || 0));

  return async function escalate(event = {}) {
    const key = failureEscalationKey(event);
    if (!key) return { ok: false, code: "invalid_task", delivered: false };
    if (!channel || typeof channel.submit !== "function") {
      log.warn?.("NEXUS_ESCALATION: no message channel; failure was recorded on the task only");
      return { ok: false, code: "message_store_unavailable", delivered: false };
    }

    const payload = {
      kind: FAILURE_ESCALATION_KIND,
      body: failureEscalationBody({ ...event, at: event.at || now() }),
      from: "nexus",
      client: "nexus-worker",
      idempotencyKey: key,
      correlationId: event.taskId ? "task:" + clean(event.taskId, 100) : null
    };

    let last = null;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const outcome = await channel.submit(payload);
        if (outcome?.ok) {
          return {
            ok: true,
            delivered: outcome.replayed !== true,
            replayed: outcome.replayed === true,
            idempotencyKey: key,
            messageId: outcome.message?.id || null,
            attempts: attempt + 1
          };
        }
        last = outcome;
        if (permanentRefusal(outcome)) {
          log.warn?.("NEXUS_ESCALATION: refused (" + String(outcome?.code || "unknown") + ")");
          return { ok: false, code: outcome?.code || "refused", delivered: false, attempts: attempt + 1 };
        }
      } catch (error) {
        // A throwing sink is the same class of problem as an unavailable store: retry, then give up
        // without touching the task outcome.
        last = { ok: false, code: "channel_error", error: String(error?.message || error) };
      }
      if (attempt < attempts) {
        try {
          await sleep(retryDelayMs * (attempt + 1));
        } catch {
          // A sleep interrupted during shutdown is not a delivery failure worth retrying.
          break;
        }
      }
    }

    log.warn?.("NEXUS_ESCALATION: not delivered (" + String(last?.code || "unknown") + ")");
    return { ok: false, code: last?.code || "not_delivered", delivered: false, attempts: attempts + 1 };
  };
}
