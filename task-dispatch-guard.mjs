export function claimTaskDispatch(task, { now = () => new Date().toISOString() } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new TypeError("A task record is required to claim dispatch.");
  }

  const status = String(task.status || "unknown").toLowerCase();
  if (status !== "planned") {
    return {
      claimed: false,
      status,
      reason: status === "delegated"
        ? "dispatch_already_in_progress"
        : "task_is_not_in_planned_state"
    };
  }

  // This synchronous state transition occurs before any awaited work, so two
  // requests handled by the same Node process cannot both claim the same task.
  task.status = "delegated";
  task.delegatedAt = now();
  task.error = null;
  task.result = null;
  return { claimed: true, status: "delegated" };
}
