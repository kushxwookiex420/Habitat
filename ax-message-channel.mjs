import { createHash, randomBytes } from "node:crypto";

/**
 * The Ax <-> NEXUS message channel.
 *
 * This is the direct, durable, bidirectional channel between an authorised Ax client and the NEXUS
 * runtime. It is deliberately *not* a command executor: a message can only ask for an adapter that
 * appears in `allowedAdapters`, which the deployment fills with the read-only adapter allowlist.
 * Nothing in a message body can name a shell command, a URL, a device action or a new capability.
 *
 * Direction and identity are structural, not claimed:
 *   - `submit` records `from: "ax"`   because the route calling it passed the Ax credential guard.
 *   - `acknowledge`/`progress`/`complete`/`fail`/`ask` record `from: "nexus"` because only the
 *     NEXUS service credential can reach them.
 * A record's `from` field is therefore derived from the authenticated surface, never from the body.
 *
 * Delivery is at-least-once with an idempotent adapter call: a crash after the claim but before the
 * task id is stored re-runs the same message under the same deterministic task key, so the engine
 * returns the original task instead of creating a second one.
 */

export const MESSAGE_SCHEMA_VERSION = 1;

export const MESSAGE_KINDS = Object.freeze([
  "task",
  "question",
  "note",
  "answer",
  "acknowledgement",
  "progress",
  "result",
  "error",
  "approval_request"
]);

export const MESSAGE_STATES = Object.freeze([
  "queued",
  "acknowledged",
  "working",
  "awaiting_answer",
  "answered",
  "completed",
  "failed",
  "dead_letter",
  "blocked",
  "sent"
]);

export const TERMINAL_MESSAGE_STATES = Object.freeze(["completed", "failed", "dead_letter", "blocked", "answered", "sent"]);

export const MESSAGE_LIMITS = Object.freeze({
  bodyMax: 4000,
  objectiveMax: 2000,
  correlationMax: 120,
  idempotencyKeyMax: 160,
  summaryMax: 1200,
  evidenceItems: 12,
  evidenceItemMax: 800,
  timelineMax: 60,
  maxAttempts: 3,
  rateMax: 30,
  rateWindowMs: 60_000,
  drainBatch: 20,
  listedMax: 200
});

export const MESSAGE_TRANSITIONS = Object.freeze({
  queued: Object.freeze(["acknowledged", "failed", "dead_letter", "blocked"]),
  acknowledged: Object.freeze(["working", "failed", "blocked", "dead_letter"]),
  working: Object.freeze(["completed", "failed", "blocked", "dead_letter"]),
  blocked: Object.freeze(["queued", "acknowledged", "failed", "dead_letter"]),
  awaiting_answer: Object.freeze(["answered", "failed", "dead_letter"]),
  answered: Object.freeze([]),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  dead_letter: Object.freeze([]),
  sent: Object.freeze([])
});

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Removes credential-shaped strings before a message is persisted or returned. A channel that
 * carries model-authored text must not become a secret store.
 */
export function redactMessageText(value, max = MESSAGE_LIMITS.bodyMax) {
  return clean(value, max)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\bax(?:cmd|bridge|nexus)_[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/x-owner-device-token"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}/gi, "x-owner-device-token: [redacted]");
}

function messageId(idempotencyKey, from) {
  return "msg_" + createHash("sha256")
    .update("ax-message:" + String(from) + "\u0000" + String(idempotencyKey), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function newId(prefix) {
  return prefix + randomBytes(12).toString("hex");
}

function validCorrelationId(value) {
  const text = clean(value, MESSAGE_LIMITS.correlationMax);
  if (!text) return null;
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function nowIso(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : String(value);
}

export function createMessageChannel({
  repository,
  allowedAdapters = [],
  security = null,
  notifications = null,
  project = "habitat",
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  maxAttempts = MESSAGE_LIMITS.maxAttempts,
  rateMax = MESSAGE_LIMITS.rateMax,
  rateWindowMs = MESSAGE_LIMITS.rateWindowMs,
  log = console
} = {}) {
  if (!repository) throw new Error("The message channel needs a durable message repository.");
  const adapterAllowlist = new Set((Array.isArray(allowedAdapters) ? allowedAdapters : []).map(item => String(item)));
  const defaultProject = clean(project, 40).toLowerCase() || "habitat";

  /**
   * Awaitable audit. A message transition is only reported to the client after its audit entry is
   * durable, because "the exchange is visible in the audit history" is a property of the channel,
   * not a best-effort side effect. A failed audit write is logged and does not fail the transition:
   * losing one audit row must not duplicate a completed task.
   */
  async function audit(entry) {
    if (!security || typeof security.record !== "function") return;
    try {
      await security.record(entry);
    } catch (error) {
      log.error?.("AX_MESSAGE_AUDIT_FAILED", clean(error?.message || error, 160));
    }
  }

  function notify(event) {
    if (!notifications || typeof notifications.record !== "function") return;
    Promise.resolve(notifications.record(event)).catch(() => {});
  }

  function unavailable() {
    return { ok: false, code: "message_store_unavailable", error: "The message store could not be read or written." };
  }

  function timelineOf(record) {
    return Array.isArray(record.timeline) ? record.timeline.slice(-MESSAGE_LIMITS.timelineMax) : [];
  }

  function stamp(record, entry, at) {
    record.timeline = timelineOf(record).concat([{ at, ...entry }]).slice(-MESSAGE_LIMITS.timelineMax);
    record.updatedAt = at;
  }

  /**
   * Compare-and-swap mutation. `apply` receives the current record and returns
   * `{ changed, replayed }`; a concurrent writer causes a re-read instead of a lost update.
   */
  async function mutate(id, apply) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const read = await repository.getRecord(id);
      if (!read.message || !read.recordJson) return { ok: false, code: "not_found", error: "No message with that id." };
      const record = structuredClone(read.message);
      const decision = apply(record);
      if (!decision || decision.changed !== true) {
        return { ok: decision?.ok !== false, replayed: true, code: decision?.code || null, error: decision?.error || null, message: record };
      }
      const written = await repository.update(record, read.recordJson);
      if (written.ok) return { ok: true, replayed: false, message: written.message, code: decision.code || null };
      if (written.reason === "missing") return { ok: false, code: "not_found", error: "No message with that id." };
      // conflict: another writer committed first. Re-read and re-apply, which makes an
      // already-applied transition a replay rather than an error.
    }
    return { ok: false, code: "message_conflict", error: "The message changed while it was being updated; retry." };
  }

  function canMove(from, to) {
    return (MESSAGE_TRANSITIONS[from] || []).includes(to);
  }

  /**
   * Ax -> NEXUS. Idempotent: the message id is derived from the mandatory idempotency key, so a
   * retried submission returns the original message and never queues a second execution.
   */
  async function submit({
    kind = "task",
    body,
    objective = null,
    adapter = null,
    correlationId = null,
    idempotencyKey = null,
    from = "ax",
    client = "ax",
    project: requestedProject = null
  } = {}) {
    if (from !== "ax" && from !== "nexus") return { ok: false, code: "invalid_origin", error: "A message origin must be ax or nexus." };
    const chosenKind = clean(kind, 40).toLowerCase() || "task";
    if (!["task", "question", "note"].includes(chosenKind)) {
      return { ok: false, code: "invalid_kind", error: "An inbound message kind must be task, question or note." };
    }
    const text = redactMessageText(body);
    if (!text) return { ok: false, code: "invalid_body", error: "A message needs a body." };
    const healthyObjective = objective ? redactMessageText(objective, MESSAGE_LIMITS.objectiveMax) : null;
    if (chosenKind === "task") {
      if (!healthyObjective) return { ok: false, code: "invalid_objective", error: "A task message needs an objective." };
      const chosenAdapter = clean(adapter, 80);
      if (!chosenAdapter) return { ok: false, code: "adapter_required", error: "A task message must name one read-only adapter from the allowlist." };
      if (!adapterAllowlist.has(chosenAdapter)) {
        return {
          ok: false,
          code: "adapter_not_allowed",
          error: "That adapter is not on this deployment's read-only allowlist; the message was not stored.",
          allowed: [...adapterAllowlist]
        };
      }
    }
    const key = clean(idempotencyKey, MESSAGE_LIMITS.idempotencyKeyMax);
    if (!key) return { ok: false, code: "idempotency_key_required", error: "Every submission needs an idempotency key so a retry cannot execute twice." };
    const correlation = validCorrelationId(correlationId) || newId("cor_");
    if (!correlation) return { ok: false, code: "invalid_correlation_id", error: "A correlation id may contain letters, digits, dot, colon, underscore and dash only." };
    const chosenProject = clean(requestedProject || defaultProject, 40).toLowerCase() || defaultProject;

    const id = messageId(key, from);
    const existing = await repository.getRecord(id);
    if (existing.message) {
      return { ok: true, replayed: true, message: existing.message, correlationId: existing.message.correlationId };
    }

    let recent = 0;
    try {
      recent = await repository.countSince({ from, since: new Date(nowMs() - rateWindowMs).toISOString() });
    } catch (error) {
      log.error?.("AX_MESSAGE_RATE_READ_FAILED", clean(error?.message || error, 160));
      return unavailable();
    }
    if (recent >= rateMax) {
      return {
        ok: false,
        code: "rate_limited",
        error: "Too many messages in the current window; retry after " + Math.ceil(rateWindowMs / 1000) + " seconds.",
        retryAfterMs: rateWindowMs,
        limit: rateMax,
        windowMs: rateWindowMs
      };
    }

    const at = nowIso(now);
    const record = {
      id,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      correlationId: correlation,
      project: chosenProject,
      from,
      to: from === "ax" ? "nexus" : "ax",
      origin: { client: clean(client, 40) || from, role: from === "ax" ? "ax-client" : "nexus-runtime" },
      kind: chosenKind,
      status: chosenKind === "task" ? "queued" : "sent",
      objective: healthyObjective,
      adapter: chosenKind === "task" ? clean(adapter, 80) : null,
      body: text,
      taskId: null,
      runId: null,
      idempotencyKey: key,
      attempts: 0,
      maxAttempts,
      result: null,
      error: null,
      evidence: [],
      timeline: [{ at, from, to: from === "ax" ? "nexus" : "ax", type: "submitted", status: chosenKind === "task" ? "queued" : "sent", note: null }],
      createdAt: at,
      updatedAt: at,
      acknowledgedAt: null,
      completedAt: null
    };
    try {
      await repository.create(record);
    } catch (error) {
      // A concurrent submit with the same key can win the insert; the primary key is the arbiter.
      const raced = await repository.getRecord(id);
      if (raced.message) return { ok: true, replayed: true, message: raced.message, correlationId: raced.message.correlationId };
      log.error?.("AX_MESSAGE_CREATE_FAILED", clean(error?.message || error, 160));
      return unavailable();
    }
    await audit({
      category: "ax.message.submitted",
      severity: "info",
      outcome: "allowed",
      actor: "ax",
      correlationId: correlation,
      summary: "Ax submitted a " + chosenKind + " message to NEXUS",
      evidence: JSON.stringify({ messageId: id, adapter: record.adapter, project: chosenProject })
    });
    return { ok: true, replayed: false, message: record, correlationId: correlation };
  }

  /** NEXUS -> Ax acknowledgement. Only the NEXUS surface may call this. */
  async function acknowledge({ id, executor = "nexus", note = null } = {}) {
    const outcome = await mutate(id, record => {
      if (record.from !== "ax") return { changed: false, ok: false, code: "invalid_direction", error: "Only an Ax submission can be acknowledged." };
      if (record.status === "acknowledged" || record.status === "working" || record.status === "completed") return { changed: false };
      if (!canMove(record.status, "acknowledged")) {
        return { changed: false, ok: false, code: "invalid_transition", error: "A " + record.status + " message cannot be acknowledged." };
      }
      const at = nowIso(now);
      record.status = "acknowledged";
      record.acknowledgedAt = at;
      record.acknowledgedBy = clean(executor, 80) || "nexus";
      stamp(record, { from: "nexus", to: "ax", type: "acknowledgement", status: "acknowledged", note: note ? redactMessageText(note, 500) : null }, at);
      return { changed: true };
    });
    if (outcome.ok && !outcome.replayed) {
      await audit({
        category: "ax.message.acknowledged",
        severity: "info",
        outcome: "allowed",
        actor: "nexus",
        correlationId: outcome.message?.correlationId || null,
        summary: "NEXUS acknowledged message " + clean(id, 80),
        evidence: JSON.stringify({ executor: clean(executor, 80) })
      });
    }
    return outcome;
  }

  /** NEXUS -> Ax progress. Moves a claimed message into `working`. */
  async function progress({ id, note = null, percent = null } = {}) {
    const boundedPercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Math.round(Number(percent)))) : null;
    return mutate(id, record => {
      if (record.from !== "ax") return { changed: false, ok: false, code: "invalid_direction", error: "Progress belongs to an Ax submission." };
      if (["completed", "failed", "dead_letter", "blocked"].includes(record.status)) {
        return { changed: false, ok: false, code: "invalid_transition", error: "This message is already " + record.status + "." };
      }
      if (record.status === "acknowledged" && !canMove("acknowledged", "working")) {
        return { changed: false, ok: false, code: "invalid_transition", error: "The message cannot move to working." };
      }
      const at = nowIso(now);
      record.status = "working";
      if (boundedPercent !== null) record.percent = boundedPercent;
      stamp(record, { from: "nexus", to: "ax", type: "progress", status: "working", note: note ? redactMessageText(note, 500) : null, percent: boundedPercent }, at);
      return { changed: true };
    });
  }

  /**
   * NEXUS -> Ax terminal result. Evidence is mandatory for a completion: a message may not report
   * success without something an operator can inspect.
   */
  async function complete({ id, summary = null, evidence = [], taskId = null, runId = null } = {}) {
    const items = (Array.isArray(evidence) ? evidence : [])
      .map(item => redactMessageText(typeof item === "string" ? item : item?.summary ?? item?.detail ?? "", MESSAGE_LIMITS.evidenceItemMax))
      .filter(Boolean)
      .slice(0, MESSAGE_LIMITS.evidenceItems);
    if (!items.length) {
      return { ok: false, code: "evidence_required", error: "A completion needs at least one evidence item." };
    }
    const outcome = await mutate(id, record => {
      if (record.from !== "ax") return { changed: false, ok: false, code: "invalid_direction", error: "A completion belongs to an Ax submission." };
      if (record.status === "completed") return { changed: false };
      if (!["queued", "acknowledged", "working"].includes(record.status)) {
        return { changed: false, ok: false, code: "invalid_transition", error: "A " + record.status + " message cannot be completed." };
      }
      const at = nowIso(now);
      record.status = "completed";
      record.completedAt = at;
      record.result = {
        summary: summary ? redactMessageText(summary, MESSAGE_LIMITS.summaryMax) : items[0],
        evidence: items
      };
      record.evidence = items;
      if (taskId) record.taskId = clean(taskId, 160);
      if (runId) record.runId = clean(runId, 160);
      stamp(record, { from: "nexus", to: "ax", type: "result", status: "completed", note: record.result.summary }, at);
      return { changed: true };
    });
    if (outcome.ok && !outcome.replayed) {
      await audit({
        category: "ax.message.completed",
        severity: "info",
        outcome: "allowed",
        actor: "nexus",
        correlationId: outcome.message?.correlationId || null,
        summary: "NEXUS completed message " + clean(id, 80),
        evidence: JSON.stringify({ taskId: outcome.message?.taskId || null, items: items.length })
      });
      notify({
        type: "ax.message.completed",
        severity: "info",
        title: "NEXUS completed an Ax message",
        body: (outcome.message?.result?.summary || "").slice(0, 300),
        dedupeKey: "ax-message-complete:" + clean(id, 80)
      });
    }
    return outcome;
  }

  /** NEXUS -> Ax failure. A retryable failure returns the message to the queue until the limit. */
  async function fail({ id, code = "message_failed", message = null, retryable = false } = {}) {
    const outcome = await mutate(id, record => {
      if (record.from !== "ax") return { changed: false, ok: false, code: "invalid_direction", error: "A failure belongs to an Ax submission." };
      if (TERMINAL_MESSAGE_STATES.includes(record.status)) return { changed: false };
      const at = nowIso(now);
      const attempts = Number(record.attempts || 0) + 1;
      record.attempts = attempts;
      record.error = { code: clean(code, 80) || "message_failed", message: message ? redactMessageText(message, 800) : null };
      const canRetry = retryable === true && attempts < Number(record.maxAttempts || maxAttempts);
      record.status = canRetry ? "queued" : attempts >= Number(record.maxAttempts || maxAttempts) ? "dead_letter" : "failed";
      stamp(record, {
        from: "nexus",
        to: "ax",
        type: canRetry ? "retry" : "error",
        status: record.status,
        note: record.error.message,
        attempt: attempts
      }, at);
      return { changed: true };
    });
    if (outcome.ok && !outcome.replayed) {
      await audit({
        category: outcome.message?.status === "dead_letter" ? "ax.message.dead_letter" : "ax.message.failed",
        severity: outcome.message?.status === "dead_letter" ? "high" : "medium",
        outcome: "failed",
        actor: "nexus",
        correlationId: outcome.message?.correlationId || null,
        summary: "Message " + clean(id, 80) + " is " + outcome.message?.status,
        evidence: JSON.stringify(outcome.message?.error || {})
      });
      notify({
        type: outcome.message?.status === "dead_letter" ? "ax.message.dead_letter" : "ax.message.failed",
        severity: outcome.message?.status === "dead_letter" ? "high" : "warning",
        title: "An Ax message " + (outcome.message?.status === "dead_letter" ? "was dead-lettered" : "failed"),
        body: (outcome.message?.error?.message || outcome.message?.error?.code || "").slice(0, 300),
        dedupeKey: "ax-message-fail:" + clean(id, 80) + ":" + String(outcome.message?.attempts || 0)
      });
    }
    return outcome;
  }

  /**
   * NEXUS -> Ax question or approval request. This is how the runtime returns something that
   * genuinely needs a decision instead of guessing or silently stopping.
   */
  async function ask({
    correlationId = null,
    question,
    options = [],
    objectiveId = null,
    requiresDecision = true,
    kind = "question",
    from = "nexus",
    client = "nexus-runtime"
  } = {}) {
    const chosenKind = clean(kind, 40) || "question";
    if (!["question", "approval_request"].includes(chosenKind)) {
      return { ok: false, code: "invalid_kind", error: "An outbound ask must be a question or an approval request." };
    }
    const text = redactMessageText(question, MESSAGE_LIMITS.bodyMax);
    if (!text) return { ok: false, code: "invalid_body", error: "A question needs a body." };
    const correlation = validCorrelationId(correlationId);
    if (!correlation) return { ok: false, code: "invalid_correlation_id", error: "A question must carry the correlation id it belongs to." };
    const boundedOptions = (Array.isArray(options) ? options : [])
      .map(option => redactMessageText(option, 200))
      .filter(Boolean)
      .slice(0, 8);
    const at = nowIso(now);
    const record = {
      id: newId("msg_"),
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      correlationId: correlation,
      project: defaultProject,
      from,
      to: "ax",
      origin: { client, role: "nexus-runtime" },
      kind: chosenKind,
      status: "awaiting_answer",
      objective: objectiveId ? clean(objectiveId, 160) : null,
      adapter: null,
      body: text,
      options: boundedOptions,
      requiresDecision: requiresDecision !== false,
      taskId: null,
      runId: null,
      idempotencyKey: null,
      attempts: 0,
      maxAttempts,
      result: null,
      error: null,
      evidence: [],
      answer: null,
      timeline: [{ at, from, to: "ax", type: chosenKind, status: "awaiting_answer", note: null }],
      createdAt: at,
      updatedAt: at,
      acknowledgedAt: null,
      completedAt: null
    };
    try {
      await repository.create(record);
    } catch (error) {
      log.error?.("AX_MESSAGE_ASK_FAILED", clean(error?.message || error, 160));
      return unavailable();
    }
    await audit({
      category: "ax.message.question",
      severity: chosenKind === "approval_request" ? "medium" : "info",
      outcome: "allowed",
      actor: "nexus",
      correlationId: correlation,
      summary: "NEXUS asked Ax: " + text.slice(0, 120),
      evidence: JSON.stringify({ messageId: record.id, options: boundedOptions.length })
    });
    notify({
      type: "ax.message.question",
      severity: chosenKind === "approval_request" ? "high" : "info",
      title: chosenKind === "approval_request" ? "NEXUS needs owner approval" : "NEXUS asked Ax a question",
      body: text.slice(0, 300),
      dedupeKey: "ax-message-ask:" + record.id
    });
    return { ok: true, message: record, correlationId: correlation };
  }

  /** Ax -> NEXUS answer to a question or approval request. */
  async function answer({ id, answer: text, by = "ax" } = {}) {
    const body = redactMessageText(text);
    if (!body) return { ok: false, code: "invalid_body", error: "An answer needs a body." };
    const outcome = await mutate(id, record => {
      if (record.from !== "nexus") return { changed: false, ok: false, code: "invalid_direction", error: "Only a NEXUS question can be answered." };
      if (record.status === "answered") return { changed: false };
      if (record.status !== "awaiting_answer") {
        return { changed: false, ok: false, code: "invalid_transition", error: "This message is " + record.status + " and accepts no answer." };
      }
      const at = nowIso(now);
      record.status = "answered";
      record.answer = { body, by: clean(by, 80) || "ax", at };
      stamp(record, { from: "ax", to: "nexus", type: "answer", status: "answered", note: body.slice(0, 500) }, at);
      return { changed: true };
    });
    if (outcome.ok && !outcome.replayed) {
      await audit({
        category: "ax.message.answered",
        severity: "info",
        outcome: "allowed",
        actor: "ax",
        correlationId: outcome.message?.correlationId || null,
        summary: "Ax answered message " + clean(id, 80),
        evidence: JSON.stringify({ by: clean(by, 80) })
      });
    }
    return outcome;
  }

  /** NEXUS -> Ax informational message that needs no reply. */
  async function notifyAx({ correlationId = null, body, kind = "note", metadata = null } = {}) {
    const text = redactMessageText(body, MESSAGE_LIMITS.bodyMax);
    if (!text) return { ok: false, code: "invalid_body", error: "A notification needs a body." };
    const correlation = validCorrelationId(correlationId) || newId("cor_");
    if (!correlation) return { ok: false, code: "invalid_correlation_id", error: "Invalid correlation id." };
    const at = nowIso(now);
    const record = {
      id: newId("msg_"),
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      correlationId: correlation,
      project: defaultProject,
      from: "nexus",
      to: "ax",
      origin: { client: "nexus-runtime", role: "nexus-runtime" },
      kind: clean(kind, 40) || "note",
      status: "sent",
      objective: null,
      adapter: null,
      body: text,
      metadata: metadata && typeof metadata === "object" ? structuredClone(metadata) : null,
      taskId: null,
      runId: null,
      idempotencyKey: null,
      attempts: 0,
      maxAttempts,
      result: null,
      error: null,
      evidence: [],
      timeline: [{ at, from: "nexus", to: "ax", type: "note", status: "sent", note: null }],
      createdAt: at,
      updatedAt: at,
      acknowledgedAt: null,
      completedAt: null
    };
    try {
      await repository.create(record);
    } catch (error) {
      log.error?.("AX_MESSAGE_NOTIFY_FAILED", clean(error?.message || error, 160));
      return unavailable();
    }
    return { ok: true, message: record, correlationId: correlation };
  }

  async function get(id) {
    const read = await repository.getRecord(id);
    return read.message || null;
  }

  /** The whole exchange for one correlation id, oldest first. This is the retrieval path for Ax. */
  async function thread({ correlationId, limit = 100 } = {}) {
    const correlation = validCorrelationId(correlationId);
    if (!correlation) return { ok: false, code: "invalid_correlation_id", error: "A thread needs a valid correlation id." };
    const messages = await repository.list({ correlationId: correlation, limit, order: "oldest" });
    return {
      ok: true,
      correlationId: correlation,
      count: messages.length,
      messages,
      // Explicit summary so a client can answer "did it finish?" without replaying the thread.
      terminal: messages.filter(item => TERMINAL_MESSAGE_STATES.includes(item.status)).map(item => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        result: item.result,
        answer: item.answer,
        error: item.error
      })),
      awaitingDecision: messages.filter(item => item.status === "awaiting_answer").map(item => ({
        id: item.id,
        body: item.body,
        options: item.options || [],
        kind: item.kind
      }))
    };
  }

  async function list({ status = null, correlationId = null, from = null, project = null, limit = 50, order = "newest" } = {}) {
    return repository.list({ status, correlationId, from, project, limit, order });
  }

  async function stats() {
    const rows = await repository.list({ limit: MESSAGE_LIMITS.listedMax });
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    return {
      ok: true,
      total: rows.length,
      byStatus,
      awaitingDecision: rows.filter(row => row.status === "awaiting_answer").length,
      deadLetters: rows.filter(row => row.status === "dead_letter").length
    };
  }

  /**
   * Advance the channel without owner involvement.
   *
   * `execute(message)` must return `{ ok:true, taskId }` after submitting the work, or
   * `{ ok:false, code, message, retryable }`. `check(message)` must return the current task state:
   * `{ status:"working" }`, `{ status:"done", result:{summary,evidence} }` or
   * `{ status:"failed", error, retryable }`.
   *
   * Both callbacks are injected so the channel never owns an executor and cannot be used to run an
   * arbitrary command: it can only ask a pre-existing, allowlisted read-only adapter to run.
   */
  async function drain({ execute, check = null, limit = MESSAGE_LIMITS.drainBatch } = {}) {
    if (typeof execute !== "function") return { ok: false, code: "executor_required", error: "A drain needs an execute callback." };
    const report = { ok: true, examined: 0, submitted: 0, completed: 0, failed: 0, deadLettered: 0, stillWorking: 0, errors: [] };
    let candidates = [];
    try {
      const queued = await repository.list({ status: "queued", from: "ax", limit, order: "oldest" });
      const acknowledged = await repository.list({ status: "acknowledged", from: "ax", limit, order: "oldest" });
      const working = await repository.list({ status: "working", from: "ax", limit, order: "oldest" });
      candidates = [...queued, ...acknowledged, ...working];
    } catch (error) {
      log.error?.("AX_MESSAGE_DRAIN_LIST_FAILED", clean(error?.message || error, 160));
      return { ok: false, code: "message_store_unavailable", error: "The message queue could not be read." };
    }

    for (const message of candidates.slice(0, limit)) {
      report.examined += 1;
      try {
        if (message.status === "working" && message.taskId && typeof check === "function") {
          const state = await check(message);
          if (!state || state.status === "working") { report.stillWorking += 1; continue; }
          if (state.status === "done") {
            const done = await complete({
              id: message.id,
              summary: state.result?.summary || "adapter completed",
              evidence: state.result?.evidence || [],
              taskId: message.taskId
            });
            if (done.ok) report.completed += 1; else report.errors.push({ id: message.id, code: done.code });
            continue;
          }
          const failed = await fail({ id: message.id, code: state.error?.code || "task_failed", message: state.error?.message || null, retryable: state.retryable === true });
          if (failed.message?.status === "dead_letter") report.deadLettered += 1; else report.failed += 1;
          continue;
        }
        if (message.status === "working" && !message.taskId) {
          // A crash between claiming and submitting. Fall through: submit idempotently.
        }
        if (message.status === "queued") {
          const ack = await acknowledge({ id: message.id, executor: "nexus-drain" });
          if (ack.ok === false) { report.errors.push({ id: message.id, code: ack.code }); continue; }
        }
        const outcome = await execute(message);
        if (outcome?.ok === true && outcome.taskId) {
          const stamped = await mutate(message.id, record => {
            if (["completed", "failed", "dead_letter"].includes(record.status)) return { changed: false };
            const at = nowIso(now);
            record.status = "working";
            record.taskId = clean(outcome.taskId, 160);
            stamp(record, { from: "nexus", to: "ax", type: "dispatched", status: "working", note: "task " + record.taskId }, at);
            return { changed: true };
          });
          if (stamped.ok) report.submitted += 1;
          else report.errors.push({ id: message.id, code: stamped.code });
        } else {
          const failed = await fail({
            id: message.id,
            code: outcome?.code || "dispatch_failed",
            message: outcome?.message || outcome?.error || null,
            retryable: outcome?.retryable !== false
          });
          if (failed.message?.status === "dead_letter") report.deadLettered += 1; else report.failed += 1;
        }
      } catch (error) {
        log.error?.("AX_MESSAGE_DRAIN_ITEM_FAILED", clean(error?.message || error, 160));
        report.errors.push({ id: message.id, code: "drain_error" });
      }
    }
    return report;
  }

  return Object.freeze({
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    limits: MESSAGE_LIMITS,
    states: MESSAGE_STATES,
    kinds: MESSAGE_KINDS,
    allowedAdapters: [...adapterAllowlist],
    submit,
    acknowledge,
    progress,
    complete,
    fail,
    ask,
    answer,
    notifyAx,
    get,
    thread,
    list,
    stats,
    drain
  });
}
