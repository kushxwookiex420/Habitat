/**
 * Workforce section of `/system/status`.
 *
 * The five words are kept apart on purpose. "Enabled" is an operator decision, "initialized" is a
 * hydration fact, "running" means the scheduler actually used the workforce since boot, and "verified"
 * means an independent verifier produced a recorded result. None of them is inferred from another.
 *
 * Input is the runtime's own `status()`; nothing here reaches the database or the network.
 */

export function summarizeWorkforce(input) {
  if (!input || typeof input !== "object") {
    return {
      state: "not_configured",
      flag: null,
      enabled: false,
      configured: false,
      initialized: false,
      running: false,
      verified: false,
      detail: "No workforce runtime is attached to this process."
    };
  }
  const counts = input.counts || {};
  return {
    state: input.state || "not_configured",
    flag: input.flag || "HABITAT_WORKFORCE_ENABLED",
    enabled: input.enabled === true,
    configured: input.configured === true,
    initialized: input.initialized === true,
    running: input.running === true,
    verified: input.verified === true,
    migration: {
      version: input.migration?.version || "0010_ax_workforce",
      ready: input.migration?.ready ?? null,
      missing: Array.isArray(input.migration?.missing) ? input.migration.missing.slice(0, 8) : [],
      appliedByRuntime: false
    },
    recoveredAssignments: Number(input.recoveredAssignments || 0),
    counts: {
      agents: Number(counts.agents || 0),
      assignments: Number(counts.assignments || 0),
      active: Number(counts.active || 0),
      results: Number(counts.results || 0),
      verified: Number(counts.verified || 0),
      approvalRequired: Number(counts.approvalRequired || 0)
    },
    steps: Number(input.steps || 0),
    lastStepAt: input.lastStepAt || null,
    lastError: input.lastError || null,
    nexusRuntimeEnabled: input.nexusRuntimeEnabled === true,
    detail: input.detail || "No detail reported."
  };
}
