import { createHash } from "node:crypto";

/**
 * The NEXUS work cycle.
 *
 * This is the missing link between three components that already existed separately: the durable
 * objective lifecycle (`ax-objectives.mjs`), the specialist agent runtime (`ax-agents.mjs`) and the
 * Ax/NEXUS message channel (`ax-message-channel.mjs`). It turns an objective into ordered agent
 * work, persists each result before the next step, independently verifies the recorded evidence
 * against the acceptance criteria, and only then completes the objective.
 *
 * Guarantees this module makes:
 *   - a mission never reports completed without `objectives.verify()` returning verified;
 *   - a step result is written as evidence with a deterministic id before the next step starts, so
 *     a crash between steps resumes without repeating finished work;
 *   - an unavailable capability blocks the objective instead of simulating a result;
 *   - no step may approve an action, spend money, deploy, publish or touch credentials;
 *   - a concurrent cycle for the same objective is refused by a durable lease stored in the
 *     objective's own checkpoint history, and every run is bounded by attempts, a deadline and a
 *     wall clock.
 *
 * Everything is injected, so the same cycle runs against D1 in the service and against a memory
 * repository in tests. The cycle never calls a model; the Director's plan is deterministic.
 */

export const WORK_CYCLE_LIMITS = Object.freeze({
  maxSteps: 10,
  maxAttempts: 2,
  retryDelayMs: 150,
  leaseMs: 10 * 60_000,
  maxEvidencePerStep: 6,
  maxVerificationEvidence: 4,
  maxStepSummary: 500,
  maxWallClockMs: 5 * 60_000
});

/** Permissions that always need the owner, even inside a low-risk mission plan. */
const OWNER_PERMISSION = /production|deploy|publish|purchase|refund|external_message|credential|destructive|device_action|account|write/i;

const RETRYABLE_AGENT_CODES = Object.freeze(["agent_timeout", "agent_failed"]);

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function redact(value, max = 300) {
  return clean(value, max)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted]");
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

function ownerTag(value) {
  return digest(clean(value, 120) || "nexus").slice(0, 16);
}

function stepEvidenceId(objectiveId, index) {
  return "ev_wc_" + digest(objectiveId + "\u0000step\u0000" + index);
}

function verificationEvidenceId(objectiveId, index) {
  return "ev_wcv_" + digest(objectiveId + "\u0000verify\u0000" + index);
}

function leaseEntry(objective) {
  const checkpoints = Array.isArray(objective?.checkpoints) ? objective.checkpoints : [];
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const note = String(checkpoints[index]?.note || "");
    const match = /^work:(lease|release|stop):([A-Za-z0-9_-]+)(?::(\d+))?/.exec(note);
    if (!match) continue;
    return { kind: match[1], owner: match[2], expiresAtMs: match[3] ? Number(match[3]) : null, at: checkpoints[index]?.at || null };
  }
  return null;
}

/**
 * @param {object} options
 * @param {object} options.objectives  createObjectiveService()
 * @param {object} options.agents      createAgentRuntime()
 * @param {object} [options.memory]    Ax memory context (recall/remember)
 * @param {object} [options.messages]  Ax <-> NEXUS message channel (notifyAx)
 * @param {object} [options.security]  security event service (record)
 * @param {object} [options.log]
 */
/**
 * Await a promise, but let an operator stop win immediately. The agent call keeps running in the
 * background until its own timeout, yet its result is discarded: nothing from an aborted step is
 * persisted as evidence. This is what makes a stop interrupt an in-flight agent without pretending
 * the agent returned.
 */
function raceWithAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.resolve({ aborted: true });
  }
  return new Promise(resolve => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", onAbort); resolve({ value }); },
      error => { signal.removeEventListener("abort", onAbort); resolve({ error }); }
    );
  });
}

export function createWorkCycle({
  objectives,
  agents,
  memory = null,
  messages = null,
  security = null,
  log = console,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  limits = {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!objectives || typeof objectives.get !== "function") {
    throw new Error("The work cycle needs the durable objective service.");
  }
  if (!agents || typeof agents.delegateAndReview !== "function") {
    throw new Error("The work cycle needs the agent runtime.");
  }
  const config = { ...WORK_CYCLE_LIMITS, ...limits };
  const stopped = new Set();
  const controllers = new Map();
  let revoked = false;
  let revocationLoaded = false;

  function audit(entry) {
    if (!security || typeof security.record !== "function") return;
    try {
      Promise.resolve(security.record(entry)).catch(() => {});
    } catch {
      // An audit failure must not decide the mission outcome.
    }
  }

  async function auditAwait(entry) {
    if (!security || typeof security.record !== "function") return { ok: false, code: "security_log_not_configured" };
    try {
      const recorded = await security.record(entry);
      return recorded && typeof recorded === "object" ? recorded : { ok: false, code: "security_store_unavailable" };
    } catch {
      return { ok: false, code: "security_store_unavailable" };
    }
  }

  /**
   * Load the durable revocation state once per process. Revocation is written as a hash-chained
   * security event, so a deploy or a Render sleep does not silently restore agent permissions; an
   * explicit `agents/restore` records the matching event. Without a readable audit log the state
   * stays process-local and the response says so instead of claiming durability.
   */
  async function hydrateRevocation() {
    if (revocationLoaded) return;
    revocationLoaded = true;
    if (!security || security.available !== true || typeof security.list !== "function") return;
    try {
      const [revokedPage, restoredPage] = await Promise.all([
        security.list({ category: "agent.revoked", limit: 1 }),
        security.list({ category: "agent.restored", limit: 1 })
      ]);
      const lastRevoked = revokedPage?.events?.[0] || null;
      const lastRestored = restoredPage?.events?.[0] || null;
      if (lastRevoked && (!lastRestored || lastRevoked.seq > lastRestored.seq)) revoked = true;
    } catch {
      // An unreadable audit log must not grant execution, but it also must not crash the cycle.
      // The process keeps whatever in-memory state it already had.
    }
  }

  async function notify({ correlationId, kind, body, metadata = null }) {
    if (!messages || typeof messages.notifyAx !== "function") return null;
    try {
      const outcome = await messages.notifyAx({ correlationId, kind, body, metadata });
      return outcome?.ok ? { messageId: outcome.message?.id || null, kind } : { ok: false, code: outcome?.code || "message_failed" };
    } catch (error) {
      log.error?.("WORK_CYCLE_NOTIFY_FAILED", redact(error?.message || error, 160));
      return { ok: false, code: "message_failed" };
    }
  }

  function capabilities() {
    const matrix = typeof agents.capabilityMatrix === "function" ? agents.capabilityMatrix() : [];
    const available = {};
    for (const entry of matrix) available[entry.id] = entry.available === true;
    // Memory is only usable if it can actually recall.
    available.memory = Boolean(memory && typeof memory.recall === "function" && available.memory !== false);
    return available;
  }

  async function load(objectiveId) {
    try {
      return await objectives.get(objectiveId);
    } catch (error) {
      log.error?.("WORK_CYCLE_LOAD_FAILED", redact(error?.message || error, 160));
      return null;
    }
  }

  async function claimLease(objectiveId, owner) {
    const objective = await load(objectiveId);
    if (!objective) return { ok: false, code: "not_found" };
    const current = leaseEntry(objective);
    if (current && current.kind === "lease" && current.owner !== owner && Number(current.expiresAtMs || 0) > nowMs()) {
      return { ok: false, code: "work_cycle_busy", lease: current };
    }
    const claimed = await objectives.checkpoint(objectiveId, {
      note: "work:lease:" + owner + ":" + (nowMs() + config.leaseMs),
      by: "nexus-work-cycle"
    });
    if (claimed.ok !== true) {
      // A compare-and-swap conflict means another writer claimed first.
      return { ok: false, code: claimed.code === "objective_conflict" ? "work_cycle_busy" : claimed.code || "lease_failed" };
    }
    return { ok: true, objective: claimed.objective, lease: { owner, expiresAtMs: nowMs() + config.leaseMs } };
  }

  async function releaseLease(objectiveId, owner) {
    const released = await objectives.checkpoint(objectiveId, {
      note: "work:release:" + owner,
      by: "nexus-work-cycle"
    });
    return released.ok === true;
  }

  function stopRequested(objective, startedAtMs) {
    const checkpoints = Array.isArray(objective?.checkpoints) ? objective.checkpoints : [];
    let lastStop = 0;
    let lastResume = 0;
    for (const entry of checkpoints) {
      const at = Date.parse(entry?.at || 0);
      if (!Number.isFinite(at)) continue;
      const note = String(entry?.note || "");
      // A stop only belongs to the run it interrupted; a stop from an earlier run must not block a
      // new mission, and an explicit resume consumes the stop even when both land in one millisecond.
      if (note.startsWith("work:stop:") && at >= startedAtMs) lastStop = Math.max(lastStop, at);
      if (note.startsWith("work:resume:")) lastResume = Math.max(lastResume, at);
    }
    return lastStop > 0 && lastStop > lastResume;
  }

  function checkInterrupted(objectiveId, startedAtMs, objective) {
    if (revoked) return { stopped: true, code: "agents_revoked", reason: "Agent permissions were revoked." };
    if (stopped.has(objectiveId)) return { stopped: true, code: "work_stopped", reason: "An operator stopped this work cycle." };
    if (["cancelled", "failed", "blocked", "completed"].includes(objective?.status)) {
      return { stopped: true, code: "objective_" + objective.status, reason: "The objective is no longer executing." };
    }
    if (stopRequested(objective, startedAtMs)) return { stopped: true, code: "work_stopped", reason: "An operator recorded a durable stop request." };
    return { stopped: false };
  }

  /**
   * Establish (or reuse) the agent plan. A plan created by the Ax adapter orchestrator is refused
   * here: adapter work is dispatched through `dispatchObjective`, not through agents.
   */
  async function ensurePlan(objective, report) {
    const existing = objective.plan;
    if (existing && Array.isArray(existing.steps) && existing.steps.length) {
      const adapterSteps = existing.steps.filter(step => step.adapter);
      if (adapterSteps.length) {
        return { ok: false, code: "adapter_plan_requires_dispatch", error: "This objective has adapter steps; dispatch it through the Ax run path instead." };
      }
      const sensitive = (existing.permissions || []).filter(permission => OWNER_PERMISSION.test(String(permission)));
      if (sensitive.length) {
        return { ok: false, code: "permission_requires_owner", permissions: sensitive };
      }
      if (existing.steps.some(step => step.requiresApproval === true)) {
        const requested = await objectives.requestApproval(objective.id, { reason: "the plan contains a step that needs the owner", by: "nexus-work-cycle" });
        return { ok: false, code: "approval_required", objective: requested.objective || null };
      }
      // A resumed run keeps the stored plan; nothing is re-planned.
      instrumentPlan(objective);
      return { ok: true, plan: existing, reused: true };
    }

    if (objective.status === "received") {
      const understood = await objectives.understand(objective.id, {
        summary: clean(objective.objective, 600),
        constraints: ["Read-only local tools only", "No deploy, publish, purchase or credential action inside a mission"],
        missingInformation: [],
        questions: [],
        by: "nexus-director"
      });
      if (understood.ok !== true) return { ok: false, code: understood.code || "understand_failed", error: understood.error || null };
      objective = understood.objective;
    }

    const director = await agents.delegateAndReview({
      objective: objective.objective,
      role: "director",
      context: {
        criteria: (objective.criteria || []).map(item => ({ id: item.id, statement: item.statement, required: item.required })),
        capabilities: capabilities()
      },
      scope: "mission-plan:" + objective.id
    });
    report.director = {
      ok: director.review?.accepted === true,
      code: director.review?.code || director.envelope?.code || null,
      summary: director.envelope?.summary || null
    };
    if (director.review?.accepted !== true) {
      audit({
        category: "agent.result_rejected",
        severity: "high",
        outcome: "denied",
        actor: "agent:director",
        objectiveId: objective.id,
        summary: "Director result rejected: " + String(director.review?.code || director.envelope?.code || "unknown"),
        evidence: null
      });
      return { ok: false, code: "director_result_rejected", error: director.review?.code || director.envelope?.code || "director_failed" };
    }
    const plan = director.envelope?.plan;
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      return { ok: false, code: "director_plan_missing", error: "The Director returned no plan." };
    }
    if (plan.steps.length > config.maxSteps) {
      return { ok: false, code: "plan_too_large", error: "The plan exceeds " + config.maxSteps + " steps." };
    }

    const recorded = await objectives.plan(objective.id, {
      steps: plan.steps.map(step => ({
        objective: step.objective,
        agent: step.agent,
        adapter: null,
        requiresApproval: step.requiresApproval === true
      })),
      provider: "nexus-director",
      estimatedCostUsd: 0,
      risk: "low",
      permissions: [],
      by: "nexus-director"
    });
    if (recorded.ok !== true) return { ok: false, code: recorded.code || "plan_failed", error: recorded.error || null };
    objective = recorded.objective;
    instrumentPlan(objective);
    await objectives.checkpoint(objective.id, {
      note: "work:plan:" + plan.steps.length + " step(s): " + plan.steps.map(step => step.agent).join(">"),
      by: "nexus-director"
    });

    if (Array.isArray(plan.missingCapabilities) && plan.missingCapabilities.length) {
      const blocked = await objectives.block(objective.id, {
        reason: "Required capabilities are not mounted: " + plan.missingCapabilities.join(", "),
        missing: plan.missingCapabilities,
        by: "nexus-work-cycle"
      });
      report.blocked = blocked.ok === true;
      return {
        ok: false,
        code: "capability_unavailable",
        missingCapabilities: plan.missingCapabilities,
        objective: blocked.objective || objective,
        error: "This mission needs capabilities that are not configured: " + plan.missingCapabilities.join(", ")
      };
    }
    return { ok: true, plan: objective.plan, reused: false };
  }

  function instrumentPlan(objective) {
    // Plan steps are the routing record; no hidden step may be executed.
    const steps = objective.plan?.steps || [];
    for (const step of steps) {
      if (!step.agent) return { ok: false, code: "plan_step_missing_agent" };
    }
    return { ok: true, steps: steps.length };
  }

  async function runStep({ objective, step, index, memoryContext, startedAtMs, report, signal = null }) {
    const result = {
      index,
      key: "step" + index,
      agent: step.agent,
      objective: step.objective,
      status: "pending",
      attempts: 0,
      ok: false,
      code: null,
      evidenceIds: [],
      evidence: []
    };
    if (!step.agent) {
      result.status = "failed";
      result.code = "plan_step_missing_agent";
      return result;
    }
    const evidenceId = stepEvidenceId(objective.id, index);
    const already = (objective.evidence || []).find(item => item.id === evidenceId);
    if (already) {
      result.status = "reused";
      result.ok = true;
      result.code = "already_recorded";
      result.evidenceIds = [evidenceId];
      return result;
    }

    const interrupted = checkInterrupted(objective.id, startedAtMs, objective);
    if (interrupted.stopped) {
      result.status = "stopped";
      result.code = interrupted.code;
      return result;
    }

    let envelope = null;
    let review = null;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      result.attempts = attempt;
      const raced = await raceWithAbort(
        agents.delegateAndReview({
          objective: clean(step.objective, 1000),
          role: step.agent,
          context: {
            criteria: (objective.criteria || []).map(item => ({ id: item.id, statement: item.statement, required: item.required })),
            memoryContext,
            evidence: (objective.evidence || []).map(item => ({ id: item.id, summary: item.summary, source: item.source, agent: item.agent }))
          },
          scope: "mission:" + objective.id + ":" + startedAtMs,
          signal: signal || null
        }),
        signal
      );
      if (raced.aborted) {
        result.status = "stopped";
        result.code = "work_stopped";
        result.reason = "An operator stopped the work cycle while this agent was running; the unfinished result was discarded.";
        return result;
      }
      const outcome = raced.error
        ? { ok: false, envelope: { code: "agent_failed" }, review: { accepted: false, code: "agent_failed" } }
        : (raced.value || { ok: false, envelope: { code: "agent_failed" }, review: { accepted: false, code: "agent_failed" } });
      envelope = outcome.envelope || null;
      review = outcome.review || null;
      if (outcome.ok === true) break;
      const code = envelope?.code || review?.code || "agent_failed";
      if (!RETRYABLE_AGENT_CODES.includes(code) || attempt >= config.maxAttempts) break;
      await sleep(config.retryDelayMs * attempt);
    }

    if (!envelope) {
      result.status = "failed";
      result.code = "agent_unavailable";
      return result;
    }
    if (review?.accepted !== true) {
      result.status = "failed";
      result.code = review?.code || envelope.code || "agent_result_rejected";
      result.detail = review?.code === "forbidden_action_claim" ? "the agent claimed a forbidden action" : null;
      // A rejected result still carries its diagnosis: a failing check and a proposal are useful
      // evidence of a defect even though they may not be counted as success evidence.
      result.proposedCorrection = envelope.proposedCorrection || null;
      result.summary = envelope.summary || null;
      audit({
        category: "agent.result_rejected",
        severity: "high",
        outcome: "denied",
        actor: "agent:" + (envelope.agent || step.agent),
        objectiveId: objective.id,
        summary: "Agent result rejected during a mission: " + String(result.code),
        evidence: null
      });
      return result;
    }
    if (envelope.requiresApproval === true) {
      result.status = "needs_approval";
      result.code = "approval_required";
      return result;
    }

    const items = (envelope.evidence || [])
      .slice(0, config.maxEvidencePerStep)
      .map((item, itemIndex) => ({
        id: itemIndex === 0 ? evidenceId : evidenceId + "-" + itemIndex,
        summary: clean(item.summary, config.maxStepSummary),
        source: clean(item.source, 80) || "agent:" + step.agent,
        agent: step.agent,
        digest: item.digest || null
      }))
      .filter(item => item.summary);
    if (!items.length) {
      result.status = "failed";
      result.code = "evidence_required";
      return result;
    }
    const added = await objectives.addEvidence(objective.id, { items, by: "agent:" + step.agent });
    if (added.ok !== true) {
      result.status = "failed";
      result.code = added.code || "evidence_write_failed";
      return result;
    }
    result.evidenceIds = items.map(item => item.id);
    result.evidence = items.map(item => ({ id: item.id, summary: item.summary, source: item.source }));
    result.status = "done";
    result.ok = true;
    result.code = envelope.code || null;
    result.summary = envelope.summary || null;
    result.commands = Array.isArray(envelope.commands) ? envelope.commands.length : 0;
    result.proposedCorrection = envelope.proposedCorrection || null;
    await objectives.checkpoint(objective.id, {
      note: "work:step:" + index + ":" + step.agent + ":ok:evidence=" + items.length,
      by: "nexus-work-cycle"
    });
    return result;
  }

  async function verifyMission(objective, report) {
    const claims = report.steps
      .filter(step => step.ok)
      .map(step => ({ agent: step.agent, summary: step.summary || null, evidenceIds: step.evidenceIds }));
    const outcome = await agents.delegateAndReview({
      objective: objective.objective,
      role: "verification",
      context: {
        criteria: (objective.criteria || []).map(item => ({ id: item.id, statement: item.statement, required: item.required })),
        evidence: (objective.evidence || []).map(item => ({ id: item.id, summary: item.summary, source: item.source, agent: item.agent, digest: item.digest })),
        claims
      },
      scope: "mission-verify:" + objective.id
    });
    report.verificationAgent = {
      ok: outcome.review?.accepted === true,
      code: outcome.review?.code || outcome.envelope?.code || null,
      passed: outcome.envelope?.passed === true
    };
    if (outcome.review?.accepted !== true) {
      return { ok: false, code: "verification_agent_rejected", error: outcome.review?.code || outcome.envelope?.code || "verification_failed" };
    }
    const checks = Array.isArray(outcome.envelope?.checks) ? outcome.envelope.checks : [];
    if (!checks.length) return { ok: false, code: "verification_checks_missing", error: "The Verification agent returned no checks." };

    const items = (outcome.envelope.evidence || []).slice(0, config.maxVerificationEvidence).map((item, index) => ({
      id: verificationEvidenceId(objective.id, index),
      summary: clean(item.summary, config.maxStepSummary),
      source: "agent:verification",
      agent: "verification",
      digest: item.digest || null
    }));
    if (items.length) {
      const added = await objectives.addEvidence(objective.id, { items, by: "agent:verification" });
      if (added.ok !== true) return { ok: false, code: added.code || "evidence_write_failed" };
    }
    const verified = await objectives.verify(objective.id, { checks, by: "agent:verification" });
    report.verification = {
      ok: verified.ok === true,
      verified: verified.verified === true,
      unmet: verified.unmet || [],
      results: verified.results || []
    };
    return { ok: verified.ok === true, verified: verified.verified === true, outcome: verified };
  }

  /**
   * Drive one objective to a verified result or an honest non-success.
   * Idempotent: a second call after a crash resumes from the evidence already stored.
   */
  async function run({ objectiveId, by = "nexus", correlationId = null } = {}) {
    const startedAtMs = nowMs();
    const report = {
      ok: false,
      code: null,
      objectiveId: String(objectiveId || ""),
      by: clean(by, 80) || "nexus",
      status: null,
      steps: [],
      director: null,
      verificationAgent: null,
      verification: null,
      memory: null,
      message: null,
      lease: null,
      durationMs: 0
    };
    if (!report.objectiveId) return { ...report, code: "objective_id_required" };

    const owner = ownerTag(by + ":" + report.objectiveId);
    const lease = await claimLease(report.objectiveId, owner);
    if (lease.ok !== true) {
      return { ...report, code: lease.code, lease: lease.lease || null, error: lease.code === "work_cycle_busy" ? "Another work cycle holds this objective." : "The lease could not be claimed." };
    }
    report.lease = { owner, expiresAtMs: lease.lease?.expiresAtMs || null };
    await hydrateRevocation();
    const controller = new AbortController();
    controllers.set(report.objectiveId, controller);
    // A stop belongs to the run it interrupted. The durable stop checkpoint is timestamped, so a
    // later run starts after it and is still correctly refused only for stops issued during itself.
    stopped.delete(report.objectiveId);
    const correlation = clean(correlationId, 120) || "cor_mission_" + digest(report.objectiveId).slice(0, 16);

    try {
      let objective = await load(report.objectiveId);
      if (!objective) return { ...report, code: "not_found" };
      report.status = objective.status;

      if (["completed", "failed", "cancelled"].includes(objective.status)) {
        return { ...report, code: "objective_terminal", status: objective.status, error: "This objective is already closed." };
      }
      if (objective.status === "blocked") {
        return { ...report, code: "objective_blocked", status: "blocked", error: objective.error || "This objective is blocked." };
      }
      if (objective.status === "awaiting_approval") {
        return { ...report, code: "approval_required", status: objective.status };
      }
      if (revoked) return { ...report, code: "agents_revoked" };

      if (["interrupted", "recovery_required"].includes(objective.status)) {
        const recovered = await objectives.recover(objective.id, { by: "nexus-work-cycle", reason: "resuming an interrupted mission" });
        if (recovered.ok !== true) return { ...report, code: recovered.code || "recovery_failed" };
        objective = recovered.objective;
        // Consume any stop issued before this resume. Without this marker, a stop recorded in the
        // same millisecond as the resumed run's start would refuse the run it was not meant for.
        await objectives.checkpoint(objective.id, { note: "work:resume:" + startedAtMs, by: "nexus-work-cycle" });
        objective = await load(objective.id) || objective;
      }

      if (objective.deadlineAt && Date.parse(objective.deadlineAt) <= nowMs()) {
        await objectives.fail(objective.id, { error: "The mission deadline passed before the work finished.", code: "deadline_exceeded", by: "nexus-work-cycle" });
        return { ...report, code: "deadline_exceeded", status: "failed" };
      }

      let memoryContext = null;
      if (memory && typeof memory.recall === "function") {
        const recalled = await memory.recall({ objective: objective.objective });
        if (recalled?.ok) {
          memoryContext = recalled.context || null;
          report.memory = { recalled: Array.isArray(recalled.entries) ? recalled.entries.length : 0, citations: (recalled.citations || []).length };
        } else {
          report.memory = { recalled: 0, error: recalled?.code || "memory_unavailable" };
        }
      }

      if (!objective.plan?.steps?.length) {
        const planned = await ensurePlan(objective, report);
        if (planned.ok !== true) {
          report.objective = planned.objective || null;
          return {
            ...report,
            code: planned.code,
            error: planned.error || null,
            permissions: planned.permissions || null,
            missingCapabilities: planned.missingCapabilities || null
          };
        }
        objective = await load(objective.id);
        report.status = objective?.status || report.status;
      } else {
        const planned = await ensurePlan(objective, report);
        if (planned.ok !== true) {
          report.objective = planned.objective || null;
          return {
            ...report,
            code: planned.code,
            error: planned.error || null,
            permissions: planned.permissions || null,
            missingCapabilities: planned.missingCapabilities || null
          };
        }
      }

      if (objective.status === "planned" || objective.status === "authorized") {
        const started = await objectives.start(objective.id, { by: "nexus-work-cycle" });
        if (started.ok !== true) return { ...report, code: started.code || "start_failed", error: started.error || null };
        objective = started.objective;
        report.status = objective.status;
        await notify({
          correlationId: correlation,
          kind: "progress",
          body: "Mission started: " + clean(objective.objective, 200),
          metadata: { objectiveId: objective.id, steps: objective.plan.steps.length }
        });
      }

      if (objective.status === "executing") {
        const planSteps = objective.plan.steps;
        for (const [index, step] of planSteps.entries()) {
          // The Verification step is the mission's verification phase, not another producing step:
          // it runs after every other step and its checks are what `objectives.verify` records.
          if (step.agent === "verification") continue;
          const latest = await load(objective.id);
          if (!latest) return { ...report, code: "not_found" };
          const interrupted = checkInterrupted(objective.id, startedAtMs, latest);
          if (interrupted.stopped) {
            if (["cancelled", "failed", "blocked", "completed"].includes(latest.status)) {
              return { ...report, code: interrupted.code, status: latest.status, error: interrupted.reason };
            }
            const halted = await objectives.interrupt(objective.id, { reason: interrupted.reason, by: "nexus-work-cycle" });
            return { ...report, code: interrupted.code, status: halted.objective?.status || latest.status, error: interrupted.reason };
          }
          if (nowMs() - startedAtMs > config.maxWallClockMs) {
            await objectives.interrupt(objective.id, { reason: "The work cycle exceeded its wall clock.", by: "nexus-work-cycle" });
            return { ...report, code: "work_cycle_timeout", status: "interrupted" };
          }
          if (latest.deadlineAt && Date.parse(latest.deadlineAt) <= nowMs()) {
            await objectives.fail(objective.id, { error: "The mission deadline passed during execution.", code: "deadline_exceeded", by: "nexus-work-cycle" });
            return { ...report, code: "deadline_exceeded", status: "failed" };
          }

          const stepResult = await runStep({ objective: latest, step, index, memoryContext, startedAtMs, report, signal: controller.signal });
          report.steps.push(stepResult);

          if (stepResult.status === "needs_approval") {
            const requested = await objectives.requestApproval(objective.id, { reason: "step " + index + " (" + step.agent + ") declared that it needs the owner", by: "nexus-work-cycle" });
            await notify({
              correlationId: correlation,
              kind: "approval_request",
              body: "Mission needs owner approval before step " + index + " (" + step.agent + ").",
              metadata: { objectiveId: objective.id, step: index, agent: step.agent }
            });
            return { ...report, code: "approval_required", status: requested.objective?.status || "awaiting_approval" };
          }

          if (stepResult.ok !== true) {
            const code = stepResult.code || "step_failed";
            if (code === "capability_unavailable") {
              const missing = [step.agent];
              const blocked = await objectives.block(objective.id, {
                reason: "Agent capability is not mounted: " + step.agent,
                missing,
                by: "nexus-work-cycle"
              });
              return { ...report, code, status: blocked.objective?.status || "blocked", missingCapabilities: missing };
            }
            if (RETRYABLE_AGENT_CODES.includes(code) || stepResult.status === "stopped") {
              await objectives.interrupt(objective.id, { reason: "agent " + step.agent + " did not finish: " + code, by: "nexus-work-cycle" });
              return { ...report, code, status: "interrupted" };
            }
            await objectives.fail(objective.id, {
              error: "Step " + index + " (" + step.agent + ") failed: " + code,
              code,
              by: "nexus-work-cycle"
            });
            await notify({
              correlationId: correlation,
              kind: "error",
              body: "Mission failed at step " + index + " (" + step.agent + "): " + code,
              metadata: { objectiveId: objective.id, step: index, agent: step.agent, code }
            });
            return { ...report, code, status: "failed" };
          }

          await notify({
            correlationId: correlation,
            kind: "progress",
            body: "Step " + (index + 1) + "/" + planSteps.length + " (" + step.agent + ") completed with " + stepResult.evidenceIds.length + " evidence item(s).",
            metadata: { objectiveId: objective.id, step: index, agent: step.agent, evidenceIds: stepResult.evidenceIds }
          });
        }

        const beforeVerify = await load(objective.id);
        if (!beforeVerify) return { ...report, code: "not_found" };
        if (beforeVerify.status === "executing") {
          const moved = await objectives.transition(objective.id, "verifying", { by: "nexus-work-cycle", reason: "all agent steps finished; independent verification started" });
          if (moved.ok !== true) return { ...report, code: moved.code || "verify_transition_failed", status: beforeVerify.status };
          objective = moved.objective;
        } else if (beforeVerify.status !== "verifying") {
          return { ...report, code: "invalid_transition", status: beforeVerify.status, error: "The objective is no longer executing." };
        } else {
          objective = beforeVerify;
        }
      }

      if (objective.status === "verifying") {
        const verified = await verifyMission(objective, report);
        if (verified.ok !== true) {
          await objectives.fail(objective.id, {
            error: verified.error || "Independent verification failed.",
            code: verified.code || "verification_failed",
            by: "nexus-work-cycle"
          });
          await notify({
            correlationId: correlation,
            kind: "error",
            body: "Mission failed verification: " + (verified.error || verified.code),
            metadata: { objectiveId: objective.id }
          });
          return { ...report, code: verified.code || "verification_failed", status: "failed" };
        }
        if (verified.verified !== true) {
          const failed = await objectives.fail(objective.id, {
            error: "Acceptance criteria unmet: " + ((verified.outcome?.unmet || []).join(", ") || "unknown"),
            code: "verification_failed",
            by: "nexus-work-cycle"
          });
          await notify({
            correlationId: correlation,
            kind: "error",
            body: "Mission did not meet its acceptance criteria: " + ((verified.outcome?.unmet || []).join(", ") || "unknown"),
            metadata: { objectiveId: objective.id, unmet: verified.outcome?.unmet || [] }
          });
          return { ...report, code: "verification_failed", status: failed.objective?.status || "failed", unmet: verified.outcome?.unmet || [] };
        }

        const completed = await objectives.complete(objective.id, {
          summary: "Mission verified by the independent Verification agent.",
          by: "nexus-work-cycle"
        });
        if (completed.ok !== true) return { ...report, code: completed.code || "complete_failed", status: objective.status };

        if (memory && typeof memory.remember === "function") {
          try {
            const remembered = await memory.remember({
              objective: completed.objective.objective,
              runId: "mission:" + completed.objective.id,
              evidence: (completed.objective.evidence || []).map(item => item.summary)
            });
            report.memory = { ...(report.memory || {}), written: remembered?.ok === true, key: remembered?.key || null, code: remembered?.code || null };
          } catch (error) {
            report.memory = { ...(report.memory || {}), written: false, code: "memory_write_failed" };
            log.error?.("WORK_CYCLE_MEMORY_FAILED", redact(error?.message || error, 160));
          }
        }

        const message = await notify({
          correlationId: correlation,
          kind: "result",
          body: "Mission verified and completed: " + clean(completed.objective.objective, 300) +
            " (" + (completed.objective.evidence || []).length + " evidence items).",
          metadata: {
            objectiveId: completed.objective.id,
            status: completed.objective.status,
            evidence: (completed.objective.evidence || []).length,
            correlationId: correlation
          }
        });
        return {
          ...report,
          ok: true,
          code: "completed",
          status: completed.objective.status,
          objectiveId: completed.objective.id,
          objective: completed.objective,
          correlationId: correlation,
          message,
          durationMs: nowMs() - startedAtMs
        };
      }

      return {
        ...report,
        code: "not_executable",
        status: objective.status,
        error: "The objective is in a state this cycle cannot advance: " + objective.status,
        durationMs: nowMs() - startedAtMs
      };
    } catch (error) {
      log.error?.("WORK_CYCLE_FAILED", redact(error?.message || error, 200));
      return { ...report, code: "work_cycle_failed", error: "The work cycle failed unexpectedly.", durationMs: nowMs() - startedAtMs };
    } finally {
      controllers.delete(report.objectiveId);
      await releaseLease(report.objectiveId, owner).catch(() => false);
    }
  }

  /**
   * Stop the cycle before its next step. A call already inside an agent finishes within that
   * agent's own timeout; the stop is durable in the objective's checkpoint history so a resumed
   * cycle honours it too.
   */
  async function stop({ objectiveId, by = "owner", reason = "stopped by an operator" } = {}) {
    const id = clean(objectiveId, 160);
    if (!id) return { ok: false, code: "objective_id_required" };
    stopped.add(id);
    const controller = controllers.get(id) || null;
    if (controller && !controller.signal.aborted) controller.abort();
    const recorded = await objectives.checkpoint(id, {
      note: "work:stop:" + ownerTag(by),
      by: clean(by, 120) || "owner"
    });
    audit({
      category: "work.stop_requested",
      severity: "warning",
      outcome: "recorded",
      actor: clean(by, 120) || "owner",
      objectiveId: id,
      summary: "Work cycle stop requested: " + clean(reason, 200),
      evidence: null
    });
    return {
      ok: recorded.ok !== false,
      code: recorded.ok === false ? recorded.code || "stop_not_recorded" : "stop_requested",
      interrupted: Boolean(controller),
      note: controller
        ? "The running agent was interrupted; its unfinished result is discarded. The stop is durable in the checkpoint history."
        : "No cycle is running in this process. The stop is durable in the checkpoint history and the next run honours it."
    };
  }

  /** Revoke agent execution. Persisted as a security event so a restart does not clear it. */
  async function revoke({ by = "owner", reason = "agent permissions revoked" } = {}) {
    revoked = true;
    const recorded = await auditAwait({
      category: "agent.revoked",
      severity: "high",
      outcome: "allowed",
      actor: clean(by, 120) || "owner",
      summary: clean(reason, 200),
      evidence: "durable agent revocation"
    });
    return {
      ok: true,
      revoked: true,
      durable: recorded.ok === true,
      note: recorded.ok === true
        ? "New agent steps are refused, and this revocation survives a restart until an explicit agents/restore."
        : "New agent steps are refused in this process only; the durable audit log was not writable."
    };
  }

  /** Restore agent execution explicitly; records the matching durable audit event. */
  async function restore({ by = "owner", reason = "agent permissions restored" } = {}) {
    revoked = false;
    const recorded = await auditAwait({
      category: "agent.restored",
      severity: "high",
      outcome: "allowed",
      actor: clean(by, 120) || "owner",
      summary: clean(reason, 200),
      evidence: "durable agent restoration"
    });
    return {
      ok: true,
      revoked: false,
      durable: recorded.ok === true,
      note: recorded.ok === true
        ? "Agent steps are allowed again; the restoration is recorded in the audit log."
        : "Agent steps are allowed in this process only; the durable audit log was not writable."
    };
  }

  return Object.freeze({
    run,
    stop,
    revoke,
    restore,
    revoked: () => revoked,
    limits: Object.freeze({ ...config }),
    plan: input => agents.delegateAndReview({
      objective: input?.objective,
      role: "director",
      context: { criteria: input?.criteria || [], capabilities: capabilities() },
      scope: "mission-plan:" + digest(now())
    })
  });
}
