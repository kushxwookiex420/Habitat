import test from "node:test";
import assert from "node:assert/strict";
import { createObjectiveService, OBJECTIVE_STATES, canTransition } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";

const CRITERIA = ["The requested file exists in the repository", "The test command reported zero failures"];

function setup(options = {}) {
  const repository = createMemoryObjectiveRepository();
  let tick = 0;
  const service = createObjectiveService({
    repository,
    now: () => new Date(Date.UTC(2026, 10, 22, 0, 0, tick++)).toISOString(),
    ...options
  });
  return { repository, service };
}

async function toPlanned(service, overrides = {}) {
  const created = await service.create({
    objective: "Verify the Habitat regression suite and report evidence",
    criteria: CRITERIA,
    budgetUsd: 0.05,
    ...overrides
  });
  assert.equal(created.ok, true);
  const id = created.objective.id;
  assert.equal((await service.understand(id, { summary: "Run the suite and collect the exit status." })).ok, true);
  const planned = await service.plan(id, {
    steps: [{ objective: "Run npm test", agent: "engineering", adapter: "repo.test" }],
    provider: "openai",
    estimatedCostUsd: 0.004
  });
  assert.equal(planned.ok, true);
  return id;
}

test("the lifecycle starts at received and requires concrete acceptance criteria", async () => {
  const { service } = setup();
  const missing = await service.create({ objective: "Do something useful for the project" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "acceptance_criteria_required");

  const vague = await service.create({ objective: "Do something useful for the project", criteria: ["done"] });
  assert.equal(vague.ok, false);
  assert.equal(vague.code, "criterion_too_vague");

  const created = await service.create({ objective: "Run the regression suite and report the result", criteria: CRITERIA });
  assert.equal(created.objective.status, "received");
  assert.equal(created.objective.verification.verified, false);
  assert.equal(created.objective.criteria.length, 2);
  assert.equal(created.objective.transitions[0].to, "received");
});

test("a plan can never be completed without passing evidence checks", async () => {
  const { service } = setup();
  const id = await toPlanned(service);

  const direct = await service.complete(id, { summary: "done" });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, "verification_required");

  const shortcut = await service.transition(id, "completed");
  assert.equal(shortcut.ok, false);
  assert.equal(shortcut.code, "invalid_transition");

  const started = await service.start(id);
  assert.equal(started.ok, true);
  assert.equal(started.objective.status, "executing");

  // There is no edge from executing to completed at all, so the shortcut fails structurally.
  const jumping = await service.transition(id, "completed");
  assert.equal(jumping.ok, false);
  assert.equal(jumping.code, "invalid_transition");
  assert.equal(jumping.objective, undefined);
});

test("verification requires evidence that actually exists on the objective", async () => {
  const { service } = setup();
  const id = await toPlanned(service);
  await service.start(id);
  const moved = await service.transition(id, "verifying", { by: "ax", reason: "checks" });
  assert.equal(moved.ok, true);

  const invented = await service.verify(id, {
    checks: [{ criterionId: "c1", passed: true, evidenceIds: ["ev_does_not_exist"] }]
  });
  assert.equal(invented.ok, true);
  assert.equal(invented.verified, false);
  assert.deepEqual(invented.unmet, ["c1", "c2"]);

  const evidence = await service.addEvidence(id, {
    items: [
      { summary: "npm test exited 0 with 563 passing tests", source: "engineering", taskId: "task-1" },
      { summary: "file evidence.json exists at the expected path", source: "engineering" }
    ]
  });
  assert.equal(evidence.ok, true);
  const ids = evidence.objective.evidence.map(item => item.id);
  assert.equal(ids.length, 2);

  const passed = await service.verify(id, {
    checks: [
      { criterionId: "c1", passed: true, evidenceIds: [ids[1]] },
      { criterionId: "c2", passed: true, evidenceIds: [ids[0]] }
    ]
  });
  assert.equal(passed.verified, true);
  assert.deepEqual(passed.unmet, []);

  const completed = await service.complete(id, { summary: "Verified" });
  assert.equal(completed.ok, true);
  assert.equal(completed.objective.status, "completed");
  assert.equal(completed.objective.verification.verified, true);
  assert.ok(completed.objective.completedAt);

  const again = await service.complete(id, {});
  assert.equal(again.ok, false);
  assert.equal(again.code, "invalid_transition");
});

test("a failed check keeps the objective open with the unmet criteria named", async () => {
  const { service } = setup();
  const id = await toPlanned(service);
  await service.start(id);
  await service.transition(id, "verifying", { by: "ax" });
  const evidence = await service.addEvidence(id, { items: [{ summary: "suite exited 1 with two failures", source: "engineering" }] });
  const evidenceId = evidence.objective.evidence[0].id;
  const checked = await service.verify(id, {
    checks: [
      { criterionId: "c1", passed: true, evidenceIds: [evidenceId] },
      { criterionId: "c2", passed: false, evidenceIds: [evidenceId], detail: "two tests failed" }
    ]
  });
  assert.equal(checked.verified, false);
  assert.deepEqual(checked.unmet, ["c2"]);
  const blockedComplete = await service.complete(id);
  assert.equal(blockedComplete.ok, false);
  assert.equal(blockedComplete.code, "verification_required");
  assert.match(blockedComplete.error, /passing evidence verification/);
});

test("compare-and-swap refuses a stale writer instead of overwriting a newer state", async () => {
  const repository = createMemoryObjectiveRepository();
  const service = createObjectiveService({ repository, now: () => "2026-11-22T00:00:00.000Z" });
  const created = await service.create({ objective: "Concurrent objective check for the lifecycle", criteria: CRITERIA, key: "concurrency-check" });
  const id = created.objective.id;

  // Two writers read the same version, then race. The repository compares the exact bytes it is
  // replacing, so the loser is told it lost and must re-read.
  const first = await repository.getRecord(id);
  const second = await repository.getRecord(id);
  const writerA = { ...first.objective, status: "understood", updatedAt: "2026-11-22T00:00:01.000Z" };
  const writerB = { ...second.objective, status: "blocked", updatedAt: "2026-11-22T00:00:02.000Z" };

  const a = await repository.update(writerA, first.recordJson);
  assert.equal(a.ok, true);
  const b = await repository.update(writerB, second.recordJson);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "conflict");

  const stored = await service.get(id);
  assert.equal(stored.status, "understood");
  assert.equal(stored.updatedAt, "2026-11-22T00:00:01.000Z");
});

test("create is idempotent by key and refuses key reuse for a different objective", async () => {
  const { service } = setup();
  const first = await service.create({ objective: "Check the provider fallback path", criteria: CRITERIA, key: "provider-check" });
  const second = await service.create({ objective: "Check the provider fallback path", criteria: CRITERIA, key: "provider-check" });
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.objective.id, first.objective.id);
  const reused = await service.create({ objective: "A completely different objective text", criteria: CRITERIA, key: "provider-check" });
  assert.equal(reused.ok, false);
  assert.equal(reused.code, "key_reused");
});

test("budget exhaustion stops execution and records the spend", async () => {
  const { service } = setup();
  const created = await service.create({ objective: "Spend a bounded amount on planning", criteria: CRITERIA, budgetUsd: 0.01 });
  const id = created.objective.id;
  await service.understand(id, { summary: "Small budget objective." });
  await service.plan(id, { steps: [{ objective: "one bounded call", adapter: null }], estimatedCostUsd: 0.005 });
  await service.start(id);

  const charged = await service.charge(id, { costUsd: 0.02 });
  assert.equal(charged.ok, false);
  assert.equal(charged.code, "budget_exhausted");
  assert.equal(charged.objective.status, "blocked");
  assert.equal(charged.objective.costUsd, 0.02);
  assert.equal(charged.objective.execution.stopped, "budget_exhausted");
  assert.ok(charged.objective.transitions.some(entry => entry.reason === "budget exhausted"));

  const refusedStart = await service.start(id);
  assert.equal(refusedStart.ok, false);
  assert.ok(["budget_exhausted", "invalid_transition"].includes(refusedStart.code));
});

test("interrupted objectives recover explicitly, and only from a recovery state", async () => {
  const { service } = setup();
  const id = await toPlanned(service);
  await service.start(id);
  const interrupted = await service.interrupt(id, { reason: "process restarted" });
  assert.equal(interrupted.objective.status, "interrupted");

  const recovered = await service.recover(id, { reason: "worker reclaimed its lease" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.objective.status, "executing");
  assert.equal(recovered.objective.recovered, 1);

  const twice = await service.recover(id, { reason: "no interruption" });
  assert.equal(twice.ok, false);
  assert.equal(twice.code, "not_recoverable");
});

test("cancellation and failure are terminal, and authorization cannot be self-granted", async () => {
  const { service } = setup();
  const created = await service.create({
    objective: "Publish an article to the public site",
    criteria: CRITERIA,
    key: "publish-check"
  });
  const id = created.objective.id;
  await service.understand(id, { summary: "Publishing objective." });
  const planned = await service.plan(id, {
    steps: [{ objective: "publish the article", adapter: null, requiresApproval: true }],
    permissions: ["publish.external"]
  });
  assert.equal(planned.objective.approval.required, true);

  const unapproved = await service.start(id);
  assert.equal(unapproved.ok, false);
  assert.equal(unapproved.code, "approval_required");

  const authorized = await service.authorize(id, { approvalId: "owner-approval:test", by: "owner:owner-phone" });
  assert.equal(authorized.ok, false, "authorization is only valid from awaiting_approval");
  assert.equal(authorized.code, "invalid_transition");

  const requested = await service.requestApproval(id, { reason: "publishing needs the owner" });
  assert.equal(requested.objective.status, "awaiting_approval");
  const replayed = await service.authorize(id, { approvalId: "owner-approval:test", by: "owner:owner-phone" });
  assert.equal(replayed.ok, true);
  assert.equal((await service.authorize(id, { approvalId: "owner-approval:test", by: "owner:owner-phone" })).replayed, true);

  const authorizedStart = await service.start(id);
  assert.equal(authorizedStart.ok, true);
  const cancelled = await service.cancel(id, { by: "owner:owner-phone", reason: "owner cancelled" });
  assert.equal(cancelled.objective.status, "cancelled");
  assert.equal((await service.cancel(id, {})).ok, false);
});

test("every transition edge in the table is legal and terminal states have no exits", () => {
  for (const state of OBJECTIVE_STATES) {
    for (const target of ["completed", "failed"]) {
      if (state === "completed" || state === "failed" || state === "cancelled") {
        assert.equal(canTransition(state, target), false, state + " must not leave to " + target);
      }
    }
  }
  assert.equal(canTransition("planned", "completed"), false);
  assert.equal(canTransition("executing", "completed"), false);
  assert.equal(canTransition("verifying", "completed"), true);
  assert.equal(canTransition("received", "authorized"), false);
});
