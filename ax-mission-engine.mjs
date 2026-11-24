import { createHash } from "node:crypto";
import { criterionStatements } from "./ax-mission-plan.mjs";
import { approvalBinding, approvalSigningFields, classifyAction, executionGate, paramsFingerprint } from "./ax-mission-policy.mjs";

/**
 * Mission Execution Engine.
 *
 * A mission is a durable aggregate: objectives, requirements, acceptance criteria, risks, approvals,
 * milestones and dependency-aware tasks. Execution delegates each task to the existing workforce —
 * assignment, capacity, conflict detection, independent verification and approval separation are not
 * reimplemented here. This module contributes the mission lifecycle and nothing else.
 *
 * Three rules are enforced in code:
 *  - a task is `completed` only when the workforce recorded an independent `verified` result;
 *  - a mission with an unresolved approval never reports `completed`, whatever the tasks say;
 *  - a mission's acceptance criteria must all be covered by verified tasks, or the mission is
 *    `verification_failed` with the gaps listed.
 *
 * Nothing here calls a model. Planning is deterministic from the specification, so a plan is
 * reviewable and free; re-planning the same specification yields the same mission id.
 */

export const MISSION_STATUSES = Object.freeze([
  "planned", "running", "blocked", "verification_failed", "approval_required", "completed", "rejected", "failed"
]);
export const TASK_STATUSES = Object.freeze(["pending", "running", "completed", "failed", "blocked"]);

const APPROVAL_SIGNALS = Object.freeze([
  { re: /\b(deploy|deployment|release|production)\b/i, reason: "Deployment or production change" },
  { re: /\b(publish|post|upload|send|email)\b/i, reason: "Publishing or outbound communication" },
  { re: /\b(purchase|buy|spend|payment|invoice|charge|subscription)\b/i, reason: "Spending money" },
  { re: /\b(delete|drop|truncate|rotate|credential|secret|password)\b/i, reason: "Destructive or credential change" },
  { re: /\b(merge|main branch|main-branch)\b/i, reason: "Merging to the protected branch" }
]);

function clean(value, max = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function missionIdFor({ project = "habitat", objective = "", idempotencyKey = null } = {}) {
  const material = idempotencyKey ? String(idempotencyKey) : String(project) + "\u0000" + clean(objective, 2000);
  return "msn_" + createHash("sha256").update(material).digest("hex").slice(0, 24);
}

export function detectApprovals({ text = "" } = {}) {
  const found = [];
  for (const signal of APPROVAL_SIGNALS) {
    if (signal.re.test(text) && !found.some(item => item.reason === signal.reason)) {
      found.push({ reason: signal.reason, status: "pending", decidedAt: null, decidedBy: null });
    }
  }
  return found;
}

function detectCycle(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return trail.concat(id);
    state.set(id, "visiting");
    for (const dependency of byId.get(id)?.dependsOn || []) {
      const cycle = visit(dependency, trail.concat(id));
      if (cycle) return cycle;
    }
    state.set(id, "done");
    return null;
  };
  for (const task of tasks) {
    const cycle = visit(task.id, []);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Build and validate a plan. Explicit tasks are respected; otherwise a two-stage plan is derived:
 * assess the requirements, then implement and prove them.
 */
export function buildMissionPlan({ objective, acceptanceCriteria, tasks = null } = {}) {
  const criteria = criterionStatements(acceptanceCriteria);
  if (criteria.length === 0) return { ok: false, code: "acceptance_criteria_required" };
  if (!clean(objective)) return { ok: false, code: "objective_required" };

  const normalized = [];
  if (Array.isArray(tasks) && tasks.length > 0) {
    for (const [index, raw] of tasks.entries()) {
      if (!raw || typeof raw !== "object") return { ok: false, code: "task_not_object", index };
      const id = clean(raw.id, 60) || "t" + (index + 1);
      if (normalized.some(task => task.id === id)) return { ok: false, code: "duplicate_task_id", id };
      const requires = list(raw.requires).map(item => clean(item, 32)).filter(Boolean);
      normalized.push({
        id,
        title: clean(raw.title, 160) || id,
        requires: requires.length ? requires : ["coding"],
        dependsOn: list(raw.dependsOn).map(item => clean(item, 60)).filter(Boolean),
        criteria: list(raw.criteria).map(Number).filter(value => Number.isInteger(value) && value >= 0 && value < criteria.length),
        approvalRequired: raw.approvalRequired === true,
        // The authorization an owner signs must survive planning: dropping these would silently bind every
        // approval to a null target and a null parameter set.
        action: clean(raw.action, 200) || null,
        target: raw.target === undefined || raw.target === null ? null : clean(raw.target, 300) || null,
        params: raw.params && typeof raw.params === "object" ? raw.params : null
      });
    }
    for (const task of normalized) {
      for (const dependency of task.dependsOn) {
        if (!normalized.some(candidate => candidate.id === dependency)) return { ok: false, code: "unknown_dependency", task: task.id, dependency };
      }
    }
    const cycle = detectCycle(normalized);
    if (cycle) return { ok: false, code: "dependency_cycle", path: cycle };
  } else {
    const tail = criteria.map((_, index) => index).slice(1);
    normalized.push(
      { id: "t1", title: "Assess the requirements and collect evidence", requires: ["coding"], dependsOn: [], criteria: [0], approvalRequired: false },
      { id: "t2", title: "Implement and test the deliverable", requires: ["coding", "tests"], dependsOn: ["t1"], criteria: tail, approvalRequired: false }
    );
  }

  const covered = new Set(normalized.flatMap(task => task.criteria));
  const uncovered = criteria.map((statement, index) => ({ index, statement })).filter(item => !covered.has(item.index));
  if (uncovered.length > 0) return { ok: false, code: "criteria_unassigned", uncovered };

  // Milestones are dependency waves: everything with no unmet dependency is one milestone.
  const waves = [];
  const done = new Set();
  let remaining = normalized.slice();
  while (remaining.length) {
    const ready = remaining.filter(task => task.dependsOn.every(dependency => done.has(dependency)));
    if (ready.length === 0) return { ok: false, code: "dependency_cycle" };
    waves.push(ready.map(task => task.id));
    for (const task of ready) done.add(task.id);
    remaining = remaining.filter(task => !ready.includes(task));
  }

  return {
    ok: true,
    criteria,
    tasks: normalized.map(task => ({
      ...task,
      status: "pending",
      attempts: 0,
      assignmentId: null,
      agentId: null,
      verifierAgentId: null,
      evidence: [],
      verificationEvidence: [],
      tests: { ran: 0, passed: 0, failed: 0 },
      error: null
    })),
    milestones: waves.map((taskIds, index) => ({ id: "m" + (index + 1), title: "Milestone " + (index + 1), tasks: taskIds }))
  };
}

/** Workforce task ids allow letters, digits, dot, underscore and dash — not a colon. */
export function missionTaskKey(missionId, taskId) {
  return String(missionId) + "." + String(taskId);
}

function acceptanceGaps(mission) {
  const gaps = [];
  for (const [index, criterion] of (mission.acceptanceCriteria || []).entries()) {
    const covering = (mission.tasks || []).filter(task => task.criteria?.includes(index) && task.status === "completed");
    if (covering.length === 0) {
      gaps.push({ criterion: index, statement: criterion.statement, code: "not_covered" });
      continue;
    }
    if (!covering.some(task => task.tests.failed === 0 && task.evidence.length > 0)) {
      gaps.push({ criterion: index, statement: criterion.statement, code: "no_passing_evidence" });
    }
  }
  return gaps;
}

export function createMissionEngine({
  store,
  workforce,
  executors = {},
  verifierAgentId = null,
  ownerVerifier = null,
  maxAttempts = 2,
  maxTasksPerRun = 2,
  now = () => new Date().toISOString(),
  log = console
} = {}) {
  if (!store || typeof store.save !== "function") throw new Error("A mission engine needs a mission store.");
  if (!workforce || typeof workforce.assign !== "function") throw new Error("A mission engine needs the workforce.");

  const events = [];
  async function emit(missionId, type, payload = {}) {
    events.push({ missionId, type, at: now(), ...payload });
    if (typeof store.appendEvent === "function") {
      try { await store.appendEvent(missionId, type, payload); } catch (error) { log.error?.("MISSION_EVENT_FAILED", String(error?.message || error)); }
    }
  }

  async function persist(mission) {
    const result = await store.save(mission, mission.version);
    if (!result.ok) return result;
    Object.assign(mission, result.record);
    return result;
  }

  async function intake(spec = {}, { submittedBy = "owner", idempotencyKey = null } = {}) {
    const project = clean(spec.project, 64).toLowerCase() || "habitat";
    const objective = clean(spec.objective, 2000);
    if (!objective) return { ok: false, code: "objective_required" };
    const criteria = criterionStatements(spec.acceptanceCriteria);
    if (criteria.length === 0) return { ok: false, code: "acceptance_criteria_required" };

    const plan = buildMissionPlan({ objective, acceptanceCriteria: criteria, tasks: spec.tasks });
    if (!plan.ok) return plan;

    const id = missionIdFor({ project, objective, idempotencyKey });
    const at = now();
    const detected = detectApprovals({ text: [objective, ...criteria, ...list(spec.constraints)].join(" ") });
    // One approval per approval-required task, bound to the exact action it authorises. The fingerprint is
    // stored with the record, so an approval cannot be replayed for another mission, task or parameter set.
    // A signal detected in the objective is a mission-scope approval: it gates the mission and is bound to
    // the mission id, but it never authorises a particular task. Only a task-bound approval passes the gate.
    const approvals = detected.map((item) => (item.taskId
      ? item
      : {
          ...item,
          id: "apr:" + id + ":mission",
          missionId: id,
          taskId: null,
          scope: "mission",
          fingerprint: approvalBinding({ missionId: id, taskId: "mission", action: "mission:" + objective, target: null, params: null }),
          status: "pending",
          decision: null,
          requestedAt: at,
          expiresAt: new Date(Date.parse(at) + 30 * 60_000).toISOString()
        }));
    for (const task of plan.tasks) {
      if (task.approvalRequired !== true) continue;
      if (approvals.some((item) => item.taskId === task.id)) continue;
      const action = clean(task.title, 200) || "task:" + task.id;
      approvals.push({
        id: "apr:" + id + ":" + task.id,
        missionId: id,
        taskId: task.id,
        action,
        target: task.target === undefined ? null : task.target,
        params: task.params === undefined ? null : task.params,
        fingerprint: approvalBinding({ missionId: id, taskId: task.id, action, target: task.target ?? null, params: task.params ?? null }),
        status: "pending",
        decision: null,
        reason: "consequential_action",
        requestedAt: at,
        expiresAt: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
        decidedAt: null,
        decidedBy: null
      });
    }
    const record = {
      id,
      project,
      objective,
      requirements: list(spec.requirements).map(item => clean(item, 400)).filter(Boolean),
      acceptanceCriteria: criteria.map((statement, index) => ({ id: "c" + (index + 1), statement, required: true })),
      constraints: list(spec.constraints).map(item => clean(item, 300)).filter(Boolean),
      risks: list(spec.risks).map(item => clean(item, 300)).filter(Boolean),
      approvals,
      milestones: plan.milestones,
      tasks: plan.tasks,
      status: "planned",
      version: 1,
      submittedBy: clean(submittedBy, 64) || "owner",
      createdAt: at,
      updatedAt: at
    };

    const created = await store.create(record);
    if (!created.created) {
      return { ok: true, replay: true, missionId: created.record?.id || id, mission: created.record, approvals: created.record?.approvals || [] };
    }
    await emit(id, "mission.planned", { tasks: record.tasks.length, milestones: record.milestones.length, approvals: approvals.length });
    return { ok: true, replay: false, missionId: id, mission: record, approvals };
  }

  function agentFor(requires = []) {
    return workforce
      .agents({ capability: requires[0] })
      .filter(agent => requires.every(capability => agent.capabilities.includes(capability)))
      .filter(agent => !["unavailable", "degraded"].includes(agent.health?.status))
      .filter(agent => agent.availability?.accepting !== false)
      .sort((left, right) => (left.activeAssignments || 0) - (right.activeAssignments || 0) || left.id.localeCompare(right.id))[0] || null;
  }

  function pickVerifier(exclude) {
    if (verifierAgentId && verifierAgentId !== exclude && workforce.agent(verifierAgentId)?.capabilities.includes("verification")) return verifierAgentId;
    return workforce.agents({ capability: "verification" }).filter(agent => agent.id !== exclude)[0]?.id || null;
  }

  /** Reconcile a task whose assignment completed or vanished while the process was gone. */
  async function reconcile(mission) {
    const assignments = await workforce.assignments();
    const results = workforce.results();
    for (const task of mission.tasks) {
      if (task.status !== "running" || !task.assignmentId) continue;
      const assignment = assignments.find(item => item.id === task.assignmentId);
      const taskKey = missionTaskKey(mission.id, task.id);
      const result = results.find(item => item.taskId === taskKey);
      if (result) {
        task.status = result.status === "verified" ? "completed" : "failed";
        task.verifierAgentId = result.verifierAgentId || null;
        task.evidence = result.evidence || [];
        task.verificationEvidence = result.verificationEvidence || [];
        task.tests = result.tests || task.tests;
        task.error = task.status === "failed" ? result.code || result.status : null;
        continue;
      }
      if (!assignment || assignment.state !== "active") {
        task.attempts += 1;
        task.assignmentId = null;
        task.status = task.attempts > maxAttempts ? "failed" : "pending";
        task.error = task.status === "failed" ? "assignment_lost" : null;
        await emit(mission.id, task.status === "failed" ? "task.failed" : "task.requeued", { taskId: task.id, code: "assignment_lost", attempts: task.attempts });
      }
    }
  }

  async function runTask(mission, task) {
    // Mandatory security gate: the persisted task is re-validated immediately before any executor can run.
    // A refusal is durable evidence and an audit event; nothing below this point executes.
    const gate = executionGate({ mission, task, now: now() });
    if (!gate.ok) {
      task.status = "blocked";
      task.error = gate.code;
      task.evidence = [...(task.evidence || []), "approval:" + gate.code + "@" + (gate.fingerprint || "unbound")];
      await emit(mission.id, "task.approval_refused", {
        taskId: task.id,
        code: gate.code,
        action: gate.action,
        target: gate.target,
        fingerprint: gate.fingerprint,
        class: gate.class
      });
      return;
    }
    if (task.approvalRequired === true) {
      // The stored signature is re-verified against the record as it is now, without spending its nonce.
      const approval = (mission.approvals || []).find((item) => item.taskId === task.id && item.status === "approved");
      let signature = { ok: false, code: approval?.signed ? "approval_signature_invalid" : "approval_signature_missing" };
      if (approval?.signed && ownerVerifier && typeof ownerVerifier.verify === "function") {
        const signing = approvalSigningFields({
          mission,
          approval,
          // The stored decision is "approved"/"rejected"; the signed decision is "approve"/"reject".
          decision: approval.decision === "rejected" ? "reject" : "approve",
          owner: approval.decidedBy || "owner"
        });
        signature = ownerVerifier.verify(signing, approval.signed, { consumeReplay: false });
      } else if (approval?.signed) {
        signature = { ok: false, code: "owner_attestation_not_configured" };
      }
      if (!signature.ok) {
        task.status = "blocked";
        task.error = signature.code;
        task.evidence = [...(task.evidence || []), "signature:" + signature.code + "@" + (gate.fingerprint || "unbound")];
        await emit(mission.id, "task.signature_refused", {
          taskId: task.id, code: signature.code, fingerprint: gate.fingerprint, approvalId: approval?.id || null
        });
        return;
      }
      task.approval = { code: gate.code, fingerprint: gate.fingerprint, decidedBy: gate.decidedBy, grantedAt: gate.grantedAt };
      await emit(mission.id, "task.approval_cleared", { taskId: task.id, fingerprint: gate.fingerprint });
    }
    let assignmentId = task.assignmentId;
    let agent = task.agentId ? workforce.agent(task.agentId) : null;
    if (!assignmentId) {
      agent = agentFor(task.requires);
      if (!agent) {
        task.status = "blocked";
        task.error = "no_eligible_agent";
        return;
      }
      const assigned = await workforce.assign({
        taskId: missionTaskKey(mission.id, task.id),
        agentId: agent.id,
        requires: task.requires,
        workspaceKey: "mission/" + mission.id + "/" + task.id
      });
      if (!assigned.ok) {
        task.status = "blocked";
        task.error = assigned.code;
        return;
      }
      assignmentId = assigned.assignmentId;
      task.assignmentId = assignmentId;
      task.agentId = agent.id;
      task.attempts += 1;
      task.status = "running";
      await emit(mission.id, "task.assigned", { taskId: task.id, agentId: agent.id, assignmentId });
      await persist(mission);
    } else {
      agent = agent || workforce.agent(task.agentId);
      if (!agent || ["unavailable", "degraded"].includes(agent.health?.status)) {
        task.status = "blocked";
        task.error = "agent_unavailable";
        return;
      }
    }

    const execute = executors[agent.adapterId];
    if (typeof execute !== "function") {
      task.status = "blocked";
      task.error = "executor_unavailable";
      return;
    }
    let implementation;
    try {
      implementation = await execute({ mission, task, agent });
    } catch (error) {
      const retried = await workforce.retry({ assignmentId, maxAttempts, reason: clean(error?.message, 120) || "executor_failed" });
      if (retried.ok) {
        task.attempts += 1;
        task.assignmentId = retried.assignment?.id || assignmentId;
        task.status = "running";
        task.error = "retrying";
        await emit(mission.id, "task.retry", { taskId: task.id, attempts: task.attempts });
        return;
      }
      task.status = "failed";
      task.error = "attempts_exhausted";
      task.assignmentId = null;
      await emit(mission.id, "task.failed", { taskId: task.id, code: task.error });
      return;
    }

    const verifier = pickVerifier(agent.id);
    if (!verifier) {
      task.status = "failed";
      task.error = "no_independent_verifier";
      await emit(mission.id, "task.failed", { taskId: task.id, code: task.error });
      return;
    }
    const verify = executors[workforce.agent(verifier)?.adapterId];
    let verification = null;
    if (typeof verify === "function") {
      try {
        verification = await verify({ mission, task, agent: workforce.agent(verifier), implementation });
      } catch (error) {
        verification = { ok: false, evidence: ["verifier failed: " + clean(error?.message, 120)], tests: { ran: 0, passed: 0, failed: 1 } };
      }
    }
    if (!verification) {
      task.status = "failed";
      task.error = "verification_unavailable";
      return;
    }

    const result = implementation?.result || implementation || {};
    const finalized = await workforce.finalize({
      assignmentId,
      result: {
        status: result.status || "completed",
        evidence: result.evidence || [],
        changedFiles: result.changedFiles || [],
        tests: result.tests || { ran: 0, passed: 0, failed: 0 },
        costCents: result.costCents === undefined ? null : result.costCents
      },
      verifierAgentId: verifier,
      verification: {
        ok: verification.ok === true,
        evidence: verification.evidence || [],
        tests: verification.tests || { ran: 0, passed: 0, failed: 0 }
      }
    });

    const record = finalized.result || null;
    task.verifierAgentId = verifier;
    task.evidence = record?.evidence || result.evidence || [];
    task.verificationEvidence = record?.verificationEvidence || verification.evidence || [];
    task.tests = record?.tests || result.tests || task.tests;
    if (finalized.ok && record?.status === "verified") {
      task.status = "completed";
      task.error = null;
      await emit(mission.id, "task.verified", { taskId: task.id, verifier, tests: task.tests });
    } else {
      task.status = "failed";
      task.error = finalized.code || record?.code || "verification_failed";
      await emit(mission.id, "task.failed", { taskId: task.id, code: task.error });
    }
  }

  function deriveStatus(mission) {
    const blocked = mission.tasks.filter(task => task.status === "blocked");
    if (blocked.length) return "blocked";
    const failed = mission.tasks.filter(task => task.status === "failed");
    if (failed.length) {
      return failed.every(task => task.error === "verification_failed") ? "verification_failed" : "failed";
    }
    // A task the plan marked owner-required has not run, and it must not read as "still running" while an
    // approval is pending: the mission is waiting on the owner, not on work.
    const gated = mission.tasks.some(task => task.approvalRequired === true && task.status !== "completed");
    const awaitingOwner = (mission.approvals || []).some(item => item.status === "pending");
    if (gated && awaitingOwner) return "approval_required";
    if (mission.tasks.some(task => task.status !== "completed")) return "running";
    const gaps = acceptanceGaps(mission);
    if (gaps.length) return "verification_failed";
    const pending = (mission.approvals || []).some(item => item.status === "pending");
    return pending ? "approval_required" : "completed";
  }

  async function execute(missionId, { maxTasks = maxTasksPerRun } = {}) {
    const loaded = await store.get(missionId);
    if (!loaded) return { ok: false, code: "mission_not_found" };
    const mission = loaded.record;
    if (["completed", "rejected"].includes(mission.status)) return { ok: true, skipped: true, mission };
    if (mission.status === "approval_required") return { ok: true, skipped: true, code: "approval_pending", mission };

    await reconcile(mission);
    // A worker that was unavailable is retryable once it returns; the task itself is not at fault.
    for (const task of mission.tasks) {
      if (task.status === "blocked" && ["no_eligible_agent", "agent_unavailable", "executor_unavailable"].includes(task.error)) {
        task.status = "pending";
        task.error = null;
      }
    }
    mission.status = deriveStatus(mission);
    await persist(mission);
    await emit(mission.id, "mission.run", { status: mission.status });

    const limits = Math.max(1, Math.min(5, Number(maxTasks) || 1));
    let processed = 0;
    while (processed < limits) {
      const ready = mission.tasks.find(task => ["pending", "running"].includes(task.status) &&
        task.dependsOn.every(dependency => mission.tasks.find(item => item.id === dependency)?.status === "completed"));
      if (!ready) break;
      // A task the plan itself marks as owner-required must never start. Work that has not begun cannot be
      // mistakenly described as done, and the mission parks at approval_required for a signed decision.
      // Only this task's approval, or a mission-scope signal, parks this task. Another task's pending
      // approval must not block work the owner already authorised.
      const taskPending = (mission.approvals || []).some(item => item.taskId === ready.id && item.status === "pending");
      const missionPending = (mission.approvals || []).some(item => !item.taskId && item.status === "pending");
      if (ready.approvalRequired === true && (taskPending || missionPending)) {
        mission.status = "approval_required";
        await emit(mission.id, "mission.approval_gate", { taskId: ready.id });
        break;
      }
      processed += 1;
      await runTask(mission, ready);
      mission.status = deriveStatus(mission);
      await persist(mission);
      if (["blocked", "failed"].includes(mission.status)) break;
    }

    mission.status = deriveStatus(mission);
    const gaps = mission.status === "verification_failed" ? acceptanceGaps(mission) : [];
    if (mission.status === "approval_required") await emit(mission.id, "mission.approval_required", { approvals: mission.approvals.length });
    if (mission.status === "completed") await emit(mission.id, "mission.completed", { tasks: mission.tasks.length });
    if (mission.status === "blocked") await emit(mission.id, "mission.blocked", { code: mission.tasks.find(task => task.status === "blocked")?.error || null });
    await persist(mission);
    return {
      ok: true,
      missionId: mission.id,
      status: mission.status,
      processed,
      tasks: mission.tasks.map(task => ({ id: task.id, status: task.status, error: task.error })),
      gaps
    };
  }

  async function recover({ limit = 10 } = {}) {
    const active = (await Promise.all(["running", "planned", "blocked", "failed"].map(status => store.list({ status, limit })))).flat();
    const results = [];
    for (const mission of active.slice(0, limit)) {
      results.push(await execute(mission.id));
    }
    return { ok: true, recovered: results.length, results };
  }

  async function approve({ missionId, decision = "approve", by = "owner", attestation = null, reason = null, taskId = null, approvalId = null } = {}) {
    if (!["approve", "reject"].includes(decision)) return { ok: false, code: "decision_invalid" };
    const loaded = await store.get(missionId);
    if (!loaded) return { ok: false, code: "mission_not_found" };
    const mission = loaded.record;
    // Decisions may be taken one at a time: mission-scope first, then each named task. A running mission with
    // pending approvals can still take the next decision, but nothing else can.
    const hasPending = (mission.approvals || []).some((item) => item.status === "pending");
    if (mission.status !== "approval_required" && !(mission.status === "running" && hasPending)) {
      return { ok: false, code: "approval_not_required", status: mission.status };
    }
    // Shared replay protection. Missions persist the nonce each approval was signed with, so a second
    // instance refuses reuse. If the shared store cannot answer, the decision fails closed.
    if (attestation && typeof attestation.nonce === "string") {
      if (typeof store.nonceUsed !== "function") return { ok: false, code: "owner_attestation_replay_unavailable" };
      try {
        if (await store.nonceUsed(attestation.nonce)) return { ok: false, code: "owner_attestation_replayed" };
      } catch {
        return { ok: false, code: "owner_attestation_replay_unavailable" };
      }
    }

    // A decision names exactly one authorization. It never sweeps up unrelated task approvals: one signature
    // must not authorise work the owner did not see.
    const selected = mission.approvals.filter((item) => {
      if (approvalId) return item.id === approvalId;
      if (taskId) return item.taskId === taskId;
      return !item.taskId && item.status === "pending";
    });
    if (selected.length === 0) return { ok: false, code: "approval_not_found" };
    if (selected.length > 1) return { ok: false, code: "approval_ambiguous" };
    for (const approval of selected) {
      // Bind the decision to the task as persisted right now, so an approval for an old plan cannot authorise
      // the changed one. Missing bindings are recomputed rather than trusted.
      const task = mission.tasks.find((item) => item.id === approval.taskId) || null;
      if (task) {
        const action = clean(task.action || task.title, 200);
        approval.action = action;
        approval.target = task.target === undefined ? null : task.target;
        approval.params = task.params === undefined ? null : task.params;
        approval.fingerprint = approvalBinding({ missionId: mission.id, taskId: task.id, action, target: approval.target, params: approval.params });
      }
      // Cryptographic binding. The signature must cover the persisted authorization exactly: mission,
      // approval, decision, action class, target, canonical parameters, expiry and owner. Missing signer
      // configuration fails closed; there is no unsigned path for a consequential decision.
      if (!ownerVerifier || typeof ownerVerifier.verify !== "function") {
        return { ok: false, code: "owner_attestation_not_configured" };
      }
      const signing = approvalSigningFields({
        mission,
        approval,
        decision: decision === "approve" ? "approve" : "reject",
        owner: clean(by, 64) || "owner"
      });
      const verified = ownerVerifier.verify(signing, attestation);
      if (!verified.ok) return { ok: false, code: verified.code || "owner_attestation_invalid" };
      if (decision === "approve") {
        const expiresAt = Date.parse(String(approval.expiresAt || ""));
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now())) {
          return { ok: false, code: "approval_expired" };
        }
      }
      approval.signed = {
        v: attestation?.v ?? null,
        keyId: verified.keyId || attestation?.keyId || null,
        issuedAt: attestation?.issuedAt || null,
        nonce: attestation?.nonce || null,
        mac: attestation?.mac || null,
        statement: signing.statement
      };
      approval.status = decision === "approve" ? "approved" : "rejected";
      approval.decision = decision === "approve" ? "approved" : "rejected";
      approval.decidedAt = now();
      approval.decidedBy = clean(by, 64) || "owner";
      if (decision === "approve") {
        // The expiry is the one that was signed. Extending it here would silently invalidate the signature
        // (and silently extend the owner's grant); a stale approval needs a fresh request and signature.
        approval.grantedAt = now();
      }
    }
    // An approved mission becomes runnable; it is never marked completed by a signature alone.
    mission.status = decision === "approve" ? "running" : "rejected";
    const saved = await persist(mission);
    if (!saved.ok) return { ok: false, code: saved.code };
    await emit(mission.id, decision === "approve" ? "mission.approved" : "mission.rejected", { by: clean(by, 64) || "owner" });
    return { ok: true, status: mission.status, mission };
  }

  /**
   * Withdraw a grant before it is used. The approval record is kept (the audit trail matters), marked revoked,
   * and the execution gate refuses it with `approval_revoked`.
   */
  async function revoke({ missionId, taskId = null, approvalId = null, by = "owner", reason = null } = {}) {
    const loaded = await store.get(missionId);
    if (!loaded) return { ok: false, code: "mission_not_found" };
    const mission = loaded.record;
    const selected = mission.approvals.filter((item) =>
      (approvalId && item.id === approvalId) || (taskId && item.taskId === taskId));
    if (selected.length === 0) return { ok: false, code: "approval_not_found" };
    for (const approval of selected) {
      approval.status = "revoked";
      approval.decision = "revoked";
      approval.revokedAt = now();
      approval.revokedBy = clean(by, 64) || "owner";
      approval.revokeReason = clean(reason, 200) || null;
    }
    const saved = await persist(mission);
    if (!saved.ok) return { ok: false, code: saved.code };
    await emit(mission.id, "mission.approval_revoked", {
      taskId, approvalId, by: clean(by, 64) || "owner", reason: clean(reason, 200) || null
    });
    return { ok: true, revoked: selected.map((item) => item.id), mission };
  }

  /**
   * The owner-facing signing view. Returns exactly the statement the engine will verify, plus the context
   * Habitat needs to display a decision: task, action class, target, parameter fingerprint, expiry and status.
   * It never reads or returns key material.
   */
  async function authorizations({ missionId } = {}) {
    const loaded = await store.get(missionId);
    if (!loaded) return { ok: false, code: "mission_not_found" };
    const mission = loaded.record;
    const entries = (mission.approvals || []).map((approval) => {
      const task = approval.taskId ? (mission.tasks || []).find((item) => item.id === approval.taskId) || null : null;
      const decision = approval.decision === "rejected" ? "reject" : "approve";
      const fields = approvalSigningFields({ mission, approval, decision, owner: approval.decidedBy || "owner" });
      const policy = task ? classifyAction(task) : { class: "mission" };
      return {
        missionId: mission.id,
        approvalId: approval.id || null,
        taskId: approval.taskId || null,
        taskTitle: task?.title || null,
        description: task?.title || "Mission-level authorization: " + clean(mission.objective, 200),
        actionClass: policy.class,
        action: task ? clean(task.action || task.title, 200) : clean(approval.action, 200),
        target: task ? (task.target ?? null) : null,
        parameters: task ? paramsFingerprint(task.params ?? null) : null,
        expiresAt: approval.expiresAt || null,
        status: approval.status || "pending",
        decidedBy: approval.decidedBy || null,
        decidedAt: approval.decidedAt || null,
        reason: approval.reason || null,
        signature: approval.signed ? { keyId: approval.signed.keyId, issuedAt: approval.signed.issuedAt, nonce: approval.signed.nonce } : null,
        statement: approval.signed?.statement || fields.statement,
        // The signed statement includes the decision, so the view offers both; nothing else differs.
        rejectStatement: approval.signed?.statement || approvalSigningFields({ mission, approval, decision: "reject", owner: approval.decidedBy || "owner" }).statement
      };
    });
    return {
      ok: true,
      missionId: mission.id,
      missionStatus: mission.status,
      pending: entries.filter((entry) => entry.status === "pending"),
      history: entries,
      generatedAt: now()
    };
  }

  async function summary() {
    const counts = typeof store.counts === "function" ? await store.counts() : { total: 0, byStatus: {} };
    return { ok: true, ...counts };
  }

  return Object.freeze({
    intake,
    execute,
    recover,
    approve,
    revoke,
    authorizations,
    list: options => store.list(options),
    get: id => store.get(id),
    status: summary,
    events: missionId => store.events(missionId),
    _events: events
  });
}

export const MISSION_FLAG = "HABITAT_MISSIONS_ENABLED";
export const MISSION_MIGRATION = "0011_ax_missions";
