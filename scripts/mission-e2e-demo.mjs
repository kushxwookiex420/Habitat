#!/usr/bin/env node
/**
 * End-to-end mission demonstration.
 *
 * One natural-language objective is submitted through the real Ax command path
 * (`universal-command-engine.submit` → durable command task), becomes a durable mission, is planned into
 * dependent tasks, routed to real specialist workers, executed, independently verified, and returns a
 * durable mission record.
 *
 * It also submits the same objective twice (dedupe), a mission that must fail (a real failing test), and an
 * objective that needs the owner (approval), so the summary shows all four terminal shapes.
 *
 * Run: node scripts/mission-e2e-demo.mjs [--json]
 */

import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMissionEnvironment } from "../mission-harness.mjs";

const ROOT = process.cwd();
const FAILING_TEST = path.join(ROOT, "tests", "fixtures", "mission-failing-probe.test.mjs");

const SUCCESS_OBJECTIVE = "Assess the repository test tree and verify the priority policy suite passes";
const SUCCESS_CRITERIA = [
  "The tests tree has been analysed and its digest recorded",
  "tests/ax-priority-policy.test.mjs passes and is independently verified"
];
const SUCCESS_TASKS = [
  { id: "t1", title: "Analyse the repository tests tree", requires: ["engineering"], dependsOn: [], criteria: [0] },
  { id: "t2", title: "Run tests/ax-priority-policy.test.mjs and report its counts", requires: ["testing"], dependsOn: ["t1"], criteria: [1] }
];

const FAILING_OBJECTIVE = "Prove that a failing test is detected and never reported as a completed mission";
const FAILING_CRITERIA = ["The failing suite is executed under the same policy as any other task"];
const FAILING_TASKS = [
  { id: "f1", title: "Analyse the repository tests tree", requires: ["engineering"], dependsOn: [], criteria: [0] },
  { id: "f2", title: "Run tests/fixtures/mission-failing-probe.test.mjs", requires: ["testing"], dependsOn: ["f1"], criteria: [0] }
];

const APPROVAL_OBJECTIVE = "Deploy the mission pipeline to production and publish the result";

async function main() {
  const env = await buildMissionEnvironment({ rootDir: ROOT, artifactsDir: ".scratch/mission-artifacts" });
  await writeFile(FAILING_TEST, `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("deliberate mission failure probe", () => { assert.equal(2 + 2, 5); });\n`, "utf8");

  const started = new Date().toISOString();

  // 1. The successful mission, submitted through the command path.
  const submitted = await env.pipeline.submit({
    objective: SUCCESS_OBJECTIVE,
    acceptanceCriteria: SUCCESS_CRITERIA,
    tasks: SUCCESS_TASKS,
    idempotencyKey: "demo-mission-success",
    submittedBy: "owner",
    priority: 70
  });
  const success = submitted.ok ? await env.pipeline.run(submitted.missionId, { maxRounds: 3 }) : submitted;

  // 2. The same objective and key again: a replay must not create a second mission or command task.
  const duplicate = await env.pipeline.submit({
    objective: SUCCESS_OBJECTIVE,
    acceptanceCriteria: SUCCESS_CRITERIA,
    tasks: SUCCESS_TASKS,
    idempotencyKey: "demo-mission-success",
    submittedBy: "owner",
    priority: 70
  });

  // 3. A mission that must fail: a real failing test, executed by the real QA worker.
  const failingSubmit = await env.pipeline.submit({
    objective: FAILING_OBJECTIVE,
    acceptanceCriteria: FAILING_CRITERIA,
    tasks: FAILING_TASKS,
    idempotencyKey: "demo-mission-failure"
  });
  const failing = failingSubmit.ok ? await env.pipeline.run(failingSubmit.missionId, { maxRounds: 3 }) : failingSubmit;

  // 4. An objective that names a consequential action: it must park for the owner, not execute.
  const approvalSubmit = await env.pipeline.submit({
    objective: APPROVAL_OBJECTIVE,
    acceptanceCriteria: ["The deployment is described but not performed"],
    tasks: [{
      id: "a1",
      title: "Deploy the pipeline to production",
      requires: ["engineering"],
      dependsOn: [],
      criteria: [0],
      approvalRequired: true
    }]
  });
  const approval = approvalSubmit.ok ? await env.pipeline.run(approvalSubmit.missionId, { maxRounds: 2 }) : approvalSubmit;

  const report = {
    generatedAt: new Date().toISOString(),
    startedAt: started,
    execution: "in-process real workers on SQLite behind the D1 HTTP shape (no model, no network)",
    mission: {
      submitted,
      success: {
        missionId: success.missionId,
        status: success.status,
        repairs: success.repairs,
        commandTaskId: success.commandTaskId,
        completedOnlyFromVerified: success.completedOnlyFromVerified,
        tasks: success.tasks
      },
      rounds: success.rounds
    },
    duplicate: { replay: duplicate.replay, sameMission: duplicate.missionId === submitted.missionId, missionId: duplicate.missionId },
    failure: {
      missionId: failing.missionId,
      status: failing.status,
      repairs: failing.repairs,
      tasks: failing.tasks,
      escalations: failing.escalations
    },
    approval: { missionId: approval.missionId, status: approval.status, tasks: approval.tasks }
  };

  const ok =
    success.status === "completed" &&
    success.completedOnlyFromVerified === true &&
    success.tasks.every((task) => task.verifierAgentId) &&
    duplicate.replay === true && duplicate.missionId === submitted.missionId &&
    failing.status !== "completed" && failing.status !== "verified" &&
    failing.escalations.length >= 1 &&
    approval.status === "approval_required";

  report.ok = ok;

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("MISSION END-TO-END DEMONSTRATION");
    console.log("objective:", SUCCESS_OBJECTIVE);
    console.log("mission:", success.missionId, "status:", success.status, "commandTask:", success.commandTaskId);
    for (const task of success.tasks) {
      console.log("  ", task.id, task.status, "agent=" + task.agentId, "verifier=" + task.verifierAgentId, (task.evidence || [])[0] || "");
    }
    console.log("duplicate submit replay:", duplicate.replay, "same mission:", duplicate.missionId === submitted.missionId);
    console.log("failure mission:", failing.missionId, "status:", failing.status, "escalations:", failing.escalations.map((item) => item.code).join(","));
    console.log("  ", (failing.tasks || []).map((task) => task.id + "=" + task.status + (task.error ? "(" + task.error + ")" : "")).join(" "));
    console.log("approval mission:", approval.missionId, "status:", approval.status);
    console.log("ok:", ok);
  }

  await rm(FAILING_TEST, { force: true });
  await rm(path.join(ROOT, ".scratch", "mission-artifacts"), { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("MISSION_DEMO_FAILED", String(error?.stack || error));
  process.exitCode = 1;
});
