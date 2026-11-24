/**
 * The mission pipeline: one natural-language objective becomes a durable mission whose tasks run on the
 * real specialist workers.
 *
 * It composes components that already exist rather than replacing them:
 *
 *   universal-command-engine  the Ax command path: task identity, idempotency, priority, audit history
 *   ax-mission-engine         durable mission, dependency-aware tasks, approval separation, verification
 *   worker-executors          six real executors and an independent recomputing verifier
 *   self-heal                 bounded repair, escalation when a repair cannot be verified
 *
 * The only new logic here is the router: a mission task carries `requires` (capabilities) and a title, and
 * `missionJobFor` turns that into a concrete job for a real executor. Routing is deterministic and
 * refuses to guess — an unroutable task is blocked with `unroutable_task`, never executed as something
 * plausible-looking.
 */

import { createHash } from "node:crypto";
import { backoffFor, budgetState, classifyAction, classifyFailure } from "./ax-mission-policy.mjs";

const clean = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Boundary text that always needs the owner, whatever the task says. */
const CONSEQUENTIAL = /\b(deploy|deployment|production|publish|purchas|payment|refund|credential|secret|delete|drop table|merge to main)\b/i;

export const ROUTE_CAPABILITIES = Object.freeze({
  engineering: ["engineering", "repo_analysis"],
  testing: ["testing", "test_execution"],
  research: ["research", "corpus_search"],
  business: ["business", "economics"],
  content: ["content", "authoring"],
  operations: ["operations", "monitoring"]
});

/** Extract a real path mentioned in the task text, so the job runs the file the plan named. */
function pathFromText(text) {
  const test = /tests\/[A-Za-z0-9._/-]+\.test\.mjs/.exec(text);
  if (test) return test[0];
  const script = /(?:^|\s)((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs)/.exec(text);
  return script ? script[1] : null;
}

/**
 * Deterministic routing from a mission task to a real job.
 * @returns {{kind: string, ...}|null}
 */
export function missionJobFor({ task, mission } = {}) {
  if (!task) return null;
  const requires = Array.isArray(task.requires) ? task.requires : [];
  const text = [task.title, ...(task.criteria || []).map((index) => mission?.acceptanceCriteria?.[index]?.statement || "")].join(" ");
  const mentioned = pathFromText(text);

  if (requires.includes("testing")) {
    if (!mentioned || !/^tests\//.test(mentioned)) return null;
    return { kind: "tests", file: mentioned };
  }
  if (requires.includes("research")) {
    const quoted = /"([^"]{2,60})"/.exec(text)?.[1] || /'([^']{2,60})'/.exec(text)?.[1] || null;
    return { kind: "corpus-search", query: quoted || "escalation", dirs: ["docs"] };
  }
  if (requires.includes("operations")) return { kind: "ops-snapshot" };
  if (requires.includes("business")) {
    const items = Array.isArray(task.items) ? task.items : null;
    if (!items || items.length === 0) return null;
    return { kind: "economics", items, fixedCostCents: task.fixedCostCents || 0, targetMarginBps: task.targetMarginBps || 3000 };
  }
  if (requires.includes("content")) {
    return {
      kind: "brief",
      title: task.title || "Mission brief",
      sections: [{
        heading: "Objective",
        bullets: [mission?.objective || "", "Evidence comes from the tasks that ran before this one."]
      }],
      taskId: task.id
    };
  }
  if (requires.includes("engineering")) {
    if (mentioned && /\.mjs$/.test(mentioned)) return { kind: "syntax-check", file: mentioned };
    return { kind: "repo-analysis", dirs: ["tests"] };
  }
  return null;
}

/** Builders for the executor map the mission engine expects, keyed by adapter id. */
export function createMissionExecutors({ kit }) {
  if (!kit || typeof kit.compute !== "function" || typeof kit.verifyJob !== "function") {
    throw new Error("createMissionExecutors needs the worker executor kit.");
  }

  const adapterFor = (kind) => {
    if (kind === "tests") return "qa.tests";
    if (kind === "corpus-search") return "research.corpus";
    if (kind === "economics") return "biz.economics";
    if (kind === "brief") return "content.brief";
    if (kind === "ops-snapshot") return "ops.snapshot";
    return "eng.repo";
  };

  const execute = async ({ mission, task }) => {
    const job = missionJobFor({ task, mission });
    if (!job) {
      return { result: { status: "blocked", code: "unroutable_task", evidence: ["route:none@" + clean(task.id, 40) + "@requires=" + task.requires.join(",")], changedFiles: [], tests: { ran: 0, passed: 0, failed: 0 } } };
    }
    const outcome = await kit.compute({ ...job, taskId: task.id });
    return { result: outcome, route: adapterFor(job.kind) };
  };

  const verify = async ({ mission, task, implementation }) => {
    const job = missionJobFor({ task, mission });
    if (!job) return { ok: false, evidence: ["verifier:unroutable_task"], tests: { ran: 0, passed: 0, failed: 0 } };
    return kit.verifyJob(job, { taskId: task.id, implementation });
  };

  return Object.freeze({
    "eng.repo": execute,
    "qa.tests": execute,
    "research.corpus": execute,
    "biz.economics": execute,
    "content.brief": execute,
    "ops.snapshot": execute,
    "verifier.recompute": verify
  });
}

/** One agent per specialist, plus a separate verifier agent. */
export function registerMissionWorkforce({ workforce, specs, adapterIds = null }) {
  const registered = [];
  for (const spec of specs) {
    const result = workforce.registerAgent({
      id: spec.agentId,
      name: spec.specialty,
      specialty: spec.specialty,
      adapterId: spec.adapterId,
      capabilities: spec.capabilities,
      permissions: { allowed: spec.capabilities, denied: ["deploy", "purchase", "publish", "credential"] },
      availability: { maxConcurrent: spec.maxConcurrent || 2 }
    });
    registered.push({ agentId: spec.agentId, ok: result.ok, code: result.code || null, adapterId: spec.adapterId });
  }
  return registered;
}

export function pipelineFingerprint({ objective, idempotencyKey = null }) {
  return "mp:" + createHash("sha256").update(clean(objective, 2000) + "|" + clean(idempotencyKey, 200)).digest("hex").slice(0, 16);
}

/**
 * @param {object} options
 * @param {object} options.commandEngine   universal command engine (submit)
 * @param {object} options.missions        mission engine
 * @param {object} options.workforce       durable workforce
 * @param {object} options.kit             createWorkerExecutors result
 * @param {object} [options.healer]        createSelfHealer result
 * @param {Function} [options.now]
 */
export function createMissionPipeline({
  commandEngine = null,
  missions,
  store,
  workforce,
  kit,
  escalate = null,
  maxRepairs = 1,
  now = () => new Date().toISOString(),
  log = console
} = {}) {
  if (!missions || typeof missions.intake !== "function") throw new Error("The pipeline needs the mission engine.");
  if (!workforce || typeof workforce.agents !== "function") throw new Error("The pipeline needs the workforce.");

  /**
   * Accept one objective through the command path, then plan it as a durable mission.
   * The command task keeps its own identity, priority, dedupe and audit history; the mission records that
   * task id as a constraint, so the two records can always be traced to each other.
   */
  async function submit({
    objective,
    acceptanceCriteria,
    tasks = null,
    project = "habitat",
    constraints = [],
    priority = null,
    signals = null,
    idempotencyKey = null,
    submittedBy = "owner"
  } = {}) {
    const text = clean(objective, 2000);
    if (!text) return { ok: false, code: "objective_required" };
    const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.filter((item) => clean(item)) : [];
    if (criteria.length === 0) return { ok: false, code: "acceptance_criteria_required" };

    let commandTask = null;
    if (commandEngine) {
      const submitted = await commandEngine.submit({
        objective: text,
        requestedBy: submittedBy,
        role: "ax",
        idempotencyKey,
        priority,
        signals
      });
      if (!submitted.ok) return { ok: false, code: submitted.code || "command_submit_failed", detail: submitted.error || null };
      commandTask = submitted.task;
    }

    const planTasks = Array.isArray(tasks) ? tasks : null;
    if (planTasks) {
      for (const task of planTasks) {
        const policy = classifyAction(task);
        if (policy.class === "prohibited") return { ok: false, code: "prohibited_action", taskId: task.id };
        if (policy.requiresApproval && task.approvalRequired !== true) {
          return { ok: false, code: "approval_required_for_task", taskId: task.id };
        }
      }
    }
    if (CONSEQUENTIAL.test(text) && Array.isArray(acceptanceCriteria) && !Array.isArray(tasks)) {
      // Intake detects this itself and parks the mission at approval_required; nothing to do here.
    }

    const linked = [
      ...constraints,
      ...(commandTask ? ["command-task:" + commandTask.id] : [])
    ];
    const intake = await missions.intake(
      { project, objective: text, acceptanceCriteria: criteria, tasks: planTasks, constraints: linked },
      { submittedBy, idempotencyKey: idempotencyKey || (commandTask ? commandTask.id : null) }
    );
    if (!intake.ok) return intake;

    return {
      ok: true,
      replay: intake.replay === true,
      missionId: intake.missionId,
      commandTaskId: commandTask?.id || null,
      status: intake.mission?.status || null,
      tasks: (intake.mission?.tasks || []).map((task) => ({ id: task.id, requires: task.requires, dependsOn: task.dependsOn })),
      approvals: intake.approvals || [],
      at: now()
    };
  }

  /**
   * Drive a mission to a terminal state: execute, repair within the healer's budget, execute again.
   * Never returns a completed mission that the mission engine did not derive from verified tasks.
   */
  async function run(missionId, { maxRounds = 3, maxDurationMs = 10 * 60_000 } = {}) {
    const rounds = [];
    const escalations = [];
    const startedAt = Date.now();
    let last = null;
    let repairs = 0;
    let stopReason = null;
    for (let round = 1; round <= Math.max(1, maxRounds); round += 1) {
      // Owner control and budget are checked before any work starts, never after it has already run.
      const current = await missions.get(missionId);
      const status = (current?.record || current)?.status || null;
      if (status === "paused") { stopReason = "paused"; break; }
      if (status === "cancelled") { stopReason = "cancelled"; break; }
      const budget = budgetState({ startedAt, maxRounds: Math.max(1, maxRounds), roundsUsed: round - 1, maxRepairs, repairsUsed: repairs, maxDurationMs });
      if (budget.exhausted) { stopReason = budget.reason; break; }
      last = await missions.execute(missionId);
      rounds.push({ round, status: last.status, processed: last.processed, tasks: last.tasks });
      if (!last.ok || ["completed", "rejected", "approval_required"].includes(last.status)) break;

      // Bounded repair: requeue failed tasks only while the budget allows, never the ones that failed for a
      // reason a retry cannot change (no verifier, unroutable task, approval).
      if (!["failed", "verification_failed"].includes(last.status) || repairs >= maxRepairs || !store) break;
      const loaded = await missions.get(missionId);
      const mission = loaded?.record || null;
      if (!mission) break;
      const retryable = mission.tasks.filter((task) => task.status === "failed" && classifyFailure(task).retryable);
      if (retryable.length === 0) { stopReason = stopReason || "permanent_failure"; break; }
      repairs += 1;
      const retryDelayMs = backoffFor(repairs - 1);
      for (const task of retryable) {
        task.status = "pending";
        task.error = null;
        task.assignmentId = null;
        task.attempts += 1;
      }
      mission.status = "running";
      await store.save(mission, mission.version);
      rounds[rounds.length - 1].repair = { requeued: retryable.map((task) => task.id), attempt: repairs, retryDelayMs };
    }
    const final = await missions.get(missionId);
    const mission = final?.record || final || null;
    const result = {
      ok: Boolean(last?.ok),
      missionId,
      status: mission?.status || last?.status || null,
      rounds,
      repairs,
      stopReason: stopReason || (mission?.status === "completed" ? "completed" : mission?.status === "approval_required" ? "approval_required" : null),
      budget: { maxRounds: Math.max(1, maxRounds), maxDurationMs, elapsedMs: Math.max(0, Date.now() - startedAt), repairs },
      escalations,
      tasks: (mission?.tasks || []).map((task) => ({
        id: task.id,
        status: task.status,
        error: task.error,
        agentId: task.agentId,
        verifierAgentId: task.verifierAgentId,
        evidence: task.evidence,
        verificationEvidence: task.verificationEvidence,
        tests: task.tests
      })),
      objective: mission?.objective || null,
      commandTaskId: (mission?.constraints || []).find((item) => item.startsWith("command-task:"))?.slice("command-task:".length) || null,
      completedOnlyFromVerified: mission?.status === "completed"
        ? (mission.tasks || []).every((task) => task.status === "completed" && task.verifierAgentId)
        : null
    };

    // Anything not completed after the budget is escalated with the specific reason, once.
    if (result.status && !["completed", "approval_required", "rejected"].includes(result.status)) {
      const event = {
        missionId,
        code: result.status === "verification_failed" ? "verification_incomplete" : result.status,
        detail: result.tasks.filter((task) => task.status !== "completed").map((task) => task.id + ":" + (task.error || task.status)).join(",") || "no terminal cause recorded"
      };
      result.escalations.push(event);
      if (typeof escalate === "function") {
        try { await escalate(event); } catch (error) { log.error?.("MISSION_ESCALATION_FAILED", clean(error?.message, 120)); }
      }
    }
    return result;
  }

  return Object.freeze({ submit, run, events: (missionId) => missions.events(missionId) });
}
