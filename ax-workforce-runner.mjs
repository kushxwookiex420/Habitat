/**
 * Runner: executes active assignments and obtains independent verification.
 *
 * Provider independence lives here as a lookup, not a branch: the executor is chosen by the agent's
 * `adapterId`, so replacing an adapter is a registry change and the runner is untouched. An executor
 * that throws is a provider failure — retried a bounded number of times, then exhausted, never looped.
 *
 * The verifier is a different agent with the `verification` capability. The runner cannot finalise a
 * result unless one is available; self-verification is refused by the registry, so this path has no way
 * to approve its own work.
 */

function text(value, limit = 200) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

export function createWorkforceRunner({
  workforce,
  executors = {},
  verifierAgentId = null,
  maxPerRun = 3,
  maxAttempts = 2,
  now = () => new Date().toISOString(),
  log = console
} = {}) {
  if (!workforce || typeof workforce.assignments !== "function") {
    throw new Error("The runner needs the workforce registry.");
  }

  function pickVerifier({ excludeAgentId = null } = {}) {
    if (verifierAgentId && verifierAgentId !== excludeAgentId) {
      const explicit = workforce.agent(verifierAgentId);
      if (explicit && explicit.capabilities.includes("verification")) return explicit.id;
    }
    const candidate = workforce
      .agents({ capability: "verification" })
      .filter(agent => agent.id !== excludeAgentId)
      .sort((left, right) => (left.activeAssignments || 0) - (right.activeAssignments || 0) || left.id.localeCompare(right.id))[0];
    return candidate ? candidate.id : null;
  }

  async function runOnce() {
    const summary = { ok: true, attempted: 0, verified: 0, unverified: 0, failed: 0, retried: 0, skipped: [], tasks: [] };
    const active = (await workforce.assignments()).filter(item => item.state === "active");

    for (const assignment of active.slice(0, maxPerRun)) {
      summary.attempted += 1;
      const agent = workforce.agent(assignment.agentId);
      if (!agent) {
        // Recovery: the worker record is gone while its assignment is not. Release it rather than
        // leaving the task invisible forever.
        const released = await workforce.release({ assignmentId: assignment.id, state: "orphaned", reason: "agent record removed" });
        summary.skipped.push({ taskId: assignment.taskId, code: "agent_missing", recovered: released.ok === true });
        continue;
      }
      if (["unavailable", "degraded"].includes(agent.health?.status)) {
        summary.skipped.push({ taskId: assignment.taskId, code: "agent_unavailable", agentId: agent.id });
        continue;
      }

      const execute = executors[agent.adapterId];
      if (typeof execute !== "function") {
        summary.skipped.push({ taskId: assignment.taskId, code: "executor_unavailable", adapterId: agent.adapterId });
        continue;
      }

      let implemented;
      try {
        implemented = await execute({ taskId: assignment.taskId, assignment, agent: { ...agent } });
      } catch (error) {
        const retried = await workforce.retry({ assignmentId: assignment.id, maxAttempts, reason: text(error?.message || error) || "provider_error" });
        summary.retried += retried.ok ? 1 : 0;
        summary.failed += retried.ok ? 0 : 1;
        summary.skipped.push({ taskId: assignment.taskId, code: retried.ok ? "retrying" : "attempts_exhausted", adapterId: agent.adapterId });
        log.error?.("WORKFORCE_EXECUTOR_FAILED", text(error?.message, 160));
        continue;
      }

      const verifier = pickVerifier({ excludeAgentId: agent.id });
      if (!verifier) {
        summary.skipped.push({ taskId: assignment.taskId, code: "no_independent_verifier" });
        continue;
      }
      const verify = executors[workforce.agent(verifier).adapterId];
      let verification;
      if (typeof verify === "function") {
        try {
          verification = await verify({ taskId: assignment.taskId, assignment, agent: workforce.agent(verifier), implementation: implemented });
        } catch (error) {
          verification = { ok: false, evidence: ["verifier failed: " + text(error?.message || error)], tests: { ran: 0, passed: 0, failed: 0 } };
        }
      } else {
        // No verification executor means no verification. A result is still recorded, as unverified.
        verification = null;
      }

      const result = implemented?.result || implemented || {};
      const finalized = await workforce.finalize({
        assignmentId: assignment.id,
        result: {
          status: result.status || "completed",
          evidence: result.evidence || [],
          changedFiles: result.changedFiles || [],
          tests: result.tests || { ran: 0, passed: 0, failed: 0 },
          costCents: result.costCents === undefined ? null : result.costCents
        },
        verifierAgentId: verification ? verifier : null,
        verification: verification ? {
          ok: verification.ok === true,
          evidence: verification.evidence || [],
          tests: verification.tests || { ran: 0, passed: 0, failed: 0 }
        } : null
      });

      if (finalized.ok && finalized.result?.status === "verified") summary.verified += 1;
      else if (finalized.ok) summary.unverified += 1;
      else {
        summary.unverified += 1;
        summary.skipped.push({ taskId: assignment.taskId, code: finalized.code });
      }
      summary.tasks.push({
        taskId: assignment.taskId,
        agentId: agent.id,
        verifierAgentId: verification ? verifier : null,
        status: finalized.result?.status || finalized.code,
        approvalRequired: finalized.result?.approvalRequired ?? null
      });
    }

    return summary;
  }

  return Object.freeze({ runOnce, pickVerifier });
}
