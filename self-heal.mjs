/**
 * Self-healing and self-improvement, on top of the durable workforce.
 *
 * Two rules shape this module:
 *
 *   1. A repair is only "recovered" when an independent verifier later records a verified result for that
 *      task. A re-dispatch, a restarted process or a greener log line is not recovery.
 *   2. Every action is bounded. A task is re-executed at most `maxAttempts` times, a run repairs at most
 *      `maxRepairs` tasks, and anything that cannot be repaired inside those bounds is escalated with a
 *      specific reason instead of retried again.
 *
 * It also reads execution history for the self-improvement loop: failing adapters, verifier gaps and
 * repeated blockers become implementation tasks, deduplicated by a stable fingerprint so the same
 * finding does not accumulate a task per cycle.
 */

const clean = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function fingerprint(parts) {
  return "improve:" + parts.map((part) => clean(part, 80)).join("|").toLowerCase().replace(/[^a-z0-9|:_-]+/g, "-").slice(0, 120);
}

/** Read-only diagnosis: what is wrong, with the evidence for the claim and the safe next action. */
export function diagnoseExecution({ agents = [], assignments = [], results = [] } = {}) {
  const findings = [];
  const agentIds = new Set(agents.map((agent) => agent.id));

  for (const assignment of assignments.filter((item) => item.state === "active")) {
    if (!agentIds.has(assignment.agentId)) {
      findings.push({
        code: "orphaned_assignment",
        severity: "high",
        taskId: assignment.taskId,
        agentId: assignment.agentId,
        detail: "The assignment is active but its worker record is gone; the task is invisible until released.",
        action: "release"
      });
    }
  }

  for (const agent of agents) {
    if (["unavailable", "degraded"].includes(agent.health?.status)) {
      findings.push({
        code: "agent_unhealthy",
        severity: "medium",
        agentId: agent.id,
        adapterId: agent.adapterId,
        detail: "Worker health is " + clean(agent.health?.status, 20) + "; it will not accept work.",
        action: "health_check"
      });
    }
  }

  const failuresByAdapter = new Map();
  for (const result of results.filter((item) => item.status === "failed")) {
    const agent = agents.find((item) => item.id === result.agentId);
    findings.push({
      code: "task_failed",
      severity: "medium",
      taskId: result.taskId,
      agentId: result.agentId,
      adapterId: agent?.adapterId || null,
      detail: "Task failed with " + clean(result.code || "no_code", 60) + ".",
      action: "re_execute"
    });
    if (agent?.adapterId) failuresByAdapter.set(agent.adapterId, (failuresByAdapter.get(agent.adapterId) || 0) + 1);
  }
  for (const [adapterId, count] of failuresByAdapter) {
    if (count >= 2) {
      findings.push({
        code: "adapter_failing_repeatedly",
        severity: "high",
        adapterId,
        detail: adapterId + " failed " + count + " tasks in the recorded history.",
        action: "inspect_adapter"
      });
    }
  }

  const verifiedByTask = new Set(results.filter((item) => item.status === "verified").map((item) => item.taskId));
  const unverified = results.filter((item) => item.status === "unverified" && !verifiedByTask.has(item.taskId));
  if (unverified.length) {
    findings.push({
      code: "verification_gap",
      severity: "high",
      detail: unverified.length + " result(s) recorded without independent verification; nothing may be reported complete from them.",
      action: "add_verifier"
    });
  }

  if (!agents.some((agent) => Array.isArray(agent.capabilities) && agent.capabilities.includes("verification"))) {
    findings.push({
      code: "no_verifier",
      severity: "high",
      detail: "No worker holds the verification capability, so no result can ever be verified.",
      action: "register_verifier"
    });
  }

  return findings;
}

/** Findings become implementation tasks, deduplicated by fingerprint. */
export function improvementTasks(findings = [], { existing = [] } = {}) {
  const known = new Set(existing.map((task) => clean(task.fingerprint, 160)));
  const proposals = [];
  for (const finding of findings) {
    const key = fingerprint([finding.code, finding.adapterId || finding.agentId || finding.taskId || "global"]);
    if (known.has(key)) continue;
    known.add(key);
    proposals.push({
      fingerprint: key,
      kind: "self_improvement",
      severity: finding.severity,
      objective: "Resolve " + finding.code + (finding.adapterId ? " in " + finding.adapterId : "") + ": " + finding.detail,
      requiresApproval: false,
      safeToAutomate: finding.code === "orphaned_assignment" || finding.code === "agent_unhealthy" || finding.code === "task_failed"
    });
  }
  return proposals;
}

/**
 * @param {object} options
 * @param {object} options.workforce   durable workforce (agents/assignments/results/retry/assign/release/healthCheck)
 * @param {object} options.runner      createWorkforceRunner result, used to re-execute repaired work
 * @param {Function} [options.escalate] async ({taskId, code, detail}) -> delivery outcome
 * @param {number} [options.maxRepairs] tasks repaired per run
 * @param {number} [options.maxAttempts] re-executions allowed per task across runs
 */
export function createSelfHealer({
  workforce,
  runner,
  escalate = null,
  maxRepairs = 3,
  maxAttempts = 2,
  now = () => new Date().toISOString(),
  log = console
} = {}) {
  if (!workforce || typeof workforce.results !== "function") throw new Error("createSelfHealer needs the workforce registry.");
  if (!runner || typeof runner.runOnce !== "function") throw new Error("createSelfHealer needs the workforce runner.");

  const attempts = new Map();

  const verifiedResultFor = (taskId) =>
    workforce.results().find((result) => result.taskId === taskId && result.status === "verified") || null;

  async function healOnce() {
    const report = {
      at: now(),
      detected: [],
      repaired: [],
      recovered: [],
      escalated: [],
      unverifiedRepairs: [],
      improvementTasks: [],
      bounded: true,
      ok: true
    };

    const agents = workforce.agents();
    const assignments = workforce.assignments();
    const results = workforce.results();
    const findings = diagnoseExecution({ agents, assignments, results });
    report.detected = findings;

    // 1. Safe structural repair: an orphaned assignment is released, and the release is verified.
    for (const finding of findings.filter((item) => item.code === "orphaned_assignment")) {
      const assignment = assignments.find((item) => item.taskId === finding.taskId && item.state === "active");
      if (!assignment) continue;
      const released = await workforce.release({ assignmentId: assignment.id, state: "orphaned", reason: "self-heal: worker record missing" });
      const releasedNow = workforce.assignments().find((item) => item.id === assignment.id)?.state === "orphaned";
      (released.ok && releasedNow ? report.recovered : report.unverifiedRepairs).push({ taskId: finding.taskId, action: "release", verified: released.ok && releasedNow });
    }

    // 2. Health: ask the adapter, then re-read the registry rather than trusting the call's return.
    for (const finding of findings.filter((item) => item.code === "agent_unhealthy").slice(0, maxRepairs)) {
      const previous = workforce.agent(finding.agentId)?.health?.status || null;
      await workforce.healthCheck(finding.agentId);
      const current = workforce.agent(finding.agentId)?.health?.status || null;
      const healthier = current !== null && !["unavailable", "degraded"].includes(current);
      (healthier ? report.recovered : report.unverifiedRepairs).push({ agentId: finding.agentId, action: "health_check", before: previous, after: current, verified: healthier });
    }

    // 3. Bounded re-execution of failed tasks, judged only by a later independently verified result.
    const failedTasks = [...new Set(findings.filter((item) => item.code === "task_failed").map((item) => item.taskId))]
      .slice(0, maxRepairs);
    for (const taskId of failedTasks) {
      const used = attempts.get(taskId) || 0;
      if (used >= maxAttempts) {
        const escalation = { taskId, code: "repair_budget_exhausted", detail: "Re-executed " + used + " time(s) without a verified result." };
        report.escalated.push(escalation);
        if (typeof escalate === "function") await escalate(escalation);
        continue;
      }
      attempts.set(taskId, used + 1);
      report.repaired.push({ taskId, attempt: used + 1 });
      const assignment = workforce.assignments().find((item) => item.taskId === taskId);
      if (!assignment) {
        report.escalated.push({ taskId, code: "assignment_missing", detail: "No assignment record remains for this task." });
        continue;
      }
      // Retry keeps the same worker and its history; if the workforce refused (terminal state), a fresh
      // assignment is the only remaining route and it is recorded as a new attempt.
      const retried = await workforce.retry({ assignmentId: assignment.id, maxAttempts: maxAttempts + 1, reason: "self-heal re-execution" });
      if (!retried.ok) {
        const reassigned = await workforce.assign({ taskId, agentId: assignment.agentId, requires: [], scopes: [], workspaceKey: null });
        if (!reassigned.ok) {
          report.escalated.push({ taskId, code: reassigned.code || "reassign_failed", detail: "The worker could not take the task again." });
          continue;
        }
      }
      try {
        await runner.runOnce();
      } catch (error) {
        log.error?.("SELF_HEAL_RUN_FAILED", clean(error?.message, 160));
      }
      const verified = verifiedResultFor(taskId);
      if (verified) {
        report.recovered.push({ taskId, action: "re_execute", verified: true, verifierAgentId: verified.verifierAgentId || null, evidence: verified.evidence });
      } else {
        report.unverifiedRepairs.push({ taskId, action: "re_execute", verified: false });
        const escalation = { taskId, code: "repair_not_verified", detail: "Re-execution finished without an independently verified result." };
        report.escalated.push(escalation);
        if (typeof escalate === "function") await escalate(escalation);
      }
    }

    // 4. Findings that need a human or a capability nobody has must be named, not retried.
    const needsOwner = findings.filter((item) => ["verification_gap", "no_verifier", "adapter_failing_repeatedly"].includes(item.code));
    for (const finding of needsOwner) {
      const escalation = { code: finding.code, detail: finding.detail };
      report.escalated.push(escalation);
      if (typeof escalate === "function") await escalate(escalation);
    }

    report.improvementTasks = improvementTasks(findings);
    // "ok" means nothing was left unverified and nothing needed the owner. An escalated finding is
    // deliberately not ok: it is a real problem the loop could not safely fix.
    report.ok = report.unverifiedRepairs.length === 0 && report.escalated.length === 0;
    return report;
  }

  return Object.freeze({ healOnce, diagnose: () => diagnoseExecution({ agents: workforce.agents(), assignments: workforce.assignments(), results: workforce.results() }) });
}
