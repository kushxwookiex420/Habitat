import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { buildMissionEnvironment } from "../mission-harness.mjs";

/**
 * Execution-bound approval gate.
 *
 * Each test drives the real mission engine: real intake, real durable workforce, real pipeline. The executors
 * are spies that count invocations, so "never invoked" is observed, not inferred. Approval records are tampered
 * with through the store exactly as a bug or a hostile writer could, after the owner decision.
 */

const ROOT = process.cwd();
const CRITERIA = ["Repository analysed", "Release prepared"];
const TASKS = [
  { id: "t1", title: "Analyse the repository", requires: ["engineering"], criteria: [0] },
  {
    id: "t2",
    title: "Deploy to production",
    requires: ["engineering"],
    criteria: [1],
    dependsOn: ["t1"],
    approvalRequired: true,
    action: "deploy release 4.2.0",
    target: "staging",
    params: { region: "iad", replicas: 2 }
  }
];

function clock(start = "2026-11-24T12:00:00.000Z") {
  let value = Date.parse(start);
  return {
    now: () => new Date(value).toISOString(),
    advance(ms) { value += ms; }
  };
}

async function setup({ tick = clock(), verifier = async () => ({ ok: true, evidence: ["verifier:spy_verified"], tests: { ran: 1, passed: 1, failed: 0 } }) } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "habitat-approval-gate-"));
  const calls = { compute: 0, verify: 0, byTask: {} };
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(base, "artifacts"),
    dbPath: path.join(base, "db.sqlite"),
    now: tick.now,
    ownerVerifier: { verify: () => ({ ok: true, code: "test_attestation" }) },
    executorOverrides: {
      "eng.repo": async ({ task }) => {
        calls.compute += 1;
        calls.byTask[task.id] = (calls.byTask[task.id] || 0) + 1;
        return {
          result: {
            status: "completed",
            evidence: ["spy:executor_ran"],
            changedFiles: [],
            tests: { ran: 1, passed: 1, failed: 0 }
          }
        };
      },
      "verifier.recompute": async (...args) => { calls.verify += 1; return verifier(...args); }
    }
  });
  return { base, env, calls, tick, close: async () => { env.close(); await rm(base, { recursive: true, force: true }); } };
}

async function submit(env) {
  const outcome = await env.pipeline.submit({
    objective: "Deploy release 4.2.0 to staging after analysis",
    acceptanceCriteria: CRITERIA,
    tasks: TASKS
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.missionId;
}

async function load(env, missionId) {
  const loaded = await env.missions.get(missionId);
  return loaded?.record || loaded;
}

async function mutate(env, missionId, change) {
  const loaded = await env.missions.get(missionId);
  const mission = loaded.record;
  change(mission);
  const saved = await env.missionStore.save(mission, loaded.version);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  return saved.record;
}

async function approveSignal(env, missionId) {
  // Mission-scope and task-scope are separate authorizations, so each needs its own decision.
  const signal = await env.missions.approve({ missionId, decision: "approve", reason: "mission reviewed" });
  assert.equal(signal.ok, true, JSON.stringify(signal));
  return signal;
}

async function parkAndApprove({ env, missionId, taskId = "t2" }) {
  const first = await env.pipeline.run(missionId, { maxRounds: 1 });
  assert.equal(first.status, "approval_required", JSON.stringify(first));
  await approveSignal(env, missionId);
  const approved = await env.missions.approve({ missionId, taskId, decision: "approve", reason: "release window agreed" });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  return approved;
}

test("gate: a valid bound approval lets the task execute, and the mission completes", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    await parkAndApprove({ env, missionId });
    const run = await env.pipeline.run(missionId, { maxRounds: 2 });
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(calls.compute, 2, "both tasks ran through the real executor path");
    const mission = await load(env, missionId);
    const task = mission.tasks.find((item) => item.id === "t2");
    assert.equal(task.status, "completed");
    assert.equal(task.approval.code, "approval_valid");
    assert.match(task.approval.fingerprint, /^ap:[0-9a-f]{32}$/);
    const events = await env.missions.events(missionId);
    assert.ok(events.some((event) => event.type === "task.approval_cleared" && event.taskId === "t2"));
  } finally { await close(); }
});

test("gate: no approval means no executor invocation", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    await mutate(env, missionId, (mission) => { mission.approvals = []; });
    const first = await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.notEqual(first.status, "completed");
    assert.equal(calls.compute, 1, "only the read-only task ran");
    const task = (await load(env, missionId)).tasks.find((item) => item.id === "t2");
    assert.equal(task.status, "blocked");
    assert.equal(task.error, "approval_missing");
    assert.ok(task.evidence.some((entry) => entry.startsWith("approval:approval_missing@")));
    const events = await env.missions.events(missionId);
    assert.ok(events.some((event) => event.type === "task.approval_refused" && event.code === "approval_missing" && event.taskId === "t2"));
  } finally { await close(); }
});

test("gate: a rejected approval is refused at execution", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    const first = await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(first.status, "approval_required");
    const rejected = await env.missions.approve({ missionId, taskId: "t2", decision: "reject" });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    const after = await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.compute, 1, "the rejected action never reached an executor");
    assert.equal(after.stopReason, "rejected");
    assert.notEqual((await load(env, missionId)).status, "completed");
  } finally { await close(); }
});

test("gate: an expired approval is refused", async () => {
  const tick = clock();
  const { env, calls, close } = await setup({ tick });
  try {
    const missionId = await submit(env);
    await parkAndApprove({ env, missionId });
    tick.advance(31 * 60_000);
    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.compute, 1, "expired approval does not execute");
    const task = (await load(env, missionId)).tasks.find((item) => item.id === "t2");
    assert.equal(task.error, "approval_expired");
  } finally { await close(); }
});

test("gate: changing the parameters after approval invalidates it", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    await parkAndApprove({ env, missionId });
    await mutate(env, missionId, (mission) => {
      mission.tasks.find((item) => item.id === "t2").params = { region: "iad", replicas: 9 };
    });
    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.compute, 1, "changed parameters cannot reuse the approval");
    const task = (await load(env, missionId)).tasks.find((item) => item.id === "t2");
    assert.equal(task.error, "approval_action_changed");
  } finally { await close(); }
});

test("gate: changing the target after approval invalidates it", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    await parkAndApprove({ env, missionId });
    await mutate(env, missionId, (mission) => {
      mission.tasks.find((item) => item.id === "t2").target = "production";
    });
    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.compute, 1);
    assert.equal((await load(env, missionId)).tasks.find((item) => item.id === "t2").error, "approval_action_changed");
  } finally { await close(); }
});

test("gate: an approval bound to another task cannot authorise this one", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    await mutate(env, missionId, (mission) => {
      const approval = mission.approvals.find((item) => item.taskId === "t2");
      approval.status = "approved";
      approval.decision = "approved";
      approval.grantedAt = new Date().toISOString();
      approval.expiresAt = new Date(Date.now() + 600_000).toISOString();
      approval.taskId = "t1";
      // Clear the mission-scope signal so execution reaches the task gate instead of parking.
      for (const item of mission.approvals) if (!item.taskId) item.status = "approved";
    });
    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.compute, 1);
    const task = (await load(env, missionId)).tasks.find((item) => item.id === "t2");
    assert.equal(task.error, "approval_missing");
  } finally { await close(); }
});

test("gate: an approval replayed onto another mission cannot authorise it", async () => {
  const { env, calls, close } = await setup();
  try {
    const firstId = await submit(env);
    await parkAndApprove({ env, missionId: firstId });
    const approvalA = (await load(env, firstId)).approvals.find((item) => item.taskId === "t2");

    // A different objective produces a different mission id.
    const other = await env.pipeline.submit({
      objective: "Deploy release 4.2.1 to staging after analysis",
      acceptanceCriteria: CRITERIA,
      tasks: TASKS
    });
    assert.equal(other.ok, true);
    const otherId = other.missionId;
    assert.notEqual(otherId, firstId);
    await mutate(env, otherId, (mission) => {
      mission.approvals = [{ ...approvalA, missionId: firstId }];
    });
    await env.pipeline.run(otherId, { maxRounds: 1 });
    const task = (await load(env, otherId)).tasks.find((item) => item.id === "t2");
    assert.equal(task.status, "blocked");
    assert.equal(task.error, "approval_missing", "an approval for another mission is not even a candidate");
    assert.equal(calls.compute, 2, "only the two missions' read-only tasks ran; neither deployment did");
  } finally { await close(); }
});

test("gate: re-validates classification, so prohibited work is refused after approval", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    await parkAndApprove({ env, missionId });
    await mutate(env, missionId, (mission) => {
      mission.tasks.find((item) => item.id === "t2").title = "Drop table production records";
    });
    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.compute, 1, "prohibited task never executes");
    const task = (await load(env, missionId)).tasks.find((item) => item.id === "t2");
    assert.equal(task.error, "policy_denied", "classification is revalidated at execution, before the approval check");
    const events = await env.missions.events(missionId);
    assert.ok(events.some((event) => event.type === "task.approval_refused" && event.taskId === "t2"));
  } finally { await close(); }
});

test("gate: a read-only mission still runs without any approval", async () => {
  const { env, calls, close } = await setup();
  try {
    const outcome = await env.pipeline.submit({
      objective: "Analyse the repository tests",
      acceptanceCriteria: ["Repository analysed"],
      tasks: [{ id: "t1", title: "Analyse the repository", requires: ["engineering"], criteria: [0] }]
    });
    const run = await env.pipeline.run(outcome.missionId, { maxRounds: 1 });
    assert.equal(run.status, "completed");
    assert.equal(calls.compute, 1);
  } finally { await close(); }
});

test("gate: one task signature does not authorise an unrelated consequential task", async () => {
  const { env, calls, close } = await setup();
  try {
    const outcome = await env.pipeline.submit({
      objective: "Prepare two separate releases",
      acceptanceCriteria: ["Release one prepared", "Release two prepared"],
      tasks: [
        { ...TASKS[1], id: "d1", title: "Deploy release 4.2.0 to production", criteria: [0], dependsOn: [], action: "deploy 4.2.0", target: "staging", params: { replicas: 2 } },
        { ...TASKS[1], id: "d2", title: "Deploy release 4.3.0 to production", criteria: [1], dependsOn: [], action: "deploy 4.3.0", target: "staging", params: { replicas: 3 } }
      ]
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const missionId = outcome.missionId;
    const parked = await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(parked.status, "approval_required");
    assert.equal(calls.compute, 0, "neither consequential task ran before a decision");

    await approveSignal(env, missionId);
    const approved = await env.missions.approve({ missionId, taskId: "d1", decision: "approve" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const after = await env.pipeline.run(missionId, { maxRounds: 1 });
    const mission = await load(env, missionId);
    const [d1, d2] = ["d1", "d2"].map((id) => mission.tasks.find((task) => task.id === id));
    assert.equal(d1.status, "completed", "the approved task ran");
    assert.equal(d2.status, "pending", "the unrelated task did not run");
    assert.equal(calls.byTask.d1, 1);
    assert.equal(calls.byTask.d2 || 0, 0, "the unrelated task never reached an executor");
    assert.ok(mission.approvals.some((item) => item.taskId === "d2" && item.status === "pending"), "d2 still needs its own decision");
    assert.notEqual(after.status, "completed");
  } finally { await close(); }
});

test("gate: a revoked approval cannot execute", async () => {
  const { env, calls, close } = await setup();
  try {
    const missionId = await submit(env);
    await parkAndApprove({ env, missionId });
    const revoked = await env.missions.revoke({ missionId, taskId: "t2", reason: "owner withdrew the release" });
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.byTask.t2 || 0, 0, "revoked work never executes");
    const task = (await load(env, missionId)).tasks.find((item) => item.id === "t2");
    assert.equal(task.error, "approval_revoked");
    const events = await env.missions.events(missionId);
    assert.ok(events.some((event) => event.type === "mission.approval_revoked" && event.taskId === "t2"));
  } finally { await close(); }
});

test("gate: an approval expires across a database restart", async () => {
  const tick = clock();
  const base = await mkdtemp(path.join(os.tmpdir(), "habitat-approval-restart-"));
  const dbPath = path.join(base, "db.sqlite");
  const artifactsDir = path.join(base, "artifacts");
  const calls = { compute: 0, byTask: {} };
  const overrides = {
    "eng.repo": async ({ task }) => {
      calls.compute += 1;
      calls.byTask[task.id] = (calls.byTask[task.id] || 0) + 1;
      return { result: { status: "completed", evidence: ["spy:ran"], changedFiles: [], tests: { ran: 1, passed: 1, failed: 0 } } };
    },
    "verifier.recompute": async () => ({ ok: true, evidence: ["verifier:ok"], tests: { ran: 1, passed: 1, failed: 0 } })
  };
  const first = await buildMissionEnvironment({
    rootDir: ROOT, artifactsDir, dbPath, now: tick.now,
    ownerVerifier: { verify: () => ({ ok: true, code: "test_attestation" }) },
    executorOverrides: overrides
  });
  let missionId;
  try {
    const outcome = await first.pipeline.submit({ objective: "Deploy release 9.0.0 to staging", acceptanceCriteria: ["Release prepared"], tasks: [{ ...TASKS[1], dependsOn: [], criteria: [0] }] });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    missionId = outcome.missionId;
    assert.equal((await first.pipeline.run(missionId, { maxRounds: 1 })).status, "approval_required");
    const signal = await first.missions.approve({ missionId, decision: "approve" });
    assert.equal(signal.ok, true, JSON.stringify(signal));
    const approved = await first.missions.approve({ missionId, taskId: "t2", decision: "approve" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(calls.byTask.t2 || 0, 0);
  } finally {
    first.close();
  }

  // A new process on the same database, after the approval's window has closed.
  tick.advance(31 * 60_000);
  const second = await buildMissionEnvironment({
    rootDir: ROOT, artifactsDir, dbPath, now: tick.now,
    ownerVerifier: { verify: () => ({ ok: true, code: "test_attestation" }) },
    executorOverrides: overrides
  });
  try {
    const run = await second.pipeline.run(missionId, { maxRounds: 1 });
    assert.notEqual(run.status, "completed");
    const mission = (await second.missions.get(missionId)).record;
    assert.equal(mission.tasks.find((task) => task.id === "t2").error, "approval_expired");
    assert.equal(calls.byTask.t2 || 0, 0, "the expired grant survived the restart but not the gate");
  } finally {
    second.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("gate: prohibited work stays blocked even with a valid approval", async () => {
  const { env, calls, close } = await setup();
  try {
    const intake = await env.missions.intake({
      objective: "Remove production records",
      acceptanceCriteria: ["Records removed"],
      tasks: [{
        id: "p1", title: "Delete production records", requires: ["engineering"], criteria: [0],
        approvalRequired: true, action: "delete production records", target: "production", params: { table: "missions" }
      }]
    });
    assert.equal(intake.ok, true, JSON.stringify(intake));
    const missionId = intake.missionId;
    await env.pipeline.run(missionId, { maxRounds: 1 });
    await approveSignal(env, missionId);
    const approved = await env.missions.approve({ missionId, taskId: "p1", decision: "approve" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.byTask.p1 || 0, 0, "prohibited work never executes, approval or not");
    const task = (await load(env, missionId)).tasks.find((item) => item.id === "p1");
    assert.equal(task.error, "policy_denied");
  } finally { await close(); }
});

test("gate: execute, recover and the pipeline all converge on the same refusal", async () => {
  const { env, calls, close } = await setup();
  try {
    const makeTampered = async (suffix) => {
      const outcome = await env.pipeline.submit({
        objective: "Deploy release 4.2.0 to staging " + suffix,
        acceptanceCriteria: ["Release prepared"],
        tasks: [{ ...TASKS[1], dependsOn: [], criteria: [0] }]
      });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      const missionId = outcome.missionId;
      await env.pipeline.run(missionId, { maxRounds: 1 });
      await approveSignal(env, missionId);
      await env.missions.approve({ missionId, taskId: "t2", decision: "approve" });
      await mutate(env, missionId, (mission) => {
        mission.tasks.find((task) => task.id === "t2").params = { region: "iad", replicas: 9 };
      });
      return missionId;
    };
    const paths = [
      ["engine.execute", async (id) => env.missions.execute(id)],
      ["engine.recover", async () => env.missions.recover({ limit: 5 })],
      ["pipeline.run", async (id) => env.pipeline.run(id, { maxRounds: 1 })]
    ];
    for (const [index, [name, invoke]] of paths.entries()) {
      const missionId = await makeTampered("via " + name + " " + index);
      await invoke(missionId);
      const mission = await load(env, missionId);
      const task = mission.tasks.find((item) => item.id === "t2");
      assert.equal(task.status, "blocked", name + " must refuse through the gate");
      assert.equal(task.error, "approval_action_changed", name);
      assert.notEqual(mission.status, "completed", name);
    }
    assert.equal(calls.byTask.t2 || 0, 0, "no path executed the tampered task");
  } finally { await close(); }
});
