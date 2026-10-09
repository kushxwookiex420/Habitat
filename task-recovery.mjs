export function markInterruptedTask(task, { now = () => new Date().toISOString() } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new TypeError("A task record is required for recovery.");
  }
  const status = String(task.status || "").toLowerCase();
  if (!["delegated", "running"].includes(status)) return { changed: false, task };
  task.status = "interrupted";
  task.error = "Habitat restarted while this task was in progress. Review the existing result before explicitly retrying.";
  task.interruptedAt = now();
  task.updatedAt = task.interruptedAt;
  return { changed: true, task };
}

export function prepareTaskRetry(task, { now = () => new Date().toISOString() } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new TypeError("A task record is required for retry.");
  }
  const status = String(task.status || "").toLowerCase();
  if (!["interrupted", "failed"].includes(status)) {
    return { allowed: false, reason: "task_not_retryable", task };
  }
  const history = Array.isArray(task.attemptHistory) ? task.attemptHistory.slice(-4) : [];
  history.push({
    status,
    error: task.error || null,
    result: task.result || null,
    completedAt: task.completedAt || null,
    interruptedAt: task.interruptedAt || null
  });
  task.attemptHistory = history;
  task.status = "planned";
  task.error = null;
  task.result = null;
  task.worker = null;
  task.delegatedAt = null;
  task.completedAt = null;
  task.verifiedAt = null;
  task.updatedAt = now();
  return { allowed: true, task };
}
