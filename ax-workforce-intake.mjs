import { createHash } from "node:crypto";

/**
 * Intake: an operational finding becomes a tracked task with an owner, automatically.
 *
 * This is the step that stops improvement from depending on a human running a script. The scheduler
 * produces findings; intake turns each one into a task and assigns it to an eligible agent, or refuses
 * with a specific reason. It never creates an assignment by bypassing the registry's rules: capacity,
 * permissions, health and workspace isolation are all still enforced by `assign`.
 */

/** Which capabilities a finding of each kind needs. An unknown kind needs coding by default. */
export const FINDING_CAPABILITIES = Object.freeze({
  execution_blocked: ["coding", "tests"],
  check_failed: ["coding", "tests"],
  durability_gap: ["coding"],
  capability_unavailable: ["coding"],
  configuration_missing: ["coding"],
  device_silent: ["coding"],
  task_stale: ["coding"],
  approval_expired: ["coding"]
});

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 16);
}

function text(value, limit = 200) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

export function createWorkforceIntake({
  workforce,
  now = () => new Date().toISOString(),
  workspacePrefix = "improvement/",
  budgetCents = null,
  costPerTaskCents = 0
} = {}) {
  if (!workforce || typeof workforce.assign !== "function" || typeof workforce.assignments !== "function") {
    throw new Error("Intake needs the workforce registry.");
  }

  async function intake(finding, { requestedBy = "scheduler" } = {}) {
    const kind = text(finding?.kind, 60);
    if (!kind) return { ok: false, code: "finding_kind_required" };
    const evidence = Array.isArray(finding?.evidence) ? finding.evidence.filter(Boolean) : [];
    if (evidence.length === 0) return { ok: false, code: "finding_evidence_required" };

    const taskId = "task-" + kind + "-" + digest(finding.id || kind + "|" + text(finding.subject));
    const active = (await workforce.assignments()).find(item => item.taskId === taskId && item.state === "active");
    if (active) {
      return { ok: true, replay: true, taskId, assignmentId: active.id, agentId: active.agentId, requires: active.requires };
    }

    const requires = FINDING_CAPABILITIES[kind] || ["coding"];
    const candidates = workforce
      .agents({ capability: requires[0] })
      .filter(agent => agent.availability?.accepting !== false)
      .filter(agent => !["unavailable", "degraded"].includes(agent.health?.status))
      .filter(agent => requires.every(capability => agent.capabilities.includes(capability)))
      .sort((left, right) => (left.activeAssignments || 0) - (right.activeAssignments || 0) || left.id.localeCompare(right.id));

    if (candidates.length === 0) {
      return { ok: false, code: "no_eligible_agent", taskId, requires, kind };
    }

    if (budgetCents !== null) {
      const affordable = workforce.recommendConcurrency({
        queuedTasks: 1,
        availableCents: budgetCents,
        costPerTaskCents,
        hardCap: 1
      });
      if (!affordable.ok) return { ok: false, code: affordable.code, taskId };
      if (affordable.workers < 1) return { ok: false, code: "budget_exhausted", taskId };
    }

    const agent = candidates[0];
    const assigned = await workforce.assign({
      taskId,
      agentId: agent.id,
      requires,
      scopes: [],
      workspaceKey: workspacePrefix + taskId
    });
    if (!assigned.ok) return { ...assigned, taskId, requires };

    return {
      ok: true,
      replay: false,
      taskId,
      assignmentId: assigned.assignmentId,
      agentId: agent.id,
      requires,
      kind,
      requestedBy,
      evidence: evidence.slice(0, 6)
    };
  }

  return Object.freeze({ intake, taskIdFor: finding => "task-" + text(finding?.kind, 60) + "-" + digest(finding?.id || "") });
}
