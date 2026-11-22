import { createHash, randomBytes } from "node:crypto";

/**
 * Durable objective lifecycle.
 *
 * An objective is the unit Ax owns from the moment a human states an outcome until an independently
 * checked result exists. It is deliberately *not* a task: tasks are executed by the NEXUS worker and
 * live in habitat_command_tasks, while this record keeps the intent, the authorization, the
 * acceptance criteria, the evidence references and the cost of the whole mission.
 *
 * The central safety property is the transition table. A plan cannot become a completion: the only
 * edge into `completed` starts at `verifying`, and `complete()` refuses unless every required
 * acceptance criterion was marked met by an evidence check. A model that writes "done" has no path
 * to this state.
 *
 * Persistence is compare-and-swap, like the Ax run store, so a retried request and a recovery pass
 * cannot silently overwrite each other; the loser re-reads and reports the conflict.
 */

export const OBJECTIVE_SCHEMA_VERSION = 1;

export const OBJECTIVE_STATES = Object.freeze([
  "received",
  "understood",
  "planned",
  "awaiting_approval",
  "authorized",
  "executing",
  "verifying",
  "completed",
  "blocked",
  "failed",
  "interrupted",
  "cancelled"
]);

export const RECOVERY_STATES = Object.freeze(["interrupted", "recovery_required"]);

export const TERMINAL_OBJECTIVE_STATES = Object.freeze(["completed", "failed", "cancelled"]);

/**
 * Every allowed edge. Anything absent is refused, including shortcuts such as
 * `planned -> completed` and `executing -> completed`.
 */
export const OBJECTIVE_TRANSITIONS = Object.freeze({
  received: Object.freeze(["understood", "blocked", "failed", "cancelled"]),
  understood: Object.freeze(["planned", "awaiting_approval", "blocked", "failed", "cancelled"]),
  planned: Object.freeze(["awaiting_approval", "authorized", "blocked", "failed", "interrupted", "cancelled"]),
  // A denied approval returns to planning; it never falls through to authorized.
  awaiting_approval: Object.freeze(["authorized", "planned", "blocked", "failed", "cancelled"]),
  authorized: Object.freeze(["executing", "blocked", "failed", "interrupted", "cancelled"]),
  executing: Object.freeze(["verifying", "interrupted", "recovery_required", "blocked", "failed", "cancelled"]),
  verifying: Object.freeze(["completed", "executing", "recovery_required", "blocked", "failed", "cancelled"]),
  interrupted: Object.freeze(["recovery_required", "executing", "blocked", "failed", "cancelled"]),
  recovery_required: Object.freeze(["executing", "interrupted", "blocked", "failed", "cancelled"]),
  // A recovered or unblocked objective resumes through the normal gates.
  blocked: Object.freeze(["planned", "awaiting_approval", "authorized", "executing", "interrupted", "failed", "cancelled"]),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([])
});

export const OBJECTIVE_LIMITS = Object.freeze({
  objectiveMax: 2000,
  criteriaMax: 12,
  criterionMax: 300,
  planStepsMax: 12,
  checkpointsMax: 40,
  evidenceMax: 60,
  transitionsMax: 120,
  maxObjectiveBudgetUsd: 25,
  maxSingleCallUsd: 5
});

export class ObjectiveConflict extends Error {
  constructor(objective) {
    super("objective_conflict");
    this.name = "ObjectiveConflict";
    this.objective = objective || null;
  }
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function redact(value) {
  return clean(value, 400)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted]");
}

function objectiveId(key) {
  return "obj_" + createHash("sha256").update("objective:" + String(key), "utf8").digest("hex").slice(0, 24);
}

function isTerminal(status) {
  return TERMINAL_OBJECTIVE_STATES.includes(status);
}

export function canTransition(from, to) {
  return Boolean(OBJECTIVE_TRANSITIONS[from]?.includes(to));
}

/** Normalize and validate the criteria supplied at creation time. At least one is required. */
export function normalizeCriteria(criteria) {
  if (criteria === undefined || criteria === null) return { ok: false, code: "acceptance_criteria_required" };
  const list = Array.isArray(criteria) ? criteria : null;
  if (!list || list.length === 0) return { ok: false, code: "acceptance_criteria_required" };
  if (list.length > OBJECTIVE_LIMITS.criteriaMax) return { ok: false, code: "too_many_criteria" };
  const cleaned = [];
  for (const [index, raw] of list.entries()) {
    const statement = clean(typeof raw === "string" ? raw : raw?.statement, OBJECTIVE_LIMITS.criterionMax);
    if (statement.length < 8) return { ok: false, code: "criterion_too_vague", index };
    const id = clean(typeof raw === "object" ? raw?.id : null, 64) || "c" + (index + 1);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) return { ok: false, code: "invalid_criterion_id", index };
    if (cleaned.some(entry => entry.id === id)) return { ok: false, code: "duplicate_criterion_id", index };
    cleaned.push({
      id,
      statement,
      // Everything is required unless the caller explicitly marks it optional.
      required: raw && typeof raw === "object" && raw.required === false ? false : true,
      met: false,
      evidence: [],
      checkedAt: null
    });
  }
  if (!cleaned.some(entry => entry.required)) return { ok: false, code: "no_required_criteria" };
  return { ok: true, criteria: cleaned };
}

/**
 * Evidence checks are caller-supplied assertions, but each must name a criterion and point at
 * evidence that actually exists in the objective. This is what stops "verified: true" from being an
 * unchecked boolean: the reference has to resolve.
 */
export function evaluateEvidenceChecks(objective, checks) {
  const evidence = new Set((objective.evidence || []).map(item => item.id));
  const criteriaById = new Map((objective.criteria || []).map(item => [item.id, item]));
  const results = [];
  for (const check of Array.isArray(checks) ? checks : []) {
    const criterionId = clean(check?.criterionId, 64);
    const criterion = criteriaById.get(criterionId);
    if (!criterion) {
      results.push({ criterionId, ok: false, reason: "unknown_criterion" });
      continue;
    }
    const refs = (Array.isArray(check?.evidenceIds) ? check.evidenceIds : [])
      .map(id => clean(id, 120))
      .filter(Boolean);
    if (refs.length === 0) {
      results.push({ criterionId, ok: false, reason: "evidence_required" });
      continue;
    }
    const missing = refs.filter(id => !evidence.has(id));
    if (missing.length) {
      results.push({ criterionId, ok: false, reason: "evidence_not_found", missing });
      continue;
    }
    if (check?.passed !== true) {
      results.push({ criterionId, ok: false, reason: clean(check?.detail, 200) || "check_failed" });
      continue;
    }
    criterion.met = true;
    criterion.evidence = refs;
    criterion.checkedAt = check?.checkedAt || null;
    results.push({ criterionId, ok: true });
  }
  const required = objective.criteria.filter(item => item.required);
  const unmet = required.filter(item => !item.met).map(item => item.id);
  return {
    results,
    met: required.length > 0 && unmet.length === 0,
    unmet
  };
}

export function objectiveSummary(objective) {
  if (!objective) return null;
  const required = (objective.criteria || []).filter(item => item.required);
  return {
    id: objective.id,
    key: objective.key,
    objective: objective.objective,
    status: objective.status,
    phase: objective.status,
    priority: objective.priority,
    requestedBy: objective.requestedBy,
    verified: objective.verification?.verified === true,
    criteria: { total: (objective.criteria || []).length, required: required.length, met: required.filter(item => item.met).length },
    planSteps: (objective.plan?.steps || []).length,
    tasks: (objective.execution?.tasks || []).map(task => ({ taskId: task.taskId, agent: task.agent, status: task.status })),
    costUsd: Number(objective.costUsd || 0),
    budgetUsd: Number(objective.budgetUsd || 0),
    createdAt: objective.createdAt,
    updatedAt: objective.updatedAt,
    completedAt: objective.completedAt || null,
    deadlineAt: objective.deadlineAt || null,
    recoveries: Number(objective.recoveries || 0),
    approval: objective.approval
      ? { required: objective.approval.required === true, approvedAt: objective.approval.approvedAt || null, deniedAt: objective.approval.deniedAt || null }
      : null,
    error: objective.error || null,
    note: objective.note || null
  };
}

/**
 * The service. `repository` must provide `create`, `update(run, token)`, `getRecord` and `list`.
 * Without it every operation answers `not_configured`; there is no in-process fallback that could
 * make an unpersisted objective look durable.
 */
export function createObjectiveService({
  repository = null,
  log = console,
  now = () => new Date().toISOString(),
  maxBudgetUsd = OBJECTIVE_LIMITS.maxObjectiveBudgetUsd
} = {}) {
  const tokens = new Map();

  function unavailable() {
    return { ok: false, code: "objectives_not_configured", error: "Durable objectives are unavailable on this service." };
  }

  async function persist(objective) {
    objective.updatedAt = now();
    const token = tokens.get(objective.id) ?? null;
    let result;
    try {
      result = token === null ? await repository.create(objective) : await repository.update(objective, token);
    } catch (error) {
      log.error?.("AX_OBJECTIVE_SAVE_FAILED", redact(error?.message || error));
      throw new Error("objective_store_unavailable");
    }
    if (token !== null && result.ok === false) {
      tokens.set(objective.id, result.recordJson || null);
      throw new ObjectiveConflict(result.objective || null);
    }
    tokens.set(objective.id, result.recordJson);
    if (token === null && result.created === false) throw new ObjectiveConflict(result.objective || null);
    return objective;
  }

  async function load(id) {
    let record;
    try {
      record = await repository.getRecord(String(id || ""));
    } catch (error) {
      log.error?.("AX_OBJECTIVE_READ_FAILED", redact(error?.message || error));
      return { ok: false, code: "objective_store_unavailable" };
    }
    if (!record?.objective) return { ok: false, code: "not_found" };
    tokens.set(record.objective.id, record.recordJson);
    return { ok: true, objective: record.objective };
  }

  function remember(objective, entry) {
    objective.transitions = Array.isArray(objective.transitions) ? objective.transitions : [];
    objective.transitions.push(entry);
    if (objective.transitions.length > OBJECTIVE_LIMITS.transitionsMax) {
      objective.transitions = objective.transitions.slice(-OBJECTIVE_LIMITS.transitionsMax);
    }
  }

  /**
   * Move one objective. Every caller goes through here, so an illegal edge is refused once rather
   * than re-implemented per route.
   */
  async function transition(id, to, { by = "ax", reason = null, at = now(), mutate = null } = {}) {
    if (!repository) return unavailable();
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    const objective = loaded.objective;
    if (!OBJECTIVE_STATES.includes(to)) return { ok: false, code: "invalid_state" };
    if (!canTransition(objective.status, to)) {
      return {
        ok: false,
        code: "invalid_transition",
        error: "An objective cannot move from " + objective.status + " to " + to + ".",
        from: objective.status
      };
    }
    if (to === "completed" && objective.verification?.verified !== true) {
      return { ok: false, code: "verification_required", error: "An objective cannot complete before its evidence checks pass." };
    }
    const from = objective.status;
    objective.status = to;
    if (objective.status === "completed") {
      objective.completedAt = at;
      objective.error = null;
    }
    if (mutate) mutate(objective);
    remember(objective, { from, to, at, by: clean(by, 120) || "ax", reason: reason ? redact(reason) : null });
    try {
      await persist(objective);
    } catch (error) {
      if (error instanceof ObjectiveConflict) {
        return { ok: false, code: "objective_conflict", error: "Another writer updated this objective; read it again.", objective: error.objective };
      }
      return { ok: false, code: "objective_store_unavailable", error: "The objective could not be persisted." };
    }
    return { ok: true, objective, from, to };
  }

  async function create({
    objective,
    requestedBy = "owner",
    key = null,
    criteria,
    budgetUsd = 0.05,
    deadlineAt = null,
    priority = "normal",
    project = "habitat"
  } = {}) {
    if (!repository) return unavailable();
    const text = clean(objective, OBJECTIVE_LIMITS.objectiveMax);
    if (text.length < 8) return { ok: false, code: "invalid_objective", error: "An objective needs a sentence describing the outcome." };
    const normalized = normalizeCriteria(criteria);
    if (!normalized.ok) {
      return { ok: false, code: normalized.code, error: "At least one concrete, checkable acceptance criterion is required." };
    }
    const cleanKey = key === null || key === undefined ? null : clean(key, 120);
    if (cleanKey !== null && !cleanKey) return { ok: false, code: "invalid_key" };
    const id = cleanKey ? objectiveId(cleanKey) : "obj_" + randomBytes(10).toString("hex");
    const budget = Math.max(0, Math.min(maxBudgetUsd, Number(budgetUsd) || 0));
    const at = now();

    let existing = null;
    try {
      existing = await repository.getRecord(id);
    } catch (error) {
      log.error?.("AX_OBJECTIVE_READ_FAILED", redact(error?.message || error));
      return { ok: false, code: "objective_store_unavailable" };
    }
    if (existing?.objective) {
      if (cleanKey && existing.objective.objective !== text) {
        return { ok: false, code: "key_reused", error: "This objective key already belongs to a different objective.", objective: existing.objective };
      }
      tokens.set(id, existing.recordJson);
      return { ok: true, replayed: true, objective: existing.objective };
    }

    const record = {
      schemaVersion: OBJECTIVE_SCHEMA_VERSION,
      id,
      key: cleanKey,
      project: clean(project, 64).toLowerCase() || "habitat",
      objective: text,
      requestedBy: clean(requestedBy, 120) || "owner",
      status: "received",
      priority: ["low", "normal", "high", "critical"].includes(priority) ? priority : "normal",
      understanding: null,
      plan: null,
      approval: { required: false, requestedAt: null, approvedAt: null, approvedBy: null, approvalId: null, deniedAt: null },
      execution: { tasks: [], startedAt: null, stopped: null },
      criteria: normalized.criteria,
      evidence: [],
      verification: { verified: false, checkedAt: null, failures: [], results: [] },
      checkpoints: [],
      costUsd: 0,
      budgetUsd: budget,
      deadlineAt: deadlineAt ? clean(deadlineAt, 40) : null,
      recovered: 0,
      error: null,
      code: null,
      note: null,
      completedAt: null,
      createdAt: at,
      updatedAt: at,
      transitions: []
    };
    remember(record, { from: null, to: "received", at, by: clean(requestedBy, 120) || "owner", reason: "objective received" });
    try {
      const created = await repository.create(record);
      tokens.set(id, created.recordJson);
      if (created.created === false) {
        return { ok: true, replayed: true, objective: created.objective };
      }
    } catch (error) {
      log.error?.("AX_OBJECTIVE_CREATE_FAILED", redact(error?.message || error));
      return { ok: false, code: "objective_store_unavailable", error: "The objective was not persisted." };
    }
    return { ok: true, objective: record };
  }

  async function understand(id, { summary, constraints = [], missingInformation = [], questions = [], by = "ax" } = {}) {
    const text = clean(summary, 600);
    if (!text) return { ok: false, code: "understanding_required", error: "Record what the objective means before planning." };
    return transition(id, "understood", {
      by,
      reason: "objective understood",
      mutate: objective => {
        objective.understanding = {
          summary: text,
          constraints: (Array.isArray(constraints) ? constraints : []).slice(0, 8).map(item => clean(item, 200)),
          missingInformation: (Array.isArray(missingInformation) ? missingInformation : []).slice(0, 8).map(item => clean(item, 200)),
          questions: (Array.isArray(questions) ? questions : []).slice(0, 8).map(item => clean(item, 200)),
          recordedAt: now()
        };
      }
    });
  }

  /**
   * Recording a plan never executes it. The plan names the agent for each step, its adapter, the
   * approval requirement and the estimated cost, so authorization is decided against a concrete
   * proposal rather than a sentence.
   */
  async function plan(id, { steps, provider = null, estimatedCostUsd = 0, risk = "low", permissions = [], by = "ax" } = {}) {
    const list = Array.isArray(steps) ? steps : [];
    if (list.length === 0) return { ok: false, code: "plan_required", error: "A plan needs at least one step." };
    if (list.length > OBJECTIVE_LIMITS.planStepsMax) return { ok: false, code: "plan_too_large" };
    const cleaned = [];
    for (const [index, step] of list.entries()) {
      const text = clean(step?.objective, 400);
      if (!text) return { ok: false, code: "plan_step_missing_objective", index };
      cleaned.push({
        index,
        objective: text,
        agent: clean(step?.agent, 64) || null,
        adapter: clean(step?.adapter, 120) || null,
        requiresApproval: step?.requiresApproval === true,
        status: "pending",
        taskId: null
      });
    }
    const estimated = Math.max(0, Number(estimatedCostUsd) || 0);
    return transition(id, "planned", {
      by,
      reason: "plan recorded",
      mutate: objective => {
        objective.plan = {
          steps: cleaned,
          provider: clean(provider, 64) || null,
          estimatedCostUsd: estimated,
          risk: ["low", "medium", "high"].includes(risk) ? risk : "low",
          permissions: (Array.isArray(permissions) ? permissions : []).slice(0, 12).map(item => clean(item, 120)),
          plannedAt: now()
        };
        // A plan whose steps declare approval, or that asks for a sensitive permission, is gated
        // before execution even if the caller forgot to request approval.
        const sensitive = cleaned.some(step => step.requiresApproval) ||
          objective.plan.permissions.some(permission => /publish|purchase|refund|deploy|account\.|device\.destructive/i.test(permission));
        objective.approval.required = sensitive;
      }
    });
  }

  async function requestApproval(id, { reason = null, by = "ax" } = {}) {
    return transition(id, "awaiting_approval", {
      by,
      reason: reason || "owner approval requested",
      mutate: objective => {
        objective.approval.required = true;
        objective.approval.requestedAt = now();
      }
    });
  }

  /** Only the owner path may call this; the route enforces the device proof. */
  async function authorize(id, { approvalId, by, budgetUsd = null } = {}) {
    const proof = clean(approvalId, 120);
    if (!proof) return { ok: false, code: "approval_proof_required", error: "An approval record id is required." };
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    if (loaded.objective.approval?.approvedAt && loaded.objective.approval?.approvalId === proof) {
      return { ok: true, replayed: true, objective: loaded.objective };
    }
    if (loaded.objective.status !== "awaiting_approval") {
      return { ok: false, code: "invalid_transition", error: "Only an objective awaiting approval can be authorized.", from: loaded.objective.status };
    }
    return transition(id, "authorized", {
      by,
      reason: "owner authorized",
      mutate: objective => {
        objective.approval.approvedAt = now();
        objective.approval.approvedBy = clean(by, 120) || "owner";
        objective.approval.approvalId = proof;
        if (budgetUsd !== null) {
          objective.budgetUsd = Math.max(0, Math.min(maxBudgetUsd, Number(budgetUsd) || objective.budgetUsd));
        }
      }
    });
  }

  async function deny(id, { by, reason = null } = {}) {
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    if (loaded.objective.status !== "awaiting_approval") {
      return { ok: false, code: "invalid_transition", error: "Only an objective awaiting approval can be denied.", from: loaded.objective.status };
    }
    return transition(id, "planned", {
      by,
      reason: reason || "owner denied",
      mutate: objective => {
        objective.approval.deniedAt = now();
        objective.approval.approvedAt = null;
        objective.approval.approvalId = null;
        objective.error = "Owner denied this plan.";
      }
    });
  }

  /** Begin execution. The budget and the approval gate are re-checked here, not only at planning. */
  async function start(id, { by = "ax" } = {}) {
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    const objective = loaded.objective;
    if (objective.approval?.required && !objective.approval?.approvedAt) {
      return { ok: false, code: "approval_required", error: "This objective needs owner approval before execution." };
    }
    if (Number(objective.costUsd || 0) > Number(objective.budgetUsd || 0)) {
      return { ok: false, code: "budget_exhausted", error: "The objective has no budget left." };
    }
    // A plan that needed no owner approval still passes through `authorized`. That keeps the audit
    // trail identical for gated and ungated work: every execution has an authorization edge.
    if (objective.status === "planned") {
      const authorized = await transition(id, "authorized", { by, reason: "no owner approval required" });
      if (authorized.ok !== true) return authorized;
    }
    return transition(id, "executing", {
      by,
      reason: "execution started",
      mutate: value => {
        value.execution.startedAt = value.execution.startedAt || now();
        value.execution.stopped = null;
      }
    });
  }

  /**
   * Bind a submitted task to its plan step. Idempotent on task id, so a retried submission or a
   * recovery pass cannot make the same task appear twice in the objective.
   */
  async function attachTask(id, { taskId, agent = null, step = null, by = "ax" } = {}) {
    const cleanTaskId = clean(taskId, 160);
    if (!cleanTaskId) return { ok: false, code: "task_id_required" };
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    const objective = loaded.objective;
    if (isTerminal(objective.status)) return { ok: false, code: "objective_terminal", error: "This objective is already closed." };
    if (objective.execution.tasks.some(item => item.taskId === cleanTaskId)) {
      return { ok: true, replayed: true, objective };
    }
    objective.execution.tasks.push({ taskId: cleanTaskId, agent: clean(agent, 64) || null, step: step === null ? null : Number(step), addedAt: now(), status: "submitted" });
    if (objective.plan && step !== null && objective.plan.steps[step]) {
      objective.plan.steps[step].taskId = cleanTaskId;
      objective.plan.steps[step].status = "submitted";
    }
    remember(objective, { from: objective.status, to: objective.status, at: now(), by: clean(by, 120) || "ax", reason: "task attached: " + cleanTaskId });
    try {
      await persist(objective);
    } catch (error) {
      if (error instanceof ObjectiveConflict) return { ok: false, code: "objective_conflict" };
      return { ok: false, code: "objective_store_unavailable" };
    }
    return { ok: true, objective };
  }

  async function addEvidence(id, { items = [], by = "ax" } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { ok: false, code: "evidence_required" };
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    const objective = loaded.objective;
    if (isTerminal(objective.status)) return { ok: false, code: "objective_terminal" };
    for (const [index, item] of list.entries()) {
      const summary = clean(typeof item === "string" ? item : item?.summary, 500);
      if (!summary) continue;
      const evidenceId = clean(item?.id, 120) || "ev_" + createHash("sha256")
        .update(objective.id + "\u0000" + summary + "\u0000" + objective.evidence.length + "\u0000" + index)
        .digest("hex").slice(0, 20);
      if (objective.evidence.some(entry => entry.id === evidenceId)) continue;
      objective.evidence.push({
        id: evidenceId,
        summary,
        source: clean(item?.source, 80) || clean(by, 80) || "ax",
        taskId: clean(item?.taskId, 160) || null,
        agent: clean(item?.agent, 64) || null,
        digest: clean(item?.digest, 128) || null,
        recordedAt: now()
      });
    }
    if (objective.evidence.length > OBJECTIVE_LIMITS.evidenceMax) {
      objective.evidence = objective.evidence.slice(-OBJECTIVE_LIMITS.evidenceMax);
    }
    try {
      await persist(objective);
    } catch (error) {
      if (error instanceof ObjectiveConflict) return { ok: false, code: "objective_conflict" };
      return { ok: false, code: "objective_store_unavailable" };
    }
    return { ok: true, objective };
  }

  async function checkpoint(id, { note, by = "ax", taskIds = [] } = {}) {
    const text = clean(note, 500);
    if (!text) return { ok: false, code: "checkpoint_note_required" };
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    const objective = loaded.objective;
    if (isTerminal(objective.status)) return { ok: false, code: "objective_terminal" };
    objective.checkpoints.push({
      note: text,
      by: clean(by, 120) || "ax",
      taskIds: (Array.isArray(taskIds) ? taskIds : []).map(item => clean(item, 160)).filter(Boolean).slice(0, 20),
      at: now()
    });
    if (objective.checkpoints.length > OBJECTIVE_LIMITS.checkpointsMax) {
      objective.checkpoints = objective.checkpoints.slice(-OBJECTIVE_LIMITS.checkpointsMax);
    }
    try {
      await persist(objective);
    } catch (error) {
      if (error instanceof ObjectiveConflict) return { ok: false, code: "objective_conflict" };
      return { ok: false, code: "objective_store_unavailable" };
    }
    return { ok: true, objective };
  }

  /**
   * Verify against acceptance criteria. Callers move to `verifying` first; this method only records
   * the checks and never closes the objective.
   */
  async function verify(id, { checks = [], by = "sentinel" } = {}) {
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    const objective = loaded.objective;
    if (objective.status !== "verifying") {
      return { ok: false, code: "invalid_state", error: "Evidence checks run only while the objective is verifying.", from: objective.status };
    }
    const evaluation = evaluateEvidenceChecks(objective, checks);
    objective.verification = {
      verified: evaluation.met,
      checkedAt: now(),
      failures: evaluation.results.filter(item => !item.ok),
      unmet: evaluation.unmet,
      results: evaluation.results.slice(0, 40),
      checkedBy: clean(by, 120) || "sentinel"
    };
    if (!evaluation.met) objective.error = "Acceptance criteria unmet: " + evaluation.unmet.join(", ");
    try {
      await persist(objective);
    } catch (error) {
      if (error instanceof ObjectiveConflict) return { ok: false, code: "objective_conflict" };
      return { ok: false, code: "objective_store_unavailable" };
    }
    return { ok: true, objective, verified: evaluation.met, unmet: evaluation.unmet, results: evaluation.results };
  }

  async function complete(id, { summary = null, by = "ax" } = {}) {
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    if (loaded.objective.verification?.verified !== true) {
      return { ok: false, code: "verification_required", error: "The objective has no passing evidence verification." };
    }
    return transition(id, "completed", {
      by,
      reason: "verified completion",
      mutate: objective => {
        objective.note = summary ? redact(summary) : objective.note;
      }
    });
  }

  async function fail(id, { error = "failed", code = null, by = "ax" } = {}) {
    return transition(id, "failed", {
      by,
      reason: error,
      mutate: objective => {
        objective.error = redact(error);
        objective.code = clean(code, 64) || "failed";
      }
    });
  }

  async function block(id, { reason, missing = [], by = "ax" } = {}) {
    const text = clean(reason, 400);
    if (!text) return { ok: false, code: "reason_required" };
    return transition(id, "blocked", {
      by,
      reason: text,
      mutate: objective => {
        objective.error = redact(text);
        objective.note = (Array.isArray(missing) ? missing : []).map(item => clean(item, 200)).join("; ").slice(0, 600) || objective.note;
      }
    });
  }

  async function interrupt(id, { reason = "process stopped", by = "system" } = {}) {
    return transition(id, "interrupted", {
      by,
      reason,
      mutate: objective => {
        objective.note = redact(reason);
      }
    });
  }

  /** Recovery is explicit: it increments a counter and never resumes work on its own. */
  async function recover(id, { by = "system", reason = "recovered after interruption" } = {}) {
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    if (!RECOVERY_STATES.includes(loaded.objective.status)) {
      return { ok: false, code: "not_recoverable", error: "Only an interrupted objective can be recovered.", from: loaded.objective.status };
    }
    return transition(id, "executing", {
      by,
      reason,
      mutate: objective => {
        objective.recovered = Number(objective.recovered || 0) + 1;
        objective.execution.stopped = null;
        objective.note = redact(reason);
      }
    });
  }

  async function cancel(id, { by = "owner", reason = "cancelled" } = {}) {
    return transition(id, "cancelled", { by, reason });
  }

  /**
   * Charge a model/agent call. Exceeding the budget stops execution immediately and moves the
   * objective to `blocked` with a machine code, rather than letting spend continue silently.
   */
  async function charge(id, { costUsd = 0, note = null } = {}) {
    const amount = Number(costUsd);
    if (!Number.isFinite(amount) || amount < 0 || amount > OBJECTIVE_LIMITS.maxSingleCallUsd) {
      return { ok: false, code: "invalid_cost" };
    }
    const loaded = await load(id);
    if (!loaded.ok) return loaded;
    const objective = loaded.objective;
    if (isTerminal(objective.status)) return { ok: false, code: "objective_terminal" };
    objective.costUsd = Number((Number(objective.costUsd || 0) + amount).toFixed(6));
    const over = objective.costUsd > Number(objective.budgetUsd || 0);
    if (over) {
      objective.execution.stopped = "budget_exhausted";
      objective.error = "Spending " + objective.costUsd + " USD exceeded the " + objective.budgetUsd + " USD budget.";
      objective.code = "budget_exhausted";
      if (canTransition(objective.status, "blocked")) {
        remember(objective, { from: objective.status, to: "blocked", at: now(), by: "system", reason: "budget exhausted" });
        objective.status = "blocked";
      }
    }
    try {
      await persist(objective);
    } catch (error) {
      if (error instanceof ObjectiveConflict) return { ok: false, code: "objective_conflict" };
      return { ok: false, code: "objective_store_unavailable" };
    }
    return { ok: !over, code: over ? "budget_exhausted" : null, objective, remainingUsd: Number((objective.budgetUsd - objective.costUsd).toFixed(6)) };
  }

  async function get(id) {
    if (!repository) return null;
    const loaded = await load(id);
    return loaded.ok ? loaded.objective : null;
  }

  async function list({ status = null, limit = 20 } = {}) {
    if (!repository) return [];
    try {
      const rows = await repository.list({ status, limit });
      return rows;
    } catch (error) {
      log.error?.("AX_OBJECTIVE_LIST_FAILED", redact(error?.message || error));
      return [];
    }
  }

  return Object.freeze({
    available: Boolean(repository),
    create,
    get,
    list,
    understand,
    plan,
    requestApproval,
    authorize,
    deny,
    start,
    attachTask,
    addEvidence,
    checkpoint,
    verify,
    complete,
    fail,
    block,
    interrupt,
    recover,
    cancel,
    charge,
    transition,
    summary: objectiveSummary
  });
}
