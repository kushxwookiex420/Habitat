import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkforceRepository } from "../d1-workforce-repository.mjs";
import { createDurableWorkforce } from "../ax-durable-workforce.mjs";
import { createWorkforceRunner } from "../ax-workforce-runner.mjs";
import { createSelfHealer, diagnoseExecution, improvementTasks } from "../self-heal.mjs";

const NOW = "2026-11-24T12:00:00.000Z";
const now = () => NOW;
const quiet = { log() {}, warn() {}, error() {} };

function queryFrom(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };
}

function state({ agents = [], assignments = [], results = [] } = {}) {
  return { agents, assignments, results };
}

test("diagnosis names the cause and the safe action, and invents nothing when the record is clean", () => {
  const clean = diagnoseExecution(state({
    agents: [{ id: "w1", adapterId: "a1", capabilities: ["coding", "verification"], health: { status: "healthy" } }],
    results: [{ taskId: "t1", agentId: "w1", status: "verified" }]
  }));
  assert.deepEqual(clean, []);

  const findings = diagnoseExecution(state({
    agents: [{ id: "w1", adapterId: "a1", capabilities: ["coding"], health: { status: "degraded" } }],
    assignments: [{ id: "asg1", taskId: "t-orphan", agentId: "gone", state: "active" }],
    results: [
      { taskId: "t2", agentId: "w1", status: "failed", code: "executor_error" },
      { taskId: "t3", agentId: "w1", status: "failed", code: "executor_error" },
      { taskId: "t4", agentId: "w1", status: "unverified" }
    ]
  }));
  const codes = findings.map((finding) => finding.code);
  assert.ok(codes.includes("orphaned_assignment"));
  assert.ok(codes.includes("agent_unhealthy"));
  assert.ok(codes.includes("adapter_failing_repeatedly"));
  assert.ok(codes.includes("verification_gap"));
  assert.ok(codes.includes("no_verifier"), "nobody can verify is itself a finding");
  assert.equal(findings.filter((finding) => finding.code === "task_failed").length, 2);
});

test("improvement tasks are deduplicated by fingerprint so a recurring finding does not pile up", () => {
  const findings = diagnoseExecution(state({
    agents: [{ id: "w1", adapterId: "a1", capabilities: ["verification"], health: { status: "unavailable" } }],
    results: [{ taskId: "t1", agentId: "w1", status: "failed", code: "x" }]
  }));
  const first = improvementTasks(findings);
  assert.ok(first.length >= 2);
  assert.equal(new Set(first.map((task) => task.fingerprint)).size, first.length);

  const second = improvementTasks(findings, { existing: first });
  assert.equal(second.length, 0, "the same finding produces no second task");
});

/** A workforce whose executor fails until `jobs.fixed` flips, which is what a real repair changes. */
async function harness({ withVerifier = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const repository = createWorkforceRepository({ query: queryFrom(db), now });
  await repository.initialize();
  const health = { status: "healthy" };

  const jobs = { t1: { broken: true } };
  const executors = {
    "work.repo": async ({ taskId }) => ({
      result: jobs[taskId]?.broken
        ? { status: "failed", code: "job_broken", evidence: ["job:failed@t1"], changedFiles: [], tests: { ran: 0, passed: 0, failed: 0 } }
        : { status: "completed", evidence: ["job:ok@t1"], changedFiles: [], tests: { ran: 0, passed: 0, failed: 0 } }
    }),
    "verifier.recompute": async ({ implementation }) => {
      const ok = implementation?.result?.status === "completed";
      return { ok, evidence: ["verifier:checked=" + ok], tests: { ran: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1 } };
    }
  };

  const workforce = createDurableWorkforce({ repository, adapters: [], log: quiet });
  await workforce.registerAdapter({ id: "work.repo", kind: "coding", description: "work", execute: executors["work.repo"], health: async () => ({ ...health }) });
  await workforce.registerAgent({
    id: "w.worker", name: "worker", specialty: "coding", adapterId: "work.repo",
    capabilities: ["coding"], permissions: { allowed: ["coding"], denied: ["deploy"] }, availability: { maxConcurrent: 2 }
  });
  if (withVerifier) {
    await workforce.registerAdapter({ id: "verifier.recompute", kind: "verification", description: "verify", execute: executors["verifier.recompute"] });
    await workforce.registerAgent({
      id: "w.verifier", name: "verifier", specialty: "verification", adapterId: "verifier.recompute",
      capabilities: ["verification"], permissions: { allowed: ["verification"], denied: ["coding"] }, availability: { maxConcurrent: 2 }
    });
  }

  await workforce.assign({ taskId: "t1", agentId: "w.worker", requires: [], scopes: [], workspaceKey: null });
  const runner = createWorkforceRunner({ workforce, executors, verifierAgentId: withVerifier ? "w.verifier" : null, maxPerRun: 3, maxAttempts: 1, log: quiet });
  await runner.runOnce();
  return { workforce, runner, jobs, health };
}

test("a repair is only recovered when a later independent verification exists", async () => {
  const { workforce, runner, jobs } = await harness();
  assert.equal(workforce.results()[0].status, "failed", "the first run really failed");

  const escalations = [];
  const healer = createSelfHealer({ workforce, runner, escalate: async (event) => escalations.push(event), now, log: quiet });
  const first = await healer.healOnce();
  assert.equal(first.repaired.length, 1);
  assert.equal(first.recovered.length, 0, "re-running a broken job is not recovery");
  assert.equal(first.unverifiedRepairs.length, 1);
  assert.ok(first.escalated.some((event) => event.code === "repair_not_verified"));
  assert.equal(escalations.length >= 1, true);

  jobs.t1.broken = false;
  const second = await healer.healOnce();
  assert.equal(second.recovered.length, 1);
  assert.equal(second.recovered[0].verified, true);
  assert.equal(second.recovered[0].verifierAgentId, "w.verifier");
  assert.equal(workforce.results().some((result) => result.taskId === "t1" && result.status === "verified"), true);
});

test("repair attempts are bounded and then escalated instead of retried forever", async () => {
  const { workforce, runner } = await harness();
  const escalations = [];
  const healer = createSelfHealer({ workforce, runner, escalate: async (event) => escalations.push(event), maxAttempts: 1, maxRepairs: 2, now, log: quiet });
  await healer.healOnce();
  const second = await healer.healOnce();
  assert.equal(second.repaired.length, 0, "the budget is spent after one re-execution");
  assert.ok(second.escalated.some((event) => event.code === "repair_budget_exhausted"));
  assert.ok(escalations.some((event) => event.code === "repair_budget_exhausted"));
});

test("without a verifier nothing is ever claimed repaired", async () => {
  const { workforce, runner, jobs } = await harness({ withVerifier: false });
  jobs.t1.broken = false;
  const healer = createSelfHealer({ workforce, runner, now, log: quiet });
  const report = await healer.healOnce();
  assert.equal(report.recovered.length, 0);
  assert.ok(report.detected.some((finding) => finding.code === "no_verifier"));
  assert.ok(report.escalated.some((event) => event.code === "no_verifier"));
  assert.equal(report.ok, false);
});
