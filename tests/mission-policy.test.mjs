import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_CLASSES,
  approvalBinding,
  approvalValid,
  backoffFor,
  budgetState,
  classifyAction,
  classifyFailure
} from "../ax-mission-policy.mjs";

test("actions are classified into the four policy classes", () => {
  assert.equal(classifyAction({ title: "Inspect tests", requires: ["engineering"] }).class, ACTION_CLASSES.readOnly);
  assert.equal(classifyAction({ title: "Patch the reporter", requires: ["engineering"] }).class, ACTION_CLASSES.reversible);
  assert.equal(classifyAction({ title: "Deploy to production" }).class, ACTION_CLASSES.consequential);
  assert.equal(classifyAction({ title: "Deploy to production" }).allowed, true, "consequential is allowed with approval");
  const prohibited = classifyAction({ title: "Drop table missions on production" });
  assert.equal(prohibited.class, ACTION_CLASSES.prohibited);
  assert.equal(prohibited.allowed, false, "prohibited work is refused, not approved");
  assert.equal(classifyAction({ title: "force push --force to main" }).class, ACTION_CLASSES.prohibited);
});

test("an approval is bound to the exact action, target and parameters", () => {
  const base = { missionId: "m1", taskId: "t1", action: "deploy", target: "staging", params: { region: "iad", replicas: 2 } };
  const fingerprint = approvalBinding(base);
  assert.match(fingerprint, /^ap:[0-9a-f]{32}$/);
  assert.equal(approvalBinding(base), fingerprint, "canonical ordering makes the fingerprint stable");
  assert.equal(approvalBinding({ ...base, params: { replicas: 2, region: "iad" } }), fingerprint, "param order is irrelevant");
  assert.notEqual(approvalBinding({ ...base, target: "production" }), fingerprint, "a different target is a different action");
  assert.notEqual(approvalBinding({ ...base, taskId: "t2" }), fingerprint);
  assert.notEqual(approvalBinding({ ...base, params: { region: "iad", replicas: 3 } }), fingerprint);
});

test("an approval cannot authorise a changed, expired, undated or unbound action", () => {
  const now = "2026-11-24T12:00:00.000Z";
  const fingerprint = approvalBinding({ missionId: "m1", taskId: "t1", action: "deploy", target: "staging" });
  const approved = { decision: "approved", fingerprint, grantedAt: "2026-11-24T11:50:00.000Z", expiresAt: "2026-11-24T12:10:00.000Z" };
  assert.deepEqual(approvalValid(approved, { fingerprint, now }), { ok: true, code: "approval_valid" });
  assert.equal(approvalValid(approved, { fingerprint: approvalBinding({ missionId: "m1", taskId: "t1", action: "deploy", target: "production" }), now }).code, "approval_action_changed");
  assert.equal(approvalValid(approved, { fingerprint, now: "2026-11-24T12:10:00.000Z" }).code, "approval_expired");
  assert.equal(approvalValid({ ...approved, grantedAt: null }, { fingerprint, now }).code, "approval_undated");
  assert.equal(approvalValid({ ...approved, fingerprint: null }, { fingerprint, now }).code, "approval_unbound");
  assert.equal(approvalValid({ ...approved, decision: "rejected" }, { fingerprint, now }).code, "approval_not_granted");
  assert.equal(approvalValid(null, { fingerprint, now }).code, "approval_missing");
  // A stale approval without expiresAt still expires by age.
  const old = { ...approved, grantedAt: "2026-11-24T10:00:00.000Z", expiresAt: null };
  assert.equal(approvalValid(old, { fingerprint, now }).code, "approval_expired");
});

test("transient and permanent failures are separated, and only transient ones retry", () => {
  assert.deepEqual(classifyFailure({ status: "failed", error: "executor_timeout" }), { kind: "transient", code: "executor_timeout", retryable: true });
  assert.deepEqual(classifyFailure({ status: "failed", error: "verification_failed" }), { kind: "transient", code: "verification_failed", retryable: true });
  assert.equal(classifyFailure({ status: "failed", error: "unroutable_task" }).retryable, false);
  assert.equal(classifyFailure({ status: "failed", error: "no_independent_verifier" }).retryable, false);
  assert.equal(classifyFailure({ status: "failed", error: "approval_required" }).kind, "permanent");
  assert.equal(classifyFailure({ status: "failed", error: "syntax_error" }).kind, "permanent", "an unknown non-executor failure is not silently retried");
});

test("backoff is bounded and deterministic", () => {
  assert.deepEqual([0, 1, 2, 3].map((attempt) => backoffFor(attempt)), [1000, 2000, 4000, 8000]);
  assert.equal(backoffFor(50), 30_000, "capped");
  assert.equal(backoffFor(-5), 1000);
});

test("budgets stop the mission with a specific reason", () => {
  const startedAt = "2026-11-24T12:00:00.000Z";
  const now = Date.parse("2026-11-24T12:01:00.000Z");
  assert.equal(budgetState({ startedAt, now }).exhausted, false);
  assert.equal(budgetState({ startedAt, now, roundsUsed: 3, maxRounds: 3 }).reason, "budget_rounds");
  assert.equal(budgetState({ startedAt, now, maxDurationMs: 30_000 }).reason, "budget_duration");
  assert.equal(budgetState({ startedAt, now, repairsUsed: 2, maxRepairs: 1 }).reason, "budget_repairs");
});
