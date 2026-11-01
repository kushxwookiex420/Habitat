export async function verifyTaskStorage({ taskRepository, taskStorageReady } = {}) {
  if (!taskRepository || taskStorageReady !== true) {
    return {
      status: "UNKNOWN",
      detail: "Durable task storage is not ready; an in-memory read/write probe is not evidence of persistence."
    };
  }

  try {
    const result = await taskRepository.healthCheck();
    if (result?.ok === true && result?.durable === true) {
      return {
        status: "PASS",
        detail: "Durable task repository health check passed."
      };
    }
    return {
      status: "FAIL",
      detail: "Task repository did not confirm both health and durable storage."
    };
  } catch {
    return {
      status: "FAIL",
      detail: "Durable task repository health check failed."
    };
  }
}
