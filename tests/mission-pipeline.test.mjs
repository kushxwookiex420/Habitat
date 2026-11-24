import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMissionEnvironment } from "../mission-harness.mjs";
import { missionJobFor } from "../mission-pipeline.mjs";

const ROOT = process.cwd();
const OBJECTIVE = "Assess the repository test tree and verify the priority policy suite passes";
const CRITERIA = ["The tests tree is analysed", "The priority policy suite is independently verified"];
const TASKS = [
  { id: "t1", title: "Analyse the repository tests tree", requires: ["engineering"], dependsOn: [], criteria: [0] },
  { id: "t2", title: "Run tests/ax-priority-policy.test.mjs", requires: ["testing"], dependsOn: ["t1"], criteria: [1] }
];

let counter = 0;
async function failingProbe() {
  counter += 1;
  const relative = "tests/fixtures/mission-failure-" + process.pid + "-" + counter + ".test.mjs";
  await writeFile(path.join(ROOT, relative), `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("deliberate failure", () => { assert.equal(1, 2); });\n`, "utf8");
  return relative;
}

async function environment(options = {}) {
  return buildMissionEnvironment({ rootDir: ROOT, artifactsDir: ".scratch/mission-test-artifacts", ...options });
}

test("route selection is deterministic and refuses tasks it cannot honestly run", () => {
  assert.deepEqual(missionJobFor({ task: { requires: ["testing"], title: "Run tests/x.test.mjs" }, mission: {} }), { kind: "tests", file: "tests/x.test.mjs" });
  assert.deepEqual(missionJobFor({ task: { requires: ["engineering"], title: "Check worker-executors.mjs" }, mission: {} }), { kind: "syntax-check", file: "worker-executors.mjs" });
  assert.equal(missionJobFor({ task: { requires: ["testing"], title: "run the suite" }, mission: {} }), null, "a test task with no named file is unroutable");
  assert.equal(missionJobFor({ task: { requires: ["research"], title: 'Search "escalation"', }, mission: {} }).kind, "corpus-search");
  assert.equal(missionJobFor({ task: { requires: ["unknown-capability"], title: "x" }, mission: {} }), null);
});

test("one objective travels the whole pipeline and only completes with verified tasks", async () => {
  const env = await environment();
  try {
    const submitted = await env.pipeline.submit({ objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "lifecycle-1" });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.match(submitted.missionId, /^msn_/);
    assert.match(submitted.commandTaskId, /^cmd_/);

    const run = await env.pipeline.run(submitted.missionId, { maxRounds: 3 });
    assert.equal(run.status, "completed");
    assert.equal(run.completedOnlyFromVerified, true);
    assert.equal(run.tasks.length, 2);
    for (const task of run.tasks) {
      assert.equal(task.status, "completed");
      assert.equal(task.verifierAgentId, "worker-verifier");
      assert.ok(task.evidence.length > 0);
      assert.ok(task.verificationEvidence.length > 0);
    }
    assert.notEqual(run.tasks[0].agentId, run.tasks[1].agentId, "two different specialists ran");

    const events = await env.pipeline.events(submitted.missionId);
    const types = events.map((event) => event.type);
    assert.ok(types.includes("mission.planned"));
    assert.ok(types.includes("task.assigned"));
    assert.ok(types.includes("task.verified"));
    assert.ok(types.includes("mission.completed"));
  } finally {
    await rm(path.join(ROOT, ".scratch", "mission-test-artifacts"), { recursive: true, force: true });
  }
});

test("duplicate submission is a replay: one mission, one command task, no second state", async () => {
  const env = await environment();
  const first = await env.pipeline.submit({ objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "dedupe-1" });
  const second = await env.pipeline.submit({ objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "dedupe-1" });
  assert.equal(second.ok, true);
  assert.equal(second.replay, true);
  assert.equal(second.missionId, first.missionId);
  assert.equal(second.commandTaskId, first.commandTaskId);
  const missions = await env.missions.list({ limit: 10 });
  assert.equal(missions.length, 1, "the mission store holds exactly one mission");
  const stored = (await env.missions.get(first.missionId)).record;
  assert.deepEqual(stored.tasks.map((task) => task.status), ["pending", "pending"], "a replay does not execute anything");
});

test("a real worker failure is detected, repaired within budget and never reported as success", async () => {
  const relative = await failingProbe();
  const env = await environment({ maxRepairs: 1 });
  try {
    const submitted = await env.pipeline.submit({
      objective: "Prove a failing suite cannot be reported as a completed mission",
      acceptanceCriteria: ["The failing suite is executed honestly"],
      tasks: [
        { id: "t1", title: "Analyse the tests tree", requires: ["engineering"], dependsOn: [], criteria: [0] },
        { id: "t2", title: "Run " + relative, requires: ["testing"], dependsOn: ["t1"], criteria: [0] }
      ]
    });
    const run = await env.pipeline.run(submitted.missionId, { maxRounds: 3 });
    assert.notEqual(run.status, "completed");
    assert.ok(["failed", "verification_failed"].includes(run.status), run.status);
    assert.equal(run.repairs, 1, "the repair budget was used exactly once");
    assert.equal(run.tasks.find((task) => task.id === "t2").status, "failed");
    assert.ok(run.escalations.length >= 1);
    assert.equal(env.escalations.length, run.escalations.length, "every escalation was delivered");
    const stored = (await env.missions.get(submitted.missionId)).record;
    assert.notEqual(stored.status, "completed");
  } finally {
    await rm(path.join(ROOT, relative), { force: true });
    await rm(path.join(ROOT, ".scratch", "mission-test-artifacts"), { recursive: true, force: true });
  }
});

test("a dishonest verifier blocks completion even when the worker reports success", async () => {
  const env = await environment({
    verifierOverride: async () => ({ ok: false, evidence: ["verifier:criteria_not_met"], tests: { ran: 1, passed: 0, failed: 1 } })
  });
  const submitted = await env.pipeline.submit({ objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS });
  const run = await env.pipeline.run(submitted.missionId, { maxRounds: 2 });
  assert.notEqual(run.status, "completed");
  assert.equal(run.completedOnlyFromVerified, null, "no completed mission to attest");
  const stored = (await env.missions.get(submitted.missionId)).record;
  assert.notEqual(stored.status, "completed");
  assert.ok(stored.tasks.some((task) => task.status === "failed" || task.status === "pending"));
});

test("retry budgets are finite: no repair means failure plus escalation, not a loop", async () => {
  const relative = await failingProbe();
  const env = await environment({ maxRepairs: 0, maxTaskAttempts: 1 });
  try {
    const submitted = await env.pipeline.submit({
      objective: "Exhaust the retry budget on a failing suite",
      acceptanceCriteria: ["The failure is recorded"],
      tasks: [{ id: "t1", title: "Run " + relative, requires: ["testing"], dependsOn: [], criteria: [0] }]
    });
    const run = await env.pipeline.run(submitted.missionId, { maxRounds: 3 });
    assert.equal(run.repairs, 0);
    assert.notEqual(run.status, "completed");
    assert.ok(run.escalations.length >= 1);
    assert.ok(run.tasks.every((task) => task.status !== "completed"));
  } finally {
    await rm(path.join(ROOT, relative), { force: true });
  }
});

test("authorization: a consequential task must be marked for the owner, and a gated mission does not run it", async () => {
  const env = await environment();

  const refused = await env.pipeline.submit({
    objective: "Deploy the pipeline to production",
    acceptanceCriteria: ["It is deployed"],
    tasks: [{ id: "a1", title: "Deploy the pipeline to production", requires: ["engineering"], dependsOn: [], criteria: [0] }]
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "approval_required_for_task");

  const gated = await env.pipeline.submit({
    objective: "Deploy the pipeline to production",
    acceptanceCriteria: ["It is deployed"],
    tasks: [{ id: "a1", title: "Deploy the pipeline to production", requires: ["engineering"], dependsOn: [], criteria: [0], approvalRequired: true }]
  });
  assert.equal(gated.ok, true);
  const run = await env.pipeline.run(gated.missionId, { maxRounds: 2 });
  assert.equal(run.status, "approval_required");
  const stored = (await env.missions.get(gated.missionId)).record;
  assert.equal(stored.tasks[0].status, "pending", "the owner-required task never started");
  assert.equal(stored.tasks[0].agentId, null);
  assert.ok(stored.approvals.length >= 1);
  assert.equal(env.escalations.length, 0, "waiting on the owner is not an escalation");
});
