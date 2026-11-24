import test from "node:test";
import assert from "node:assert/strict";
import { createWorkforce } from "../ax-workforce.mjs";

const NOW = "2026-11-24T12:00:00.000Z";
const now = () => NOW;

function build({ health = "healthy" } = {}) {
  const workforce = createWorkforce({ now, log: { error() {}, warn() {}, log() {} } });
  workforce.registerAdapter({
    id: "freebuff-cli",
    kind: "coding",
    execute: async () => ({ ok: true }),
    health: async () => ({ status: health })
  });
  workforce.registerAdapter({
    id: "nexus-local",
    kind: "coding",
    execute: async () => ({ ok: true }),
    health: async () => ({ status: "healthy" })
  });
  workforce.registerAdapter({
    id: "qa-checker",
    kind: "verification",
    execute: async () => ({ ok: true })
  });
  workforce.registerAgent({
    id: "coder.freebuff",
    name: "Freebuff coder",
    specialty: "coding",
    adapterId: "freebuff-cli",
    capabilities: ["coding", "tests"],
    permissions: { allowed: ["coding"], denied: ["deploy"] },
    limits: { maxTaskCents: 500 },
    workspace: { isolation: "git-worktree", root: "/tmp/work", branchPattern: "agent/{task}" },
    availability: { maxConcurrent: 1 }
  });
  workforce.registerAgent({
    id: "coder.nexus",
    name: "NEXUS coder",
    specialty: "coding",
    adapterId: "nexus-local",
    capabilities: ["coding"],
    permissions: { allowed: ["coding"], denied: [] },
    workspace: { isolation: "git-worktree", root: "/tmp/work" },
    availability: { maxConcurrent: 2 }
  });
  workforce.registerAgent({
    id: "verifier.pr",
    name: "Verifier",
    specialty: "verification",
    adapterId: "qa-checker",
    capabilities: ["verification"],
    permissions: { allowed: ["verification"], denied: [] },
    availability: { maxConcurrent: 3 }
  });
  return workforce;
}

test("an agent cannot exist without an adapter, capabilities and permissions", () => {
  const w = build();
  assert.equal(w.registerAgent({ id: "x.one", specialty: "coding", capabilities: ["coding"], permissions: { allowed: ["coding"], denied: [] } }).code, "unknown_adapter");
  assert.equal(w.registerAgent({ id: "x.two", specialty: "coding", adapterId: "freebuff-cli", permissions: { allowed: ["coding"], denied: [] } }).code, "agent_capabilities_required");
  assert.equal(w.registerAgent({ id: "x.three", specialty: "coding", adapterId: "freebuff-cli", capabilities: ["coding"], permissions: { allowed: [], denied: [] } }).code, "permissions_required");
  assert.equal(w.registerAgent({ id: "x.four", specialty: "coding", adapterId: "freebuff-cli", capabilities: ["coding"], permissions: { allowed: ["coding"], denied: [] }, availability: { maxConcurrent: 0 } }).code, "availability_invalid");
});

test("two agents of the same specialty are independent records", () => {
  const w = build();
  const coders = w.agents({ specialty: "coding" });
  assert.equal(coders.length, 2);
  assert.notEqual(coders[0].adapterId, coders[1].adapterId);
  assert.equal(w.summarize().bySpecialty.coding, 2);
});

test("assignment refuses a second task beyond the agent's capacity", () => {
  const w = build();
  assert.equal(w.assign({ taskId: "task-1", agentId: "coder.freebuff" }).ok, true);
  const second = w.assign({ taskId: "task-2", agentId: "coder.freebuff" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "agent_at_capacity");
});

test("a missing capability and a denied permission are different refusals", () => {
  const w = build();
  assert.equal(w.assign({ taskId: "task-1", agentId: "coder.nexus", requires: ["coding", "research"] }).code, "capability_missing");
  const denied = w.assign({ taskId: "task-2", agentId: "coder.freebuff", requires: ["deploy"] });
  assert.equal(denied.code, "capability_missing", "deploy is not in the capability list either");
});

test("an unhealthy agent is not assigned work", async () => {
  const w = build({ health: "unavailable" });
  await w.healthCheck("coder.freebuff");
  assert.equal(w.assign({ taskId: "task-1", agentId: "coder.freebuff" }).code, "agent_unavailable");
});

test("an adapter without a health probe reports unknown rather than healthy", async () => {
  const w = build();
  const probe = await w.healthCheck("verifier.pr");
  assert.equal(probe.ok, false);
  assert.equal(probe.code, "health_probe_missing");
  assert.equal(probe.health.status, "unknown");
});

test("two tasks cannot claim the same workspace branch", () => {
  const w = build();
  assert.equal(w.assign({ taskId: "task-1", agentId: "coder.freebuff", workspaceKey: "agent/task-1" }).ok, true);
  const clash = w.assign({ taskId: "task-2", agentId: "coder.nexus", workspaceKey: "agent/task-1" });
  assert.equal(clash.code, "workspace_conflict");
  assert.equal(w.assign({ taskId: "task-3", agentId: "coder.nexus", workspaceKey: "agent/task-3" }).ok, true, "separate branches run in parallel");
});

test("overlapping file scopes are a conflict, separate ones are not", () => {
  const w = build();
  // No workspace key: the work shares one tree, so the file scopes are what must not overlap.
  w.assign({ taskId: "task-1", agentId: "coder.freebuff", scopes: ["src/server"] });
  const clash = w.assign({ taskId: "task-2", agentId: "coder.nexus", scopes: ["src/server/routes.mjs"] });
  assert.equal(clash.code, "scope_conflict");
  assert.equal(w.assign({ taskId: "task-3", agentId: "coder.nexus", scopes: ["docs"] }).ok, true);
});

test("retry counts attempts and then exhausts instead of looping", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  assert.equal(w.retry({ assignmentId, maxAttempts: 2 }).assignment.attempts, 2);
  const exhausted = w.retry({ assignmentId, maxAttempts: 2 });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, "attempts_exhausted");
  assert.equal(w.assignments().find(item => item.id === assignmentId).state, "exhausted");
});

test("handoff moves the work and keeps the original assignment in history", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.freebuff", workspaceKey: "agent/task-1" });
  const moved = w.handoff({ taskId: "task-1", fromAgentId: "coder.freebuff", toAgentId: "coder.nexus", reason: "provider outage" });
  assert.equal(moved.ok, true);
  assert.equal(moved.from.state, "handed_off");
  assert.equal(moved.to.agentId, "coder.nexus");
  assert.equal(w.assignments().find(item => item.id === assignmentId).state, "handed_off");
  assert.match(w.history().find(item => item.action === "assignment.handed_off").reason, /provider outage/);
});

test("the provider behind an agent can be replaced without touching assignments", () => {
  const w = build();
  const replaced = w.replaceAgent("coder.freebuff", { adapterId: "nexus-local" });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.agent.adapterId, "nexus-local");
  assert.equal(replaced.agent.revision, 2);
  assert.equal(w.assign({ taskId: "task-1", agentId: "coder.freebuff" }).ok, true);
  const busy = w.replaceAgent("coder.freebuff", { adapterId: "freebuff-cli" });
  assert.equal(busy.code, "agent_busy", "a busy worker is not swapped underneath its task");
});

test("removing an agent keeps its results and history", () => {
  const w = build();
  w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const { id: assignmentId } = w.assignments()[0];
  w.finalize({
    assignmentId,
    result: { status: "completed", evidence: ["patch.diff"], changedFiles: ["a.mjs"], tests: { ran: 2, passed: 2, failed: 0 }, costCents: 12 },
    verifierAgentId: "verifier.pr",
    verification: { ok: true, evidence: ["npm test 2/2"], tests: { ran: 2, passed: 2, failed: 0 } }
  });
  w.release({ assignmentId, state: "released" });
  const removed = w.removeAgent("coder.nexus");
  assert.equal(removed.ok, true);
  assert.equal(removed.historyRetained, true);
  assert.equal(w.results().length, 1, "the result survives the worker");
  assert.ok(w.history().some(item => item.action === "agent.removed"));
});

test("a result without evidence is refused", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const outcome = w.finalize({ assignmentId, result: { status: "completed", evidence: [] } });
  assert.equal(outcome.code, "evidence_required");
});

test("an agent may not verify its own work", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const outcome = w.finalize({
    assignmentId,
    result: { status: "completed", evidence: ["patch.diff"], changedFiles: ["a.mjs"], tests: { ran: 1, passed: 1, failed: 0 } },
    verifierAgentId: "coder.nexus",
    verification: { ok: true, evidence: ["self check"], tests: { ran: 1, passed: 1, failed: 0 } }
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "self_verification_refused");
  assert.equal(w.results()[0].status, "unverified");
});

test("a verifier without the verification capability is refused", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const outcome = w.finalize({
    assignmentId,
    result: { status: "completed", evidence: ["patch.diff"] },
    verifierAgentId: "coder.freebuff",
    verification: { ok: true, evidence: ["x"], tests: { ran: 1, passed: 1, failed: 0 } }
  });
  assert.equal(outcome.code, "verifier_lacks_capability");
});

test("verification without a run test is not verification", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const outcome = w.finalize({
    assignmentId,
    result: { status: "completed", evidence: ["patch.diff"] },
    verifierAgentId: "verifier.pr",
    verification: { ok: true, evidence: ["looks fine"], tests: { ran: 0, passed: 0, failed: 0 } }
  });
  assert.equal(outcome.code, "verification_evidence_required");
});

test("an independently verified result carries evidence, tests, cost and needs approval", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const outcome = w.finalize({
    assignmentId,
    result: { status: "completed", evidence: ["patch.diff", "npm run check exit 0"], changedFiles: ["ax-workforce.mjs"], tests: { ran: 1036, passed: 1036, failed: 0 }, costCents: 48 },
    verifierAgentId: "verifier.pr",
    verification: { ok: true, evidence: ["node --test 16/16"], tests: { ran: 16, passed: 16, failed: 0 } }
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.status, "verified");
  assert.equal(outcome.result.approvalRequired, true);
  assert.equal(outcome.result.approved, false, "verification is not approval");
  assert.equal(outcome.result.costMeasured, true);
  assert.deepEqual(outcome.result.changedFiles, ["ax-workforce.mjs"]);
});

test("a failing verification leaves the result unverified, never verified", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const outcome = w.finalize({
    assignmentId,
    result: { status: "completed", evidence: ["patch.diff"], tests: { ran: 3, passed: 2, failed: 1 } },
    verifierAgentId: "verifier.pr",
    verification: { ok: false, evidence: ["3 tests, 1 failed"], tests: { ran: 3, passed: 2, failed: 1 } }
  });
  assert.equal(outcome.result.status, "unverified");
});

test("an unmeasurable cost is recorded as null, not as zero", () => {
  const w = build();
  const { assignmentId } = w.assign({ taskId: "task-1", agentId: "coder.nexus" });
  const outcome = w.finalize({
    assignmentId,
    result: { status: "completed", evidence: ["patch.diff"], costCents: null },
    verifierAgentId: "verifier.pr",
    verification: { ok: true, evidence: ["tests"], tests: { ran: 1, passed: 1, failed: 0 } }
  });
  assert.equal(outcome.result.costMeasured, false);
  assert.equal(outcome.result.costCents, null);
});

test("worker count is derived from work, budget and a hard cap", () => {
  const w = build();
  assert.equal(w.recommendConcurrency({ queuedTasks: 0 }).workers, 0);
  assert.equal(w.recommendConcurrency({ queuedTasks: 4, availableCents: 0, costPerTaskCents: 100 }).reason, "budget_exhausted");
  assert.equal(w.recommendConcurrency({ queuedTasks: 10, availableCents: 250, costPerTaskCents: 100 }).workers, 2);
  assert.equal(w.recommendConcurrency({ queuedTasks: 10, availableCents: 100000, costPerTaskCents: 100, hardCap: 3 }).workers, 3);
  assert.equal(w.recommendConcurrency({ queuedTasks: 2, availableCents: 100000, costPerTaskCents: 0 }).reason, "free_work_capped_by_policy");
});
