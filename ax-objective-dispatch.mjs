import { READ_ONLY_ADAPTER_NAMES } from "./nexus-adapter-registration.mjs";

/**
 * One implementation of "dispatch an objective into a real Ax run".
 *
 * Both the HTTP dispatch route and the autonomous scheduler tick call this function, so an
 * owner-triggered dispatch and a self-triggered one can never diverge in their budget, evidence or
 * idempotency rules. The function never completes the objective: acceptance checks still decide that.
 *
 * The execution key is deterministic (`objective:<id>`), so a retried or concurrent dispatch
 * reserves budget once and resumes the same run instead of forking a second one.
 */

/**
 * The policy for work that may start without an owner in the loop.
 *
 * Autonomous means reversible, low-risk, internal. Anything that could publish, buy, deploy, touch
 * credentials, message an external party or act on the phone is excluded here as well as in the
 * planner, so a model that writes a permissive plan still cannot make the scheduler run it.
 */
export const AUTONOMOUS_PROHIBITED_PERMISSIONS = Object.freeze([
  "production",
  "deploy",
  "publish",
  "purchase",
  "refund",
  "external_message",
  "credential",
  "destructive",
  "device_action",
  "account"
]);

export function autonomousPolicy(objective) {
  if (!objective) return { ok: false, code: "not_found" };
  if (!["planned", "authorized"].includes(objective.status)) {
    return { ok: false, code: "not_eligible", reason: "status " + objective.status };
  }
  if (objective.approval?.required) return { ok: false, code: "approval_required" };
  const steps = Array.isArray(objective.plan?.steps) ? objective.plan.steps : [];
  if (!steps.length) return { ok: false, code: "plan_required" };
  if (steps.some(step => step.requiresApproval === true)) return { ok: false, code: "approval_required" };
  const risk = String(objective.plan?.risk || "low");
  if (risk !== "low") return { ok: false, code: "risk_too_high", reason: "risk " + risk };
  const permissions = (Array.isArray(objective.plan?.permissions) ? objective.plan.permissions : []).map(item => String(item).toLowerCase());
  const offending = permissions.filter(permission =>
    AUTONOMOUS_PROHIBITED_PERMISSIONS.some(word => permission.includes(word))
  );
  if (offending.length) return { ok: false, code: "permission_requires_owner", permissions: offending };
  // A step may only name a read-only adapter this build actually has.
  const unknown = steps
    .map(step => step.adapter)
    .filter(Boolean)
    .filter(adapter => !READ_ONLY_ADAPTER_NAMES.includes(adapter));
  if (unknown.length) return { ok: false, code: "adapter_not_allowed", adapters: unknown };
  return { ok: true };
}

export async function dispatchObjective({
  objectives,
  orchestrator,
  objectiveId,
  estimateUsd = null,
  recordSecurity = null,
  by = "ax"
} = {}) {
  if (!objectives) return { ok: false, code: "objectives_not_configured" };
  if (!orchestrator || orchestrator.enabled !== true) {
    return { ok: false, code: orchestrator?.code || "orchestrator_unavailable" };
  }
  const objective = await objectives.get(objectiveId);
  if (!objective) return { ok: false, code: "not_found" };
  if (objective.status !== "executing") {
    return { ok: false, code: "invalid_transition", error: "Start the objective before dispatching work.", from: objective.status };
  }

  const runKey = "objective:" + objective.id;
  const accountingBefore = objectives.accountingOf(objective);
  const requested = Number(estimateUsd);
  const estimate = Number.isFinite(requested) && requested >= 0
    ? requested
    : Number(objective.plan?.estimatedCostUsd || 0) > 0
      ? Number(objective.plan.estimatedCostUsd)
      : Math.min(accountingBefore.remainingUsd, Number(orchestrator.budgetUsd || 0.05));

  const reservation = await objectives.reserveExecution(objective.id, {
    executionId: runKey,
    runKey,
    estimateUsd: Math.max(0, Math.min(estimate, Math.max(0, accountingBefore.remainingUsd))),
    agentId: (objective.plan?.steps || []).map(step => step.agent).filter(Boolean)[0] || null,
    provider: objective.plan?.provider || null
  });
  if (reservation.ok !== true) {
    if (reservation.code === "budget_exhausted" && typeof recordSecurity === "function") {
      recordSecurity({
        category: "budget.exhausted",
        severity: "high",
        outcome: "denied",
        actor: by,
        objectiveId: objective.id,
        summary: "Objective dispatch refused: no budget remaining",
        evidence: reservation.error
      });
    }
    return { ...reservation, ok: false };
  }

  let outcome;
  try {
    outcome = await orchestrator.runObjective({
      objective: objective.objective,
      objectiveId: objective.id,
      requestedBy: by,
      runKey
    });
  } catch (error) {
    await objectives.releaseExecution(objective.id, { executionId: runKey, reason: "the run call failed: " + String(error?.message || error).slice(0, 120) });
    return { ok: false, code: "run_failed", error: "The run could not be started." };
  }

  const run = outcome?.run || null;
  if (!run && outcome?.code === "store_unavailable") {
    await objectives.releaseExecution(objective.id, { executionId: runKey, reason: "the run store was unavailable" });
  } else if (run) {
    await objectives.linkExecutionRun(objective.id, { executionId: runKey, runId: run.id });
    const settled = await objectives.settleExecution(objective.id, {
      executionId: runKey,
      runId: run.id,
      actualUsd: Number(run.costUsd || 0),
      note: "run status " + String(run.status || "unknown")
    });
    if (settled.ok === true && settled.accounting?.exhausted && typeof recordSecurity === "function") {
      recordSecurity({
        category: "budget.exhausted",
        severity: "high",
        outcome: "detected",
        actor: by,
        objectiveId: objective.id,
        runId: run.id,
        summary: "Objective budget exhausted after run settlement",
        evidence: JSON.stringify(settled.accounting)
      });
    }
  }

  if (run) {
    for (const step of run.steps || []) {
      if (step.taskId) await objectives.attachTask(objective.id, { taskId: step.taskId, agent: step.agent || null, step: step.index });
    }
    if (Array.isArray(run.evidence) && run.evidence.length) {
      await objectives.addEvidence(objective.id, {
        items: run.evidence.map(line => ({ summary: line, source: "run:" + run.id }))
      });
    }
    await objectives.checkpoint(objective.id, {
      note: "Ax run " + run.id + " dispatched from this objective",
      taskIds: (run.steps || []).map(step => step.taskId).filter(Boolean)
    });
  }

  const resolvedObjective = await objectives.get(objective.id);
  return {
    ok: outcome?.ok === true,
    code: outcome?.code || null,
    run,
    objective: resolvedObjective,
    accounting: resolvedObjective ? objectives.accountingOf(resolvedObjective) : null
  };
}
