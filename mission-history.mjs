/**
 * Mission history projection.
 *
 * A mission is an Ax run: its objective, plan, submitted task ids, evidence, cost, recoveries and
 * related notifications. Everything used here is already durable (the run record and the
 * notification rows), so this module is a pure projection — it cannot invent a step that was not
 * executed or a success that was not verified.
 *
 * It is deliberately read-only: reconstructing history never writes to a task or a run.
 */

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function stepView(step) {
  return {
    index: Number(step?.index ?? 0),
    taskId: step?.taskId || null,
    objective: clean(step?.objective, 300),
    adapter: step?.adapter || null,
    status: step?.status || "unknown",
    verified: step?.verified === true,
    verifyReason: step?.verifyReason || null,
    corrective: step?.corrective === true,
    adopted: step?.adopted === true,
    terminal: step?.terminal === true,
    error: step?.error ? clean(step.error, 300) : null,
    evidence: Array.isArray(step?.evidence) ? step.evidence.slice(0, 20).map(line => clean(line, 500)) : []
  };
}

export function missionFromRun(run, notifications = []) {
  if (!run || !run.id) return null;
  return {
    runId: run.id,
    objective: clean(run.objective, 500),
    status: run.status || "unknown",
    verified: run.verified === true,
    settled: run.settled === true,
    code: run.code || null,
    error: run.error ? clean(run.error, 400) : null,
    model: run.model || null,
    costUsd: Number(run.costUsd || 0),
    usage: run.usage || { input_tokens: 0, output_tokens: 0 },
    createdAt: run.createdAt || null,
    completedAt: run.completedAt || null,
    updatedAt: run.updatedAt || null,
    deadlineAt: run.deadlineAt || null,
    recoveries: Number(run.recoveries || 0),
    recoveryNote: run.recoveredNote || null,
    plan: (Array.isArray(run.plan) ? run.plan : []).map((spec, index) => ({
      index,
      objective: clean(spec?.objective, 300),
      adapter: spec?.adapter || null,
      needsApproval: spec?.needsApproval === true
    })),
    steps: (Array.isArray(run.steps) ? run.steps : []).map(stepView),
    evidence: (Array.isArray(run.evidence) ? run.evidence : []).slice(0, 40).map(line => clean(line, 500)),
    memory: run.memory
      ? {
          used: run.memory.used === true,
          recalled: Number(run.memory.recalled || 0),
          error: run.memory.error || null,
          citations: Array.isArray(run.memory.citations) ? run.memory.citations.slice(0, 12) : []
        }
      : { used: false, recalled: 0, error: null, citations: [] },
    memoryUpdate: run.memoryUpdate || null,
    notifications: (Array.isArray(notifications) ? notifications : [])
      .filter(notification => notification && notification.runId === run.id)
      .slice(0, 20)
      .map(notification => ({
        id: notification.id,
        type: notification.type,
        severity: notification.severity,
        title: notification.title,
        status: notification.status,
        createdAt: notification.createdAt,
        attempts: Number(notification.attempts || 0)
      }))
  };
}

/** Newest first, bounded, deterministic. */
export function buildMissionHistory({ runs = [], notifications = [], limit = 20 } = {}) {
  const max = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
  return runs
    .slice()
    .sort((a, b) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || "")))
    .slice(0, max)
    .map(run => missionFromRun(run, notifications))
    .filter(Boolean);
}

/** Counts for a summary line. Everything is derived from records, never from configuration. */
export function missionSummary(missions = []) {
  const summary = { total: missions.length, completed: 0, verified: 0, failed: 0, needsApproval: 0, recovered: 0, costUsd: 0 };
  for (const mission of missions) {
    if (mission.status === "completed") summary.completed += 1;
    if (mission.verified) summary.verified += 1;
    if (mission.status === "failed") summary.failed += 1;
    if (mission.status === "needs_approval") summary.needsApproval += 1;
    if (mission.recoveries > 0) summary.recovered += 1;
    summary.costUsd = Number((summary.costUsd + Number(mission.costUsd || 0)).toFixed(6));
  }
  return summary;
}
