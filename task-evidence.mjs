const ALLOWED_EVENTS = new Set(["created", "dispatch-started", "check-passed", "result-received", "verified", "blocked", "failed", "interrupted", "retry-requested", "evidence-added"]);

export function appendTaskEvidence(task, input, { now = () => new Date().toISOString() } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new TypeError("A task record is required.");
  const type = String(input?.type || "evidence-added").trim();
  const detail = String(input?.detail || "").trim();
  if (!ALLOWED_EVENTS.has(type)) throw new Error("Unsupported task evidence type.");
  if (!detail || detail.length > 2000) throw new Error("Evidence detail is required and must be at most 2000 characters.");
  const source = String(input?.source || "habitat").trim();
  if (!["habitat", "worker", "operator", "system", "test"].includes(source)) throw new Error("Unsupported evidence source.");
  const evidence = Array.isArray(task.evidence) ? task.evidence.slice(-99) : [];
  const entry = {
    id: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    source,
    detail,
    timestamp: now()
  };
  evidence.push(entry);
  task.evidence = evidence;
  return entry;
}
