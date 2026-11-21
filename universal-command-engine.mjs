import { createHash, randomUUID } from "node:crypto";
import { getRole } from "./agent-roles.mjs";

/**
 * The universal command engine.
 *
 * One objective comes in; the engine records it durably, plans it against the role and tool
 * registries, pauses for owner approval when a step needs it, and only marks a task done when the
 * caller supplies evidence for the claim. A task that produced nothing verifiable cannot be closed
 * as done: it stays working, goes to needs_approval, or fails with an error.
 *
 * Lifecycle: queued -> working -> needs_approval -> working -> done | failed
 * Retry returns a failed task to queued and is capped, so a broken objective cannot loop forever.
 */
export const TASK_STATES = Object.freeze(["queued", "working", "needs_approval", "done", "failed"]);
export const TERMINAL_STATES = Object.freeze(["done", "failed"]);

// Records written by the older worker-task routes still read correctly.
const LEGACY_STATES = Object.freeze({
  planned: "queued",
  delegated: "working",
  running: "working",
  interrupted: "failed",
  completed: "done",
  verified: "done"
});

export function normalizeState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (TASK_STATES.includes(state)) return state;
  return LEGACY_STATES[state] || "queued";
}

function failure(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

export function createUniversalCommandEngine({
  repository,
  registry,
  now = () => new Date().toISOString(),
  newId = () => "cmd_" + randomUUID(),
  maxAttempts = 3
} = {}) {
  if (!repository || typeof repository.get !== "function") throw new Error("The command engine needs a task repository.");
  if (!registry || typeof registry.get !== "function") throw new Error("The command engine needs a tool registry.");

  function history(task) {
    return Array.isArray(task.statusHistory) ? task.statusHistory : [];
  }

  function transition(task, to, { by = "system", reason = null } = {}) {
    const at = now();
    const from = normalizeState(task.status);
    task.status = to;
    task.updatedAt = at;
    task.statusHistory = [...history(task).slice(-49), { from, to, at, by, reason }];
    return task;
  }

  async function save(task, to, meta) {
    transition(task, to, meta);
    const stored = await repository.update(task.id, task);
    return stored || task;
  }

  async function load(id) {
    if (!id) return null;
    const task = await repository.get(String(id));
    if (!task) return null;
    return { ...task, status: normalizeState(task.status) };
  }

  function validateObjective(objective) {
    const text = String(objective || "").trim();
    if (text.length < 3) return { ok: false, error: "An objective of at least 3 characters is required." };
    if (text.length > 2000) return { ok: false, error: "An objective must be 2000 characters or fewer." };
    return { ok: true, text };
  }

  async function submit({ objective, requestedBy = "owner", role = "ax", idempotencyKey = null } = {}) {
    const checked = validateObjective(objective);
    if (!checked.ok) return failure("invalid_objective", checked.error);
    const chosen = getRole(role);
    if (!chosen) return failure("unknown_role", `Unknown role "${role}". Use one of the registered roles.`);

    const key = String(idempotencyKey || "").trim();
    const id = key
      ? "cmd_" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24)
      : newId();

    if (key) {
      const existing = await load(id);
      if (existing) return { ok: true, replayed: true, task: existing };
    }

    const at = now();
    const task = {
      id,
      objective: checked.text,
      requestedBy: String(requestedBy || "owner").slice(0, 120),
      role: chosen.id,
      status: "queued",
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      plan: [],
      checkpoints: [],
      approvals: [],
      statusHistory: [{ from: null, to: "queued", at, by: String(requestedBy || "owner").slice(0, 120), reason: null }],
      result: null,
      error: null,
      idempotencyKey: key || null
    };
    await repository.create(task);
    return { ok: true, replayed: false, task };
  }

  async function plan({ taskId, steps, by = "ax" } = {}) {
    const task = await load(taskId);
    if (!task) return failure("not_found", "No command task with that id.");
    if (TERMINAL_STATES.includes(task.status)) return failure("invalid_transition", `A ${task.status} task cannot be replanned.`, { status: task.status });
    if (!Array.isArray(steps) || steps.length === 0) return failure("invalid_plan", "A plan needs at least one step.");
    if (steps.length > 20) return failure("invalid_plan", "A plan is limited to 20 steps.");

    const planned = [];
    const warnings = [];
    for (const [index, step] of steps.entries()) {
      const roleId = String(step?.role || task.role).trim().toLowerCase();
      if (!getRole(roleId)) return failure("unknown_role", `Step ${index + 1} names an unknown role "${step?.role}".`);
      const label = String(step?.step || "").trim();
      if (!label) return failure("invalid_plan", `Step ${index + 1} needs a description.`);
      const toolName = String(step?.tool || "").trim();
      let toolState = null;
      let needsApproval = false;
      if (toolName) {
        const tool = registry.get(toolName);
        if (!tool) return failure("unknown_tool", `Step ${index + 1} names an unregistered tool "${toolName}".`);
        if (!tool.roles.includes(roleId)) {
          return failure("role_not_allowed", `Role ${roleId} is not allowed to use ${toolName}.`);
        }
        toolState = tool.availability.state;
        if (toolState !== "available") {
          // A plan may reference a tool that is not ready; the task must not claim it ran.
          warnings.push(`${toolName} is ${toolState}: ${tool.availability.detail}`);
        }
        const approval = registry.approvalRequiredFor(toolName, step?.action);
        needsApproval = approval.required;
        if (needsApproval) warnings.push(approval.reason);
      }
      planned.push({
        index: index + 1,
        step: label,
        role: roleId,
        tool: toolName || null,
        toolAvailability: toolState,
        needsApproval
      });
    }

    task.plan = planned;
    task.warnings = warnings;
    const at = now();
    task.updatedAt = at;
    task.checkpoints = [...(task.checkpoints || []).slice(-49), { at, by, note: `plan recorded (${planned.length} steps)` }];

    const approvalStep = planned.find(step => step.needsApproval);
    if (approvalStep) {
      task.approvals = [...(task.approvals || []), {
        state: "requested",
        reason: `${approvalStep.tool} needs owner approval before step ${approvalStep.index}.`,
        action: approvalStep.tool,
        requestedAt: at,
        requestedBy: by
      }];
      const stored = await save(task, "needs_approval", { by, reason: "plan requires approval" });
      return { ok: true, task: stored, warnings, approvalRequired: true };
    }

    const stored = await save(task, "working", { by, reason: "plan accepted" });
    return { ok: true, task: stored, warnings, approvalRequired: false };
  }

  async function checkpoint({ taskId, note, by = "ax" } = {}) {
    const task = await load(taskId);
    if (!task) return failure("not_found", "No command task with that id.");
    const text = String(note || "").trim();
    if (!text) return failure("invalid_checkpoint", "A checkpoint needs a note.");
    const at = now();
    task.checkpoints = [...(task.checkpoints || []).slice(-49), { at, by, note: text.slice(0, 500) }];
    task.updatedAt = at;
    const stored = await repository.update(task.id, task);
    return { ok: true, task: stored };
  }

  async function requestApproval({ taskId, reason, action = null, by = "ax" } = {}) {
    const task = await load(taskId);
    if (!task) return failure("not_found", "No command task with that id.");
    if (TERMINAL_STATES.includes(task.status)) return failure("invalid_transition", `A ${task.status} task cannot request approval.`, { status: task.status });
    const text = String(reason || "").trim();
    if (!text) return failure("invalid_approval", "An approval request needs a reason.");
    const at = now();
    task.approvals = [...(task.approvals || []), {
      state: "requested",
      reason: text.slice(0, 500),
      action: action ? String(action).slice(0, 120) : null,
      requestedAt: at,
      requestedBy: by
    }];
    const stored = await save(task, "needs_approval", { by, reason: text.slice(0, 200) });
    return { ok: true, task: stored };
  }

  async function decideApproval({ taskId, approved, by = "owner", reason = null } = {}) {
    const task = await load(taskId);
    if (!task) return failure("not_found", "No command task with that id.");
    if (task.status !== "needs_approval") return failure("invalid_transition", "This task is not waiting for approval.", { status: task.status });
    const at = now();
    const approvals = [...(task.approvals || [])];
    const pending = [...approvals].reverse().find(entry => entry.state === "requested");
    if (pending) {
      pending.state = approved ? "approved" : "denied";
      pending.decidedBy = String(by).slice(0, 120);
      pending.decidedAt = at;
      if (reason) pending.decisionNote = String(reason).slice(0, 300);
    } else {
      approvals.push({ state: approved ? "approved" : "denied", requestedAt: at, decidedBy: String(by), decidedAt: at });
    }
    task.approvals = approvals;
    if (!approved) {
      task.error = `Denied by ${by}${reason ? ": " + String(reason).slice(0, 200) : "."}`;
      const stored = await save(task, "failed", { by, reason: task.error });
      return { ok: true, approved: false, task: stored };
    }
    const stored = await save(task, "working", { by, reason: "approval granted" });
    return { ok: true, approved: true, task: stored };
  }

  async function complete({ taskId, result, verifiedBy = "ax" } = {}) {
    const task = await load(taskId);
    if (!task) return failure("not_found", "No command task with that id.");
    if (TERMINAL_STATES.includes(task.status)) return failure("invalid_transition", `A ${task.status} task cannot be completed again.`, { status: task.status });
    if (task.status === "needs_approval") return failure("approval_pending", "This task is waiting for owner approval and cannot be completed.", { status: task.status });

    const summary = String(result?.summary || "").trim();
    if (summary.length < 3) return failure("result_required", "A completion needs a result summary.");
    const evidence = []
      .concat(Array.isArray(result?.evidence) ? result.evidence : [])
      .concat(Array.isArray(result?.artifacts) ? result.artifacts : [])
      .map(value => String(value || "").trim())
      .filter(Boolean);
    if (evidence.length === 0) {
      return failure("evidence_required", "A completion needs at least one verifiable item: a URL, artifact, commit, file or command output.");
    }

    const at = now();
    task.result = {
      summary: summary.slice(0, 2000),
      evidence: evidence.slice(0, 20),
      verifiedBy: String(verifiedBy || "ax").slice(0, 120),
      completedAt: at
    };
    task.error = null;
    const stored = await save(task, "done", { by: verifiedBy, reason: "completed with evidence" });
    return { ok: true, task: stored };
  }

  async function fail({ taskId, error, by = "system" } = {}) {
    const task = await load(taskId);
    if (!task) return failure("not_found", "No command task with that id.");
    if (TERMINAL_STATES.includes(task.status)) return failure("invalid_transition", `A ${task.status} task cannot fail again.`, { status: task.status });
    const text = String(error || "").trim();
    if (!text) return failure("error_required", "A failure needs an error message.");
    task.error = text.slice(0, 1000);
    const stored = await save(task, "failed", { by, reason: task.error });
    return { ok: true, task: stored };
  }

  async function retry({ taskId, by = "owner" } = {}) {
    const task = await load(taskId);
    if (!task) return failure("not_found", "No command task with that id.");
    if (task.status !== "failed") return failure("invalid_transition", "Only a failed task can be retried.", { status: task.status });
    const attempts = Number(task.attempts || 0);
    if (attempts >= maxAttempts) {
      return failure("attempt_limit_reached", `This task has used ${attempts} of ${maxAttempts} attempts. Review the failure before raising the limit.`);
    }
    const at = now();
    task.attempts = attempts + 1;
    task.attemptHistory = [...(task.attemptHistory || []).slice(-4), { error: task.error || null, failedAt: task.updatedAt }];
    task.error = null;
    task.result = null;
    const stored = await save(task, "queued", { by, reason: `retry ${task.attempts} of ${maxAttempts}` });
    return { ok: true, task: stored, attempts: task.attempts };
  }

  async function get(taskId) {
    const task = await load(taskId);
    return task ? { ok: true, task } : failure("not_found", "No command task with that id.");
  }

  async function list({ status = null, limit = 50 } = {}) {
    const wanted = status ? normalizeState(status) : null;
    const tasks = await repository.list({ limit, status: wanted });
    return {
      ok: true,
      count: tasks.length,
      tasks: tasks.map(task => ({ ...task, status: normalizeState(task.status) }))
    };
  }

  return Object.freeze({
    states: TASK_STATES,
    submit,
    plan,
    checkpoint,
    requestApproval,
    approve: options => decideApproval({ ...options, approved: true }),
    deny: options => decideApproval({ ...options, approved: false }),
    complete,
    fail,
    retry,
    get,
    list
  });
}
