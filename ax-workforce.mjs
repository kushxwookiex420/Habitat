/**
 * Replaceable-agent workforce registry.
 *
 * Design rules, in order of importance:
 *
 *   1. Habitat owns the record. An agent is a row here — provider, capabilities, health, cost limits,
 *      permissions, workspace — not a thing that exists only inside a vendor session. Removing or
 *      replacing an agent must leave tasks, results and history intact.
 *   2. Providers are adapters. Freebuff, NEXUS or anything later is an `execute` function behind the
 *      same interface. Swapping the adapter behind an agent id cannot change the task record.
 *   3. Work is isolated. Two assignments may not share a workspace branch or overlapping file scopes.
 *   4. Verification is independent. A result finalised by the agent that produced it is refused, not
 *      downgraded.
 *   5. Nothing is claimed without evidence. Evidence-free results and test-free verifications are
 *      rejected, and a cost that cannot be measured is recorded as null rather than guessed.
 *
 * Persistence is deliberately out of scope in this module: it is an in-memory registry with an
 * append-only history, and a durable repository is the next layer, not a claim made here.
 */

export const ADAPTER_KINDS = Object.freeze(["coding", "research", "verification", "content", "analysis", "security"]);
export const HEALTH_STATES = Object.freeze(["healthy", "degraded", "unavailable", "unknown"]);
export const RESULT_STATUSES = Object.freeze(["completed", "failed", "blocked", "partial"]);

const AUDIT_LIMIT = 2000;

function text(value, limit = 200) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function list(value) {
  return Array.isArray(value) ? value.map(item => text(item, 120)).filter(Boolean) : [];
}

function succeeds(pattern, value) {
  return new RegExp(pattern).test(value);
}

function requireId(value, code) {
  const id = text(value, 120);
  if (!id || !succeeds("^[a-z0-9][a-z0-9._-]{1,119}$", id)) return { ok: false, code };
  return { ok: true, id };
}

export function createWorkforce({ log = console, now = () => new Date().toISOString() } = {}) {
  const adapterMap = new Map();
  const agentMap = new Map();
  const assignments = new Map();
  const audit = [];
  const results = [];
  let sequence = 0;

  function record(entry) {
    audit.push({ at: now(), ...entry });
    if (audit.length > AUDIT_LIMIT) audit.splice(0, audit.length - AUDIT_LIMIT);
  }

  function nextId(prefix) {
    sequence += 1;
    return prefix + "_" + String(sequence).padStart(4, "0");
  }

  function registerAdapter({ id, kind, description = "", execute, health = null, replaceable = true } = {}) {
    const checked = requireId(id, "adapter_id_invalid");
    if (!checked.ok) return checked;
    if (!ADAPTER_KINDS.includes(kind)) return { ok: false, code: "adapter_kind_invalid" };
    if (typeof execute !== "function") return { ok: false, code: "adapter_execute_required" };
    adapterMap.set(checked.id, {
      id: checked.id,
      kind,
      description: text(description, 300),
      execute,
      health: typeof health === "function" ? health : null,
      replaceable,
      registeredAt: now()
    });
    record({ action: "adapter.registered", adapterId: checked.id, kind });
    return { ok: true, adapterId: checked.id };
  }

  function registerAgent({
    id,
    name = "",
    specialty,
    adapterId,
    capabilities = [],
    permissions = { allowed: [], denied: [] },
    limits = {},
    workspace = {},
    availability = {},
    revision = 1
  } = {}) {
    const checked = requireId(id, "agent_id_invalid");
    if (!checked.ok) return checked;
    if (!text(name || id)) return { ok: false, code: "agent_name_required" };
    const adapter = adapterMap.get(text(adapterId, 120));
    if (!adapter) return { ok: false, code: "unknown_adapter" };
    if (!text(specialty)) return { ok: false, code: "agent_specialty_required" };
    const caps = list(capabilities);
    if (caps.length === 0) return { ok: false, code: "agent_capabilities_required" };
    const denied = list(permissions?.denied);
    const allowed = list(permissions?.allowed);
    if (!Array.isArray(permissions?.allowed) || !Array.isArray(permissions?.denied)) {
      return { ok: false, code: "permissions_malformed" };
    }
    if (allowed.length === 0 && denied.length === 0) return { ok: false, code: "permissions_required" };
    const maxConcurrent = Number(availability?.maxConcurrent ?? 1);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) return { ok: false, code: "availability_invalid" };
    const maxTaskCents = limits?.maxTaskCents === undefined ? null : Number(limits.maxTaskCents);
    if (maxTaskCents !== null && (!Number.isInteger(maxTaskCents) || maxTaskCents < 0)) {
      return { ok: false, code: "limit_invalid" };
    }
    const isolation = text(workspace?.isolation, 40) || "none";
    if (!["none", "git-worktree", "copy", "readonly"].includes(isolation)) return { ok: false, code: "workspace_isolation_invalid" };

    agentMap.set(checked.id, {
      id: checked.id,
      name: text(name || id, 120),
      specialty: text(specialty, 60),
      adapterId: adapter.id,
      capabilities: caps,
      permissions: { allowed, denied },
      limits: { maxTaskCents, maxMinutes: Number.isFinite(limits?.maxMinutes) ? Number(limits.maxMinutes) : null },
      workspace: { isolation, root: text(workspace?.root, 300) || null, branchPattern: text(workspace?.branchPattern, 120) || null },
      availability: { maxConcurrent, accepting: availability?.accepting !== false },
      health: { status: "unknown", checkedAt: null, detail: null },
      revision,
      addedAt: now()
    });
    record({ action: "agent.registered", agentId: checked.id, adapterId: adapter.id, specialty: text(specialty, 60) });
    return { ok: true, agentId: checked.id };
  }

  function activeFor(agentId) {
    return Array.from(assignments.values()).filter(item => item.agentId === agentId && item.state === "active");
  }

  /** Replace the worker behind an id without touching anything already recorded about it. */
  function replaceAgent(id, patch = {}) {
    const agent = agentMap.get(text(id, 120));
    if (!agent) return { ok: false, code: "unknown_agent" };
    if (activeFor(agent.id).length > 0) return { ok: false, code: "agent_busy" };
    if (patch.adapterId && !adapterMap.has(text(patch.adapterId, 120))) return { ok: false, code: "unknown_adapter" };
    const next = {
      ...agent,
      ...(patch.adapterId ? { adapterId: text(patch.adapterId, 120) } : {}),
      ...(Array.isArray(patch.capabilities) && patch.capabilities.length ? { capabilities: list(patch.capabilities) } : {}),
      ...(patch.limits ? { limits: { ...agent.limits, ...patch.limits } } : {}),
      ...(patch.permissions ? { permissions: { allowed: list(patch.permissions.allowed), denied: list(patch.permissions.denied) } } : {}),
      ...(patch.availability ? { availability: { ...agent.availability, ...patch.availability } } : {}),
      revision: agent.revision + 1,
      replacedAt: now()
    };
    agentMap.set(agent.id, next);
    record({ action: "agent.replaced", agentId: agent.id, revision: next.revision, adapterId: next.adapterId });
    return { ok: true, agent: next };
  }

  function removeAgent(id) {
    const agent = agentMap.get(text(id, 120));
    if (!agent) return { ok: false, code: "unknown_agent" };
    if (activeFor(agent.id).length > 0) return { ok: false, code: "agent_busy" };
    agentMap.delete(agent.id);
    record({ action: "agent.removed", agentId: agent.id });
    // History, results and assignments stay: removing a worker never deletes its work record.
    return { ok: true, removed: agent.id, historyRetained: true };
  }

  async function healthCheck(id) {
    const agent = agentMap.get(text(id, 120));
    if (!agent) return { ok: false, code: "unknown_agent" };
    const adapter = adapterMap.get(agent.adapterId);
    if (!adapter?.health) {
      const state = { status: "unknown", checkedAt: now(), detail: "The adapter exposes no health probe." };
      agentMap.set(agent.id, { ...agent, health: state });
      return { ok: false, code: "health_probe_missing", agentId: agent.id, health: state };
    }
    let probe;
    try {
      probe = await adapter.health();
    } catch (error) {
      probe = { status: "unavailable", detail: text(error?.message || error) };
    }
    const status = HEALTH_STATES.includes(probe?.status) ? probe.status : "unknown";
    const health = { status, checkedAt: now(), detail: probe?.detail ? text(probe.detail, 300) : null };
    agentMap.set(agent.id, { ...agent, health });
    record({ action: "agent.health", agentId: agent.id, status, detail: health.detail });
    return { ok: status === "healthy", agentId: agent.id, health };
  }

  function overlaps(scopesA, scopesB) {
    return scopesA.some(left => scopesB.some(right => left === right || left.startsWith(right + "/") || right.startsWith(left + "/")));
  }

  /**
   * Assign a task to an agent. Refusals are specific: capacity, workspace collision, scope overlap,
   * permission, health. A refusal never partially assigns.
   */
  function assign({ taskId, agentId, requires = [], scopes = [], workspaceKey = null } = {}) {
    const task = requireId(taskId, "task_id_invalid");
    if (!task.ok) return task;
    const agent = agentMap.get(text(agentId, 120));
    if (!agent) return { ok: false, code: "unknown_agent" };
    if (agent.availability.accepting !== true) return { ok: false, code: "agent_not_accepting" };
    if (["unavailable", "degraded"].includes(agent.health.status)) return { ok: false, code: "agent_unavailable", health: agent.health };
    if (activeFor(agent.id).length >= agent.availability.maxConcurrent) return { ok: false, code: "agent_at_capacity" };

    const requestedRequires = list(requires);
    const needed = requestedRequires.length ? requestedRequires : agent.capabilities;
    const missing = needed.filter(capability => !agent.capabilities.includes(capability));
    if (missing.length > 0) return { ok: false, code: "capability_missing", missing };
    const denied = needed.filter(capability => agent.permissions.denied.includes(capability));
    if (denied.length > 0) return { ok: false, code: "permission_denied", denied };

    const key = text(workspaceKey, 200) || null;
    const requested = list(scopes);
    for (const current of assignments.values()) {
      if (current.state !== "active") continue;
      if (key && current.workspaceKey && current.workspaceKey === key) {
        return { ok: false, code: "workspace_conflict", against: current.taskId };
      }
      if (requested.length && current.scopes.length && overlaps(requested, current.scopes) && (!key || !current.workspaceKey || current.workspaceKey === key)) {
        return { ok: false, code: "scope_conflict", against: current.taskId };
      }
    }

    const assignmentId = nextId("asg");
    const entry = {
      id: assignmentId,
      taskId: task.id,
      agentId: agent.id,
      // What the task asked for, not what the agent happened to have: a handoff must not inherit the
      // previous worker's capability set as a requirement.
      requires: requestedRequires,
      scopes: requested,
      workspaceKey: key,
      state: "active",
      attempts: 1,
      assignedAt: now()
    };
    assignments.set(assignmentId, entry);
    record({ action: "assignment.created", assignmentId, taskId: task.id, agentId: agent.id, scopes: requested, workspaceKey: key });
    return { ok: true, assignmentId, assignment: entry };
  }

  function release({ assignmentId, state = "released", reason = null } = {}) {
    const entry = assignments.get(text(assignmentId, 60));
    if (!entry) return { ok: false, code: "unknown_assignment" };
    if (entry.state !== "active") return { ok: false, code: "assignment_not_active" };
    const next = { ...entry, state, releasedAt: now(), reason: reason ? text(reason, 200) : null };
    assignments.set(entry.id, next);
    record({ action: "assignment." + state, assignmentId: entry.id, taskId: entry.taskId, agentId: entry.agentId, reason: next.reason });
    return { ok: true, assignment: next };
  }

  /** Retry on the same agent, counted. The cap is the caller's policy, recorded here. */
  function retry({ assignmentId, maxAttempts = 2, reason = null } = {}) {
    const entry = assignments.get(text(assignmentId, 60));
    if (!entry) return { ok: false, code: "unknown_assignment" };
    if (entry.state !== "active") return { ok: false, code: "assignment_not_active" };
    if (entry.attempts >= maxAttempts) {
      const exhausted = { ...entry, state: "exhausted", releasedAt: now(), reason: reason ? text(reason, 200) : null };
      assignments.set(entry.id, exhausted);
      record({ action: "assignment.exhausted", assignmentId: entry.id, attempts: entry.attempts });
      return { ok: false, code: "attempts_exhausted", assignment: exhausted };
    }
    const next = { ...entry, attempts: entry.attempts + 1, lastRetryAt: now(), reason: reason ? text(reason, 200) : null };
    assignments.set(entry.id, next);
    record({ action: "assignment.retried", assignmentId: entry.id, attempts: next.attempts });
    return { ok: true, assignment: next };
  }

  /** Move unfinished work to another agent; the original assignment stays in history. */
  function handoff({ taskId, fromAgentId, toAgentId, reason = null } = {}) {
    const task = requireId(taskId, "task_id_invalid");
    if (!task.ok) return task;
    const source = Array.from(assignments.values()).find(item => item.taskId === task.id && item.agentId === text(fromAgentId, 120) && item.state === "active");
    if (!source) return { ok: false, code: "no_active_assignment" };
    const target = agentMap.get(text(toAgentId, 120));
    if (!target) return { ok: false, code: "unknown_agent" };
    if (target.id === source.agentId) return { ok: false, code: "handoff_to_self" };
    // The source branch is released first, otherwise the new assignment collides with the very
    // workspace the handoff is transferring.
    const closed = release({ assignmentId: source.id, state: "handed_off", reason: "to " + target.id + (reason ? ": " + reason : "") });
    const moved = assign({ taskId: task.id, agentId: target.id, requires: source.requires, scopes: source.scopes, workspaceKey: source.workspaceKey });
    if (!moved.ok) return { ...moved, from: closed.assignment };
    record({ action: "assignment.handed_off", taskId: task.id, from: source.agentId, to: target.id, reason: reason ? text(reason, 200) : null });
    return { ok: true, from: closed.assignment, to: moved.assignment };
  }

  /**
   * Record the outcome and verify it independently. The verifier may not be the implementer, and a
   * verification without a run test is not a verification.
   */
  function finalize({ assignmentId, result = {}, verifierAgentId = null, verification = null } = {}) {
    const assignment = assignments.get(text(assignmentId, 60));
    if (!assignment) return { ok: false, code: "unknown_assignment" };
    if (assignment.state !== "active") return { ok: false, code: "assignment_not_active" };

    const status = text(result?.status, 20);
    if (!RESULT_STATUSES.includes(status)) return { ok: false, code: "result_status_invalid" };
    const evidence = list(result?.evidence);
    if (evidence.length === 0) return { ok: false, code: "evidence_required" };
    const changedFiles = list(result?.changedFiles);
    const tests = result?.tests && typeof result.tests === "object"
      ? { ran: Number(result.tests.ran || 0), passed: Number(result.tests.passed || 0), failed: Number(result.tests.failed || 0) }
      : { ran: 0, passed: 0, failed: 0 };
    const costCents = result?.costCents === null || result?.costCents === undefined ? null : Number(result.costCents);
    if (costCents !== null && (!Number.isInteger(costCents) || costCents < 0)) return { ok: false, code: "cost_invalid" };

    const verifier = text(verifierAgentId, 120);
    if (!verifier) {
      const blocked = { id: nextId("res"), taskId: assignment.taskId, agentId: assignment.agentId, status: "unverified", code: "independent_verification_required", evidence, changedFiles, tests, costCents, at: now() };
      results.push(blocked);
      record({ action: "result.unverified", assignmentId, taskId: assignment.taskId, code: blocked.code });
      return { ok: false, code: blocked.code, result: blocked };
    }
    if (verifier === assignment.agentId) {
      const refused = { id: nextId("res"), taskId: assignment.taskId, agentId: assignment.agentId, status: "unverified", code: "self_verification_refused", evidence, changedFiles, tests, costCents, at: now() };
      results.push(refused);
      record({ action: "result.self_verification_refused", assignmentId, taskId: assignment.taskId, agentId: assignment.agentId });
      return { ok: false, code: "self_verification_refused", result: refused };
    }
    const verifierAgent = agentMap.get(verifier);
    if (!verifierAgent) return { ok: false, code: "unknown_verifier" };
    if (!verifierAgent.capabilities.includes("verification")) return { ok: false, code: "verifier_lacks_capability" };
    const verificationTests = Number(verification?.tests?.ran || 0);
    const verificationEvidence = list(verification?.evidence);
    if (verificationTests < 1 || verificationEvidence.length === 0) {
      return { ok: false, code: "verification_evidence_required" };
    }

    const passed = status === "completed" && verification?.ok === true && tests.failed === 0 && verification?.tests?.failed === 0;
    const recordEntry = {
      id: nextId("res"),
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      verifierAgentId: verifier,
      status: passed ? "verified" : status === "completed" ? "unverified" : status,
      implementerStatus: status,
      evidence,
      verificationEvidence,
      changedFiles,
      tests,
      verificationTests: { ran: verificationTests, passed: Number(verification?.tests?.passed || 0), failed: Number(verification?.tests?.failed || 0) },
      costCents,
      costMeasured: costCents !== null,
      approvalRequired: true,
      approved: false,
      at: now()
    };
    results.push(recordEntry);
    assignments.set(assignment.id, { ...assignment, state: "completed", completedAt: now() });
    record({ action: "result.recorded", taskId: assignment.taskId, agentId: assignment.agentId, verifier, status: recordEntry.status });
    return { ok: true, result: recordEntry };
  }

  /**
   * How many workers to run, derived from workload, budget and a hard cap — not a fixed number.
   * Returns a count and the reason, and never exceeds the cap.
   */
  function recommendConcurrency({ queuedTasks = 0, availableCents = 0, costPerTaskCents = 0, hardCap = 8 } = {}) {
    const queued = Math.max(0, Math.floor(Number(queuedTasks) || 0));
    const cap = Math.max(1, Math.floor(Number(hardCap) || 1));
    if (queued === 0) return { ok: true, workers: 0, reason: "no_work" };
    const cost = Number(costPerTaskCents);
    if (!Number.isFinite(cost) || cost < 0) return { ok: false, code: "cost_per_task_invalid" };
    if (cost === 0) return { ok: true, workers: Math.min(queued, cap), reason: "free_work_capped_by_policy" };
    const affordable = Math.floor(Math.max(0, Number(availableCents) || 0) / cost);
    const workers = Math.min(queued, cap, affordable);
    return {
      ok: true,
      workers,
      reason: workers === 0 ? "budget_exhausted" : affordable < queued ? "budget_limited" : queued < cap ? "workload_limited" : "policy_cap",
      affordable
    };
  }

  function agents({ specialty = null, capability = null, healthyOnly = false } = {}) {
    return Array.from(agentMap.values())
      .filter(agent => (specialty ? agent.specialty === specialty : true))
      .filter(agent => (capability ? agent.capabilities.includes(capability) : true))
      .filter(agent => (healthyOnly ? agent.health.status === "healthy" : true))
      .map(agent => ({ ...agent, activeAssignments: activeFor(agent.id).length }));
  }

  return Object.freeze({
    registerAdapter,
    registerAgent,
    replaceAgent,
    removeAgent,
    healthCheck,
    assign,
    release,
    retry,
    handoff,
    finalize,
    recommendConcurrency,
    agents,
    adapters: () => Array.from(adapterMap.values()).map(({ execute, health, ...rest }) => rest),
    agent: id => agentMap.get(text(id, 120)) || null,
    assignments: () => Array.from(assignments.values()).map(item => ({ ...item })),
    results: () => results.map(item => ({ ...item })),
    history: () => audit.map(item => ({ ...item })),
    summarize: () => ({
      adapters: adapterMap.size,
      agents: agentMap.size,
      active: Array.from(assignments.values()).filter(item => item.state === "active").length,
      results: results.length,
      verified: results.filter(item => item.status === "verified").length,
      bySpecialty: Array.from(agentMap.values()).reduce((acc, agent) => {
        acc[agent.specialty] = (acc[agent.specialty] || 0) + 1;
        return acc;
      }, {})
    })
  });
}
