/**
 * Worker catalog and detail projection.
 *
 * The worker list used to be a static registry dump: status fixed at boot, `lastRunAt` always null,
 * and no way to see why a worker was blocked. This module derives everything from the registry plus
 * the real task history, and it never emits a placeholder string: a missing or JSON-null error is the
 * empty string, and a blocked worker always carries the actual reason.
 */

export const WORKER_ALIASES = Object.freeze({
  "ax": "habitat-orchestrator",
  "ax-orchestrator": "habitat-orchestrator",
  "product-scout": "dropilot-product-scout",
  "listing-opt": "dropilot-listing-optimizer",
  "growth-ops": "dropilot-growth-operator"
});

export function resolveWorkerId(value) {
  const id = String(value || "").trim();
  return WORKER_ALIASES[id] || id;
}

/** Android's org.json returns the literal "null" for a JSON null; treat it as absent. */
export function normalizeError(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (text === "" || text === "null" || text === "undefined") return "";
  return text.slice(0, 500);
}

export function workerBlockedReason(worker, { providerConfigured = true } = {}) {
  if (!worker) return "Worker is not registered on this service.";
  if (!providerConfigured) {
    return "No AI provider key is configured on the server, so model-backed work cannot start.";
  }
  if (worker.status === "blocked") {
    return normalizeError(worker.blockedReason) || "Worker is registered but its provider is unavailable.";
  }
  return "";
}

function jobView(task) {
  const error = normalizeError(task?.error);
  return {
    id: String(task?.id || ""),
    title: String(task?.title || ""),
    status: String(task?.status || "unknown"),
    createdAt: task?.createdAt || null,
    delegatedAt: task?.delegatedAt || null,
    completedAt: task?.completedAt || null,
    verifiedAt: task?.verifiedAt || null,
    error: error || null,
    summary: summarizeResult(task?.result)
  };
}

function summarizeResult(result) {
  const text = String(result || "");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.verification) {
      const failed = Object.entries(parsed.verification)
        .filter(([, value]) => value !== "PASS")
        .map(([key, value]) => key + "=" + value);
      return failed.length ? "blocked: " + failed.join(", ") : "all canonical checks passed";
    }
    if (parsed?.workerReport) return String(parsed.workerReport).slice(0, 200);
  } catch {
    // Plain-text results are truncated below.
  }
  return text.slice(0, 200);
}

function workerJobs(workerId, tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && String(task.worker || "") === workerId)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
    .map(jobView);
}

function executionLog(jobs) {
  const lines = [];
  for (const job of jobs.slice(0, 5)) {
    lines.push(`${job.createdAt || "unknown"}  created   ${job.title || job.id}`);
    if (job.delegatedAt) lines.push(`${job.delegatedAt}  dispatched ${job.id}`);
    if (job.status === "verified") lines.push(`${job.completedAt || job.verifiedAt || "unknown"}  verified  ${job.id}`);
    else if (job.status === "blocked") lines.push(`${job.completedAt || "unknown"}  blocked   ${job.id}${job.error ? " — " + job.error : ""}`);
    else if (job.status === "failed") lines.push(`${job.completedAt || "unknown"}  failed    ${job.id}${job.error ? " — " + job.error : ""}`);
    else if (job.status === "running") lines.push(`${job.delegatedAt || "unknown"}  running   ${job.id}`);
  }
  return lines.slice(0, 40);
}

export function buildWorkerList({ workers = [], tasks = [], providerConfigured = true, now = Date.now() } = {}) {
  return (Array.isArray(workers) ? workers : []).map((worker) => {
    const jobs = workerJobs(worker.id, tasks);
    const last = jobs[0] || null;
    const blockedReason = workerBlockedReason(worker, { providerConfigured });
    return {
      id: worker.id,
      name: worker.name,
      kind: worker.kind || "worker",
      model: worker.model || null,
      capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
      status: blockedReason ? "blocked" : last && last.status === "running" ? "running" : "available",
      blockedReason: blockedReason || null,
      lastRunAt: last ? (last.completedAt || last.delegatedAt || last.createdAt) : null,
      lastStatus: last ? last.status : null,
      jobCount: jobs.length,
      failures: jobs.filter((job) => job.status === "failed" || job.status === "blocked").length
    };
  });
}

export function buildWorkerDetail({ worker, tasks = [], providerConfigured = true, now = Date.now() } = {}) {
  if (!worker) return null;
  const jobs = workerJobs(worker.id, tasks);
  const blockedReason = workerBlockedReason(worker, { providerConfigured });
  const last = jobs[0] || null;
  const failed = jobs.find((job) => job.status === "failed" || job.status === "blocked") || null;
  return {
    id: worker.id,
    name: worker.name,
    kind: worker.kind || "worker",
    model: worker.model || null,
    capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
    status: blockedReason ? "blocked" : last && last.status === "running" ? "running" : "available",
    blockedReason: blockedReason || null,
    runtime: {
      lastRunAt: last ? (last.completedAt || last.delegatedAt || last.createdAt) : null,
      lastStatus: last ? last.status : null,
      jobCount: jobs.length,
      verified: jobs.filter((job) => job.status === "verified").length,
      blocked: jobs.filter((job) => job.status === "blocked").length,
      failed: jobs.filter((job) => job.status === "failed").length
    },
    jobs: jobs.slice(0, 10),
    logs: executionLog(jobs),
    controls: {
      canRunCheck: worker.id === "habitat-qa-worker",
      canRetry: Boolean(failed),
      retryTaskId: failed ? failed.id : null,
      runCheckPath: "/tasks",
      delegatePath: failed ? `/tasks/${failed.id}/delegate` : null
    }
  };
}

/**
 * Turns the canonical verification object into explicit lines. A FAIL/UNKNOWN always explains
 * itself, so the console can never show "BLOCKED" with no cause.
 */
export function describeVerification(verification, details = {}) {
  if (!verification || typeof verification !== "object") return { lines: [], blockers: [], verified: false };
  const labels = {
    backendHealth: "Backend health",
    modelWorker: "Model worker",
    androidHeartbeat: "Android heartbeat",
    androidDeviceAccess: "Android device access",
    taskCreation: "Task creation",
    storage: "Storage"
  };
  const lines = [];
  const blockers = [];
  for (const [key, label] of Object.entries(labels)) {
    const status = String(verification[key] || "UNKNOWN");
    const detail = normalizeError(details?.[key]?.detail);
    lines.push(label + ": " + status + (detail ? " — " + detail : ""));
    if (status !== "PASS") blockers.push({ check: key, status, detail: detail || "No reason was reported for this check." });
  }
  const verified = Object.keys(labels).every((key) => verification[key] === "PASS");
  return { lines, blockers, verified };
}
