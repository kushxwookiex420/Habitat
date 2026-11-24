import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkforceRepository, WORKFORCE_DDL } from "../d1-workforce-repository.mjs";
import { createMissionRepository } from "../d1-mission-repository.mjs";
import { createMissionRuntime } from "../ax-mission-runtime.mjs";
import { buildMissionPlan, createMissionEngine, missionIdFor } from "../ax-mission-engine.mjs";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createDurableWorkforce } from "../ax-durable-workforce.mjs";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const NOW = "2026-11-24T15:00:00.000Z";
const now = () => NOW;
const SECRET = "owner-attestation-test-secret-0123456789";

function queryFrom(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };
}

const adapters = () => [
  { id: "coder-adapter", kind: "coding", description: "test coder", execute: async () => ({ ok: true }), health: async () => ({ status: "healthy" }) },
  { id: "verifier-adapter", kind: "verification", description: "test verifier", execute: async () => ({ ok: true }) }
];

async function setup({ ownerVerifier = null } = {}) {
  const db = new DatabaseSync(":memory:");
  const query = queryFrom(db);
  const missionStore = createMissionRepository({ query, now });
  await missionStore.initialize();
  const workforceRepo = createWorkforceRepository({ query, now });
  await workforceRepo.initialize();
  const workforce = createDurableWorkforce({ repository: workforceRepo, adapters: adapters(), now, log: quiet });
  await workforce.hydrate();
  await workforce.registerAgent({
    id: "coder.one", name: "Coder", specialty: "coding", adapterId: "coder-adapter",
    capabilities: ["coding", "tests"], permissions: { allowed: ["coding", "tests"], denied: ["deploy"] },
    availability: { maxConcurrent: 3 }
  });
  await workforce.registerAgent({
    id: "verifier.one", name: "Verifier", specialty: "verification", adapterId: "verifier-adapter",
    capabilities: ["verification"], permissions: { allowed: ["verification"], denied: [] },
    availability: { maxConcurrent: 3 }
  });
  const engine = createMissionEngine({ store: missionStore, workforce, verifierAgentId: "verifier.one", ownerVerifier, now, log: quiet, maxTasksPerRun: 3 });
  return { db, query, missionStore, workforce, engine, ownerVerifier };
}

const EXECUTORS = {
  "coder-adapter": async ({ task }) => ({
    result: {
      status: "completed",
      evidence: ["evidence for " + task.id],
      changedFiles: ["src/" + task.id + ".mjs"],
      tests: { ran: 2, passed: 2, failed: 0 },
      costCents: null
    }
  }),
  "verifier-adapter": async () => ({ ok: true, evidence: ["independent rerun 2/2"], tests: { ran: 2, passed: 2, failed: 0 } })
};

function spec(overrides = {}) {
  return {
    project: "habitat",
    objective: "Add a health check endpoint to the service.",
    acceptanceCriteria: ["The health endpoint returns HTTP 200."],
    tasks: [{ id: "t1", title: "Add the endpoint", requires: ["coding", "tests"], criteria: [0] }],
    ...overrides
  };
}

test("a complete mission is planned, delegated, independently verified and completed", async () => {
  const { engine, missionStore, workforce, db } = await setup();
  const intake = await engine.intake(spec());
  assert.equal(intake.ok, true);
  assert.match(intake.missionId, /^msn_[a-f0-9]{24}$/);
  assert.equal(intake.mission.milestones.length, 1);
  assert.equal(intake.mission.status, "planned");

  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: EXECUTORS, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  const run = await engine2.execute(intake.missionId);
  assert.equal(run.status, "completed");
  const stored = (await missionStore.get(intake.missionId)).record;
  assert.equal(stored.tasks[0].status, "completed");
  assert.equal(stored.tasks[0].verifierAgentId, "verifier.one");
  assert.equal(stored.tasks[0].tests.passed, 2);
  const events = await missionStore.events(intake.missionId);
  assert.ok(events.some(event => event.type === "task.verified"));
  assert.ok(events.some(event => event.type === "mission.completed"));
  db.close();
});

test("a failing task leaves the mission failed while completed work remains recorded", async () => {
  const { engine, missionStore, workforce, db } = await setup();
  const intake = await engine.intake(spec({
    acceptanceCriteria: ["The health endpoint returns HTTP 200.", "Existing tests still pass."],
    tasks: [
      { id: "t1", requires: ["coding"], criteria: [0] },
      { id: "t2", requires: ["coding", "tests"], dependsOn: ["t1"], criteria: [1] }
    ]
  }));
  const failing = {
    ...EXECUTORS,
    "coder-adapter": async ({ task }) => {
      if (task.id === "t2") throw new Error("build failed");
      return EXECUTORS["coder-adapter"]({ task });
    }
  };
  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: failing, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  await engine2.execute(intake.missionId);
  const run = await engine2.execute(intake.missionId);
  assert.equal(run.status, "failed");
  const stored = (await missionStore.get(intake.missionId)).record;
  assert.equal(stored.tasks[0].status, "completed");
  assert.equal(stored.tasks[1].status, "failed");
  assert.equal(stored.tasks[1].attempts, 2, "bounded at maxAttempts");
  db.close();
});

test("a transient provider failure is retried and then verified", async () => {
  const { engine, missionStore, workforce, db } = await setup();
  const intake = await engine.intake(spec());
  let calls = 0;
  const flaky = {
    ...EXECUTORS,
    "coder-adapter": async ({ task }) => {
      calls += 1;
      if (calls === 1) throw new Error("provider 503");
      return EXECUTORS["coder-adapter"]({ task });
    }
  };
  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: flaky, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  const run = await engine2.execute(intake.missionId);
  assert.equal(run.status, "completed");
  assert.equal(calls, 2, "one retry, no unbounded loop");
  const stored = (await missionStore.get(intake.missionId)).record;
  assert.equal(stored.tasks[0].attempts, 2);
  assert.equal(stored.tasks[0].status, "completed");
  db.close();
});

test("worker loss blocks the mission and the same mission finishes once a worker returns", async () => {
  const { engine, missionStore, workforce, db } = await setup();
  const intake = await engine.intake(spec());
  await workforce.removeAgent("coder.one");
  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: EXECUTORS, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  const blocked = await engine2.execute(intake.missionId);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.tasks[0].error, "no_eligible_agent");

  await workforce.registerAgent({
    id: "coder.two", name: "Coder two", specialty: "coding", adapterId: "coder-adapter",
    capabilities: ["coding", "tests"], permissions: { allowed: ["coding", "tests"], denied: [] },
    availability: { maxConcurrent: 2 }
  });
  const resumed = await engine2.execute(intake.missionId);
  assert.equal(resumed.status, "completed");
  db.close();
});

test("a mission assigned before a restart recovers without a duplicate assignment", async () => {
  const { engine, missionStore, workforce, db, query } = await setup();
  const intake = await engine.intake(spec());
  const taskKey = intake.missionId + ".t1";
  const assigned = await workforce.assign({ taskId: taskKey, agentId: "coder.one", requires: ["coding", "tests"], workspaceKey: "mission/wip" });
  assert.equal(assigned.ok, true);
  // Simulate a crash after the assignment was written but before any result.
  const loaded = (await missionStore.get(intake.missionId)).record;
  loaded.tasks[0].status = "running";
  loaded.tasks[0].assignmentId = assigned.assignmentId;
  loaded.tasks[0].agentId = "coder.one";
  loaded.tasks[0].attempts = 1;
  loaded.status = "running";
  await missionStore.save(loaded, loaded.version);

  // New process: new store, new workforce, same database.
  const store2 = createMissionRepository({ query, now });
  const workforce2 = createDurableWorkforce({ repository: createWorkforceRepository({ query, now }), adapters: adapters(), now, log: quiet });
  await workforce2.hydrate();
  const engine2 = createMissionEngine({ store: store2, workforce: workforce2, executors: EXECUTORS, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  const recovered = await engine2.execute(intake.missionId);
  assert.equal(recovered.status, "completed");
  const assignments = (await workforce2.assignments()).filter(item => item.taskId === taskKey);
  assert.equal(assignments.length, 1, "the recovered task reused its assignment");
  db.close();
});

test("recover() finds running missions and finishes them", async () => {
  const { engine, missionStore, workforce, db } = await setup();
  const intake = await engine.intake(spec());
  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: EXECUTORS, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  const recovered = await engine2.recover();
  assert.equal(recovered.ok, true);
  assert.ok(recovered.results.some(item => item.missionId === intake.missionId && item.status === "completed"));
  db.close();
});

test("a failed independent verification prevents completion and reports the gap", async () => {
  const { engine, missionStore, workforce, db } = await setup();
  const intake = await engine.intake(spec());
  const dishonest = {
    "coder-adapter": EXECUTORS["coder-adapter"],
    "verifier-adapter": async () => ({ ok: false, evidence: ["criterion not met"], tests: { ran: 2, passed: 1, failed: 1 } })
  };
  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: dishonest, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  const run = await engine2.execute(intake.missionId);
  assert.equal(run.status, "verification_failed");
  assert.equal(run.gaps.length, 1);
  assert.equal(run.gaps[0].code, "not_covered");
  db.close();
});

test("an approval-required mission stops before completion and only a signed owner decision releases it", async () => {
  const ownerVerifier = createOwnerAttestation({ secret: SECRET, now: () => Date.parse(NOW) });
  const { engine, missionStore, workforce, db } = await setup({ ownerVerifier });
  const intake = await engine.intake(spec({
    objective: "Deploy the new health check to production.",
    acceptanceCriteria: ["Production health endpoint returns 200."]
  }));
  assert.equal(intake.approvals.length, 1);
  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: EXECUTORS, verifierAgentId: "verifier.one", ownerVerifier, now, log: quiet, maxTasksPerRun: 3 });
  const run = await engine2.execute(intake.missionId);
  assert.equal(run.status, "approval_required");

  const unsigned = await engine2.approve({ missionId: intake.missionId, decision: "approve" });
  assert.equal(unsigned.code, "owner_attestation_required");

  const signed = ownerVerifier.sign({
    operation: "mission.approve", project: "habitat", key: intake.missionId,
    kind: "approve", statement: "Reviewed the evidence.", tags: [], confidence: null
  });
  const approved = await engine2.approve({ missionId: intake.missionId, decision: "approve", attestation: signed.attestation, reason: "Reviewed the evidence." });
  assert.equal(approved.ok, true);
  // An approval releases the gate; it does not complete work that never ran.
  assert.equal(approved.status, "running");
  const stored = (await missionStore.get(intake.missionId)).record;
  assert.equal(stored.approvals[0].status, "approved");
  assert.equal(stored.status, "running", "an approval releases the gate; it does not complete the mission");
  assert.equal(stored.tasks.some((task) => task.status === "running"), false, "nothing was started by signing");
  db.close();
});

test("without an attestation verifier an approval is refused rather than trusted", async () => {
  const { engine, missionStore, workforce, db } = await setup();
  const intake = await engine.intake(spec({ objective: "Deploy the service.", acceptanceCriteria: ["It is deployed."] }));
  const engine2 = createMissionEngine({ store: missionStore, workforce, executors: EXECUTORS, verifierAgentId: "verifier.one", now, log: quiet, maxTasksPerRun: 3 });
  await engine2.execute(intake.missionId);
  const refused = await engine2.approve({ missionId: intake.missionId, decision: "approve" });
  assert.equal(refused.code, "owner_attestation_not_configured");
  db.close();
});

test("duplicate submission returns the original mission and creates no second record", async () => {
  const { engine, missionStore, db } = await setup();
  const first = await engine.intake(spec(), { idempotencyKey: "mission-request-1" });
  const second = await engine.intake(spec({ objective: "A different objective." }), { idempotencyKey: "mission-request-1" });
  assert.equal(second.replay, true);
  assert.equal(second.missionId, first.missionId);
  assert.equal((await missionStore.counts()).total, 1);
  const natural = await engine.intake(spec());
  const naturalAgain = await engine.intake(spec());
  assert.equal(naturalAgain.missionId, natural.missionId);
  db.close();
});

test("planning rejects missing criteria, unassigned criteria and dependency cycles", () => {
  assert.equal(buildMissionPlan({ objective: "x", acceptanceCriteria: [] }).code, "acceptance_criteria_required");
  assert.equal(buildMissionPlan({
    objective: "x",
    acceptanceCriteria: ["a", "b"],
    tasks: [{ id: "t1", criteria: [0] }]
  }).code, "criteria_unassigned");
  assert.equal(buildMissionPlan({
    objective: "x",
    acceptanceCriteria: ["a"],
    tasks: [
      { id: "t1", dependsOn: ["t2"], criteria: [0] },
      { id: "t2", dependsOn: ["t1"] }
    ]
  }).code, "dependency_cycle");
  assert.equal(missionIdFor({ objective: "same" }), missionIdFor({ objective: "same" }));
});

test("mission runtime refuses when migration 0011 is absent and creates nothing", async () => {
  const db = new DatabaseSync(":memory:");
  const query = queryFrom(db);
  const runtime = createMissionRuntime({
    env: { HABITAT_MISSIONS_ENABLED: "true", CLOUDFLARE_ACCOUNT_ID: "a", HABITAT_D1_DATABASE_ID: "d", HABITAT_D1_API_TOKEN: "t" },
    query,
    workforce: { assign: async () => ({ ok: false }), agents: () => [], assignments: async () => [], results: () => [] },
    log: quiet
  });
  const status = await runtime.initialize();
  assert.equal(status.state, "schema_missing");
  assert.equal(status.migration.ready, false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length, 0);
  assert.equal((await runtime.tick()).code, "missions_schema_missing");
  db.close();
});

test("an enabled mission runtime coordinates through the scheduler and reports it", async () => {
  const { db, query, missionStore, workforce } = await setup();
  const runtime = createMissionRuntime({
    env: { HABITAT_MISSIONS_ENABLED: "true", CLOUDFLARE_ACCOUNT_ID: "a", HABITAT_D1_DATABASE_ID: "d", HABITAT_D1_API_TOKEN: "t" },
    query,
    repository: missionStore,
    workforce,
    executors: EXECUTORS,
    verifierAgentId: "verifier.one",
    log: quiet
  });
  const status = await runtime.initialize();
  assert.equal(status.state, "initialized");
  const intake = await runtime.intake(spec());
  assert.equal(intake.ok, true);
  const ticked = await runtime.tick();
  assert.equal(ticked.ok, true);
  const after = await runtime.status();
  assert.equal(after.state, "running");
  assert.equal(after.verified, true);
  assert.equal(after.counts.byStatus.completed, 1);
  assert.equal(after.migration.appliedByRuntime, false);
  db.close();
});

test("a scheduler tick invokes mission coordination under the same lease", async () => {
  let calls = 0;
  const service = createSchedulerService({
    ticks: createMemorySchedulerRepository(),
    now,
    nowMs: () => Date.parse(NOW),
    log: quiet,
    mission: async () => { calls += 1; return { ok: true, recovered: 0 }; }
  });
  const outcome = await service.tick({ trigger: "cron" });
  assert.equal(calls, 1);
  assert.equal(outcome.mission.ok, true);
  assert.equal(outcome.mission.recovered, 0);
});

test("mission runtime is disabled by default, reads no schema, and reports why", async () => {
  let calls = 0;
  const runtime = createMissionRuntime({ env: {}, query: async () => { calls += 1; return []; }, log: quiet });
  const status = await runtime.initialize();
  assert.equal(status.state, "disabled");
  assert.equal(status.enabled, false);
  assert.equal(status.initialized, false);
  assert.equal(status.migration.appliedByRuntime, false);
  assert.equal(calls, 0);
  assert.equal((await runtime.intake(spec())).code, "missions_disabled");
  assert.equal((await runtime.tick()).code, "missions_disabled");
});
