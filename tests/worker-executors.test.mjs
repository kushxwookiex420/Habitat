import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  computeEconomics, createWorkerExecutors, EXECUTOR_LIMITS
} from "../worker-executors.mjs";

const ROOT = process.cwd();
const ARTIFACTS = ".scratch/worker-test-artifacts";

function kit(jobs, extra = {}) {
  return createWorkerExecutors({ rootDir: ROOT, artifactsDir: ARTIFACTS, jobs, ...extra });
}

const ctx = (taskId) => ({ taskId, assignment: { id: "asg1", taskId, agentId: "worker-x" }, agent: { id: "worker-x" } });

test("economics is real arithmetic: fees, contribution, margin and break-even", () => {
  const { rows, totals } = computeEconomics(
    [{ sku: "d-001", priceCents: 5000, costCents: 2000, feeBps: 300, shippingCents: 500 }],
    { fixedCostCents: 10_000, targetMarginBps: 3000 }
  );
  assert.equal(rows[0].fees, 150);
  assert.equal(rows[0].contributionCents, 2350);
  assert.equal(rows[0].marginBps, 4700);
  assert.equal(rows[0].belowTarget, false);
  assert.equal(rows[0].breakEvenUnits, 5);
  assert.equal(totals.contributionCents, 2350);

  const thin = computeEconomics([{ sku: "bad", priceCents: 1000, costCents: 900, feeBps: 1500 }], { targetMarginBps: 3000 });
  assert.equal(thin.rows[0].belowTarget, true);
});

test("the engineering worker reads real files and its digest is reproducible", async () => {
  const { executors, compute } = kit({ t1: { kind: "repo-analysis", dirs: ["tests"] } });
  const first = await executors["eng.repo"](ctx("t1"));
  const second = await compute({ kind: "repo-analysis", dirs: ["tests"], taskId: "t1" });
  assert.equal(first.result.status, "completed");
  assert.ok(first.result.data.files > 10, "it really walked the tests directory");
  assert.deepEqual(first.result.evidence, second.evidence, "same inputs produce the same evidence");
});

test("the engineering worker refuses a path outside the repository", async () => {
  const { executors } = kit({ t1: { kind: "repo-analysis", dirs: ["../../etc"] } });
  const out = await executors["eng.repo"](ctx("t1"));
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.code, "path_outside_root");
  assert.deepEqual(out.result.changedFiles, []);
});

test("the QA worker runs a real test file and reports its own counts", async () => {
  const { executors } = kit({ t1: { kind: "tests", file: "tests/ax-priority-policy.test.mjs" } });
  const out = await executors["qa.tests"](ctx("t1"));
  assert.equal(out.result.status, "completed");
  assert.equal(out.result.data.exit, 0);
  assert.ok(out.result.tests.passed >= 10, "the real suite reported its passes");
  assert.equal(out.result.tests.failed, 0);
  assert.equal(out.result.tests.ran, out.result.tests.passed);
});

test("the QA worker refuses a file that is not an allowlisted test", async () => {
  const { executors } = kit({ t1: { kind: "tests", file: "../etc/passwd" } });
  const out = await executors["qa.tests"](ctx("t1"));
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.code, "test_not_allowlisted");
  assert.equal(out.result.tests.ran, 0);
});

test("the research worker returns real corpus hits with a stable digest", async () => {
  const { executors, compute } = kit({ t1: { kind: "corpus-search", query: "escalation", dirs: ["docs"] } });
  const out = await executors["research.corpus"](ctx("t1"));
  assert.equal(out.result.status, "completed");
  assert.ok(out.result.data.total > 0, "the word really appears in the docs");
  assert.ok(out.result.evidence.some((line) => line.startsWith("research.digest=")));
  const again = await compute({ kind: "corpus-search", query: "escalation", dirs: ["docs"], taskId: "t1" });
  assert.deepEqual(out.result.evidence, again.evidence);
});

test("the content worker writes a real artifact and the verifier checks its hash", async () => {
  const taskId = "brief-1";
  const { executors, verify } = kit({
    [taskId]: { kind: "brief", title: "Worker brief", sections: [{ heading: "Findings", bullets: ["real evidence only"] }] }
  });
  const out = await executors["content.brief"](ctx(taskId));
  assert.equal(out.result.status, "completed");
  const written = out.result.changedFiles[0];
  assert.match(written, /^\.scratch\/worker-test-artifacts\/brief-1\.md$/);

  const verdict = await verify({ taskId, implementation: out });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.evidence));

  const tampered = { result: { ...out.result, evidence: out.result.evidence.map((line) => line.replace(/sha256=.*/, "sha256=deadbeef")) } };
  const refused = await verify({ taskId, implementation: tampered });
  assert.equal(refused.ok, false, "a wrong digest is not verification");
  assert.ok(refused.evidence.some((line) => /hash_mismatch|evidence_match=false/.test(line)));

  await rm(path.join(ROOT, ARTIFACTS), { recursive: true, force: true });
});

test("the operations worker blocks on a failing health check", async () => {
  const ok = kit({ t1: { kind: "ops-snapshot" } }, { health: async () => ({ status: "ready", checks: { storage: true, nexus: true } }) });
  assert.equal((await ok.executors["ops.snapshot"](ctx("t1"))).result.status, "completed");

  const failing = kit({ t1: { kind: "ops-snapshot" } }, { health: async () => ({ status: "degraded", checks: { storage: true, nexus: false } }) });
  const blocked = await failing.executors["ops.snapshot"](ctx("t1"));
  assert.equal(blocked.result.status, "blocked");
  assert.ok(blocked.result.evidence.includes("ops.failing=nexus"));

  const none = kit({ t1: { kind: "ops-snapshot" } });
  assert.equal((await none.executors["ops.snapshot"](ctx("t1"))).result.code, "health_provider_missing");
});

test("missing or unknown jobs never produce a fabricated success", async () => {
  const { executors, verify } = kit({ t1: { kind: "definitely-not-a-kind" } });
  const unknown = await executors["eng.repo"](ctx("t1"));
  assert.equal(unknown.result.status, "failed");
  assert.equal(unknown.result.code, "unknown_job_kind");

  const missing = await executors["eng.repo"](ctx("no-such-task"));
  assert.equal(missing.result.status, "blocked");
  assert.equal(missing.result.code, "job_not_supplied");

  const verdict = await verify({ taskId: "t1", implementation: unknown });
  assert.equal(verdict.ok, false, "a failed implementation can never verify");
});

test("artifactsDir outside the repository is refused at construction", () => {
  assert.throws(() => createWorkerExecutors({ rootDir: ROOT, artifactsDir: "../outside" }), /inside rootDir/);
  assert.ok(EXECUTOR_LIMITS.maxFiles >= 100);
});
