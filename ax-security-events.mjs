import { createHash, randomBytes } from "node:crypto";

/**
 * Append-only security audit log.
 *
 * This is deliberately separate from recovery incidents. An incident answers "what is broken and
 * what did we try"; a security event answers "who attempted what, with which credential, and what
 * happened". Nothing in this module exposes an update or delete function, and no HTTP route can
 * rewrite an event.
 *
 * Integrity is a hash chain: each event commits to the previous event's hash. That detects an edit,
 * a deletion or a reorder when the chain is verified against a head someone already observed. It is
 * *not* cryptographic tamper-proofing: an actor who can rewrite the entire table (and every head
 * copy) can rebuild the chain. The report says exactly this.
 */

export const SECURITY_CATEGORIES = Object.freeze([
  "auth.failure",
  "auth.success",
  "owner.authorization",
  "owner.rejection",
  "device.pairing",
  "device.revocation",
  "approval.created",
  "approval.replayed",
  "command.unauthorized",
  "command.sensitive",
  "agent.permission_violation",
  "secret.detected",
  "budget.exhausted",
  "sandbox.refusal",
  "recovery.suspicious",
  "sensitive.action",
  "credential.rotation",
  "route.denied",
  // Mission 14: the Ax <-> NEXUS message channel is auditable end to end.
  "ax.message.submitted",
  "ax.message.acknowledged",
  "ax.message.completed",
  "ax.message.failed",
  "ax.message.dead_letter",
  "ax.message.question",
  "ax.message.answered"
]);

export const SECURITY_SEVERITIES = Object.freeze(["info", "low", "medium", "high", "critical"]);
export const SECURITY_OUTCOMES = Object.freeze(["recorded", "allowed", "denied", "failed", "detected", "replayed"]);

export const SECURITY_LIMITS = Object.freeze({
  evidenceMax: 1600,
  summaryMax: 500,
  pageMax: 100,
  defaultRetentionDays: 180
});

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function redact(value) {
  return clean(value, SECURITY_LIMITS.evidenceMax)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{3,})/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "[redacted]");
}

/** Stable JSON so the same event always hashes to the same bytes. */
export function canonicalEvent(event) {
  return JSON.stringify({
    id: event.id,
    seq: event.seq,
    category: event.category,
    severity: event.severity,
    outcome: event.outcome,
    actor: event.actor,
    deviceId: event.deviceId,
    objectiveId: event.objectiveId,
    runId: event.runId,
    taskId: event.taskId,
    correlationId: event.correlationId,
    summary: event.summary,
    evidence: event.evidence,
    createdAt: event.createdAt
  });
}

export function eventHash(prevHash, event) {
  return createHash("sha256").update(String(prevHash || "genesis") + "\n" + canonicalEvent(event), "utf8").digest("hex");
}

/**
 * Recompute the chain. Returns the first broken link, never a boolean that hides where it broke.
 */
export function verifyEventChain(events) {
  let prev = null;
  let expectedSeq = null;
  for (const [index, event] of (Array.isArray(events) ? events : []).entries()) {
    if (expectedSeq !== null && event.seq !== expectedSeq) {
      return { ok: false, index, reason: "sequence_gap", expectedSeq, actualSeq: event.seq };
    }
    if (prev !== null && event.prevHash !== prev) {
      return { ok: false, index, reason: "prev_hash_mismatch", eventId: event.id };
    }
    const computed = eventHash(prev, event);
    if (computed !== event.hash) {
      return { ok: false, index, reason: "hash_mismatch", eventId: event.id, computed, stored: event.hash };
    }
    prev = event.hash;
    expectedSeq = event.seq + 1;
  }
  return { ok: true, checked: (events || []).length, headHash: prev };
}

/**
 * Event service. The repository owns sequence assignment and hashing so two concurrent appends
 * cannot produce the same sequence or a forked chain.
 */
export function createSecurityEventService({
  repository = null,
  now = () => new Date().toISOString(),
  retentionDays = SECURITY_LIMITS.defaultRetentionDays,
  log = console
} = {}) {
  function unavailable() {
    return { ok: false, code: "security_log_not_configured", error: "The security audit log is unavailable on this service." };
  }

  async function record({
    category,
    severity = "info",
    outcome = "recorded",
    actor = null,
    deviceId = null,
    objectiveId = null,
    runId = null,
    taskId = null,
    correlationId = null,
    summary = null,
    evidence = null
  } = {}) {
    if (!repository) return unavailable();
    if (!SECURITY_CATEGORIES.includes(category)) {
      return { ok: false, code: "invalid_security_category", allowed: SECURITY_CATEGORIES };
    }
    const event = {
      id: "sec_" + randomBytes(10).toString("hex"),
      category,
      severity: SECURITY_SEVERITIES.includes(severity) ? severity : "info",
      outcome: SECURITY_OUTCOMES.includes(outcome) ? outcome : "recorded",
      actor: clean(actor, 160) || null,
      deviceId: clean(deviceId, 160) || null,
      objectiveId: clean(objectiveId, 160) || null,
      runId: clean(runId, 160) || null,
      taskId: clean(taskId, 160) || null,
      correlationId: clean(correlationId, 160) || null,
      summary: summary ? redact(summary).slice(0, SECURITY_LIMITS.summaryMax) : null,
      evidence: evidence ? redact(typeof evidence === "string" ? evidence : JSON.stringify(evidence)) : null,
      createdAt: now()
    };
    // A malformed clock value must not create an event that can never be ordered or expired.
    if (!Number.isFinite(Date.parse(event.createdAt))) event.createdAt = new Date().toISOString();
    try {
      const stored = await repository.append(event);
      return { ok: true, event: stored };
    } catch (error) {
      log.error?.("AX_SECURITY_EVENT_FAILED", clean(error?.message, 200));
      return { ok: false, code: "security_store_unavailable", error: "The security event was not persisted." };
    }
  }

  async function list({ category = null, severity = null, beforeSeq = null, limit = 50 } = {}) {
    if (!repository) return unavailable();
    const safeLimit = Math.max(1, Math.min(SECURITY_LIMITS.pageMax, Math.floor(Number(limit) || 50)));
    const events = await repository.list({ category, severity, beforeSeq, limit: safeLimit + 1 });
    const hasMore = events.length > safeLimit;
    const page = hasMore ? events.slice(0, safeLimit) : events;
    return {
      ok: true,
      events: page,
      count: page.length,
      nextBeforeSeq: hasMore && page.length ? page[page.length - 1].seq : null,
      retentionDays
    };
  }

  async function integrity({ limit = 500, expectedHeadHash = null } = {}) {
    if (!repository) return unavailable();
    const events = await repository.chain({ limit });
    const verified = verifyEventChain(events);
    const anchor = expectedHeadHash
      ? { expected: String(expectedHeadHash), actual: verified.headHash, matches: verified.ok && verified.headHash === String(expectedHeadHash) }
      : null;
    const anchored = !anchor || anchor.matches;
    return {
      ok: verified.ok && anchored,
      ...(anchored ? verified : { ...verified, ok: false, reason: verified.ok ? "head_anchor_mismatch" : verified.reason }),
      anchor,
      checked: events.length,
      firstSeq: events[0]?.seq ?? null,
      lastSeq: events[events.length - 1]?.seq ?? null,
      headHash: events.length ? events[events.length - 1].hash : null,
      algorithm: "sha256-chain",
      tamperEvidence: "Detects edits, deletions and reordering relative to an observed head. It is not tamper-proof against an actor who can rewrite the whole table."
    };
  }

  async function stats() {
    if (!repository) return unavailable();
    const events = await repository.list({ limit: SECURITY_LIMITS.pageMax });
    const byCategory = events.reduce((counts, event) => {
      counts[event.category] = (counts[event.category] || 0) + 1;
      return counts;
    }, {});
    const bySeverity = events.reduce((counts, event) => {
      counts[event.severity] = (counts[event.severity] || 0) + 1;
      return counts;
    }, {});
    return { ok: true, recent: events.length, byCategory, bySeverity, retentionDays };
  }

  return Object.freeze({
    available: Boolean(repository),
    record,
    list,
    integrity,
    stats,
    categories: SECURITY_CATEGORIES.slice(),
    severities: SECURITY_SEVERITIES.slice()
  });
}
