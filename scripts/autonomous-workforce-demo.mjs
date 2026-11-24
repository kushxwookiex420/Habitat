#!/usr/bin/env node
/**
 * End-to-end demonstration: six real specialists executing real jobs through the existing durable
 * workforce, with an independent verifier and no model in the loop.
 *
 * The only injected things are the environment (in-memory SQLite behind the same D1 HTTP shape the
 * service uses) and the jobs. Every execution reads real files, runs a real test command, or performs
 * real arithmetic. Verification is a second computation by a different agent, not a rubber stamp.
 *
 * Deliberately included: one job that must fail (a test file that fails) and one that must block (a
 * corpus search with no hits), so the summary shows that a failed job is not reported as verified.
 *
 * Run: node scripts/autonomous-workforce-demo.mjs [--json]
 */

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { createWorkforceRepository } from "../d1-workforce-repository.mjs";
import { createDurableWorkforce } from "../ax-durable-workforce.mjs";
import { createWorkforceRunner } from "../ax-workforce-runner.mjs";
import { createWorkerExecutors, EXECUTOR_ADAPTERS, WORKER_SPECS } from "../worker-executors.mjs";

const ROOT = process.cwd();
const ARTIFACTS = path.join(".scratch", "workforce-demo-artifacts");
const quiet = { log() {}, warn() {}, error() {} };

function queryFrom(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };
}

/** A failing test file created for this run, so the failure is real and does not depend on a broken suite. */
const FAILING_TEST = `import test from "node:test";
import assert from "node:assert/strict";
test("intentionally failing probe", () => { assert.equal(1, 2); });
`;

const jobs = {
  "job-eng": { kind: "repo-analysis", dirs: ["tests"] },
  "job-syntax": { kind: "syntax-check", file: "worker-executors.mjs" },
  "job-qa": { kind: "tests", file: "tests/ax-priority-policy.test.mjs" },
  "job-qa-fail": { kind: "tests", file: "tests/fixtures/failing-probe.test.mjs" },
  "job-research": { kind: "corpus-search", query: "escalation", dirs: ["docs"] },
  "job-research-empty": { kind: "corpus-search", query: "zzzz-no-such-term-zzzz", dirs: ["docs"] },
  "job-business": {
    kind: "economics",
    fixedCostCents: 25_000,
    targetMarginBps: 3500,
    items: [
      { sku: "demo-001", priceCents: 4999, costCents: 1800, feeBps: 290, shippingCents: 600 },
      { sku: "demo-002", priceCents: 2499, costCents: 1600, feeBps: 290, shippingCents: 600 },
      { sku: "demo-003", priceCents: 8999, costCents: 3100, feeBps: 290, shippingCents: 900 }
    ]
  },
  "job-content": {
    kind: "brief",
    title: "Autonomous workforce demonstration brief",
    sections: [
      { heading: "Executed", bullets: ["six specialists ran real jobs", "each result was verified by a different agent"] },
      { heading: "Not claimed", bullets: ["no model was consulted", "no purchase, publish or deploy happened"] }
    ]
  },
  "job-ops": { kind: "ops-snapshot" }
};

async function main() {
  // A real failing test, written for this run and removed afterwards: the failure is produced, not staged.
  await writeFile(path.join(ROOT, "tests", "fixtures", "failing-probe.test.mjs"), FAILING_TEST, "utf8");

  const db = new DatabaseSync(":memory:");
  const repository = createWorkforceRepository({ query: queryFrom(db) });
  await repository.initialize();

  const kit = createWorkerExecutors({
    rootDir: ROOT,
    artifactsDir: ARTIFACTS,
    jobs,
    health: async () => ({ status: "ready", checks: { storage: true, workforce: true, nexus: false } })
  });

  // Adapters are catalog entries whose execute is the real executor, so nothing in the registry is a stub.
  // The registry validates kinds, and these are the six it accepts.
  const ADAPTER_KIND = {
    "eng.repo": "coding",
    "qa.tests": "analysis",
    "research.corpus": "research",
    "biz.economics": "analysis",
    "content.brief": "content",
    "ops.snapshot": "analysis",
    "verifier.recompute": "verification"
  };

  const workforce = createDurableWorkforce({ repository, adapters: [], log: quiet });
  for (const adapter of EXECUTOR_ADAPTERS) {
    const execute = kit.executors[adapter.id];
    const registered = await workforce.registerAdapter({
      id: adapter.id,
      kind: ADAPTER_KIND[adapter.id],
      description: "in-process real executor",
      execute,
      health: async () => ({ status: "healthy" })
    });
    if (!registered.ok) throw new Error("adapter registration failed: " + adapter.id + " " + registered.code);
  }

  for (const spec of WORKER_SPECS) {
    const registered = await workforce.registerAgent({
      id: spec.agentId,
      name: spec.specialty,
      specialty: spec.specialty,
      adapterId: spec.adapterId,
      capabilities: spec.capabilities,
      permissions: { allowed: spec.capabilities, denied: ["deploy", "purchase", "publish", "credential"] },
      availability: { maxConcurrent: 2 }
    });
    if (!registered.ok) throw new Error("agent registration failed: " + registered.code);
  }

  const assignmentByJob = {
    "job-eng": "worker-engineering",
    "job-syntax": "worker-engineering",
    "job-qa": "worker-qa",
    "job-qa-fail": "worker-qa",
    "job-research": "worker-research",
    "job-research-empty": "worker-research",
    "job-business": "worker-business",
    "job-content": "worker-content",
    "job-ops": "worker-operations"
  };

  const assigned = [];
  for (const [taskId, agentId] of Object.entries(assignmentByJob)) {
    const outcome = await workforce.assign({ taskId, agentId, requires: [], scopes: [], workspaceKey: null });
    assigned.push({ taskId, agentId, ok: outcome.ok, code: outcome.code || null });
  }

  const runner = createWorkforceRunner({
    workforce,
    executors: kit.executors,
    verifierAgentId: "worker-verifier",
    maxPerRun: 5,
    maxAttempts: 1,
    log: quiet
  });

  const runs = [];
  for (let pass = 1; pass <= 3; pass += 1) {
    const summary = await runner.runOnce();
    runs.push({ pass, attempted: summary.attempted, verified: summary.verified, unverified: summary.unverified, failed: summary.failed, skipped: summary.skipped });
    if (summary.attempted === 0) break;
  }

  const results = workforce.results().map((result) => ({
    taskId: result.taskId,
    agentId: result.agentId,
    status: result.status,
    code: result.code || null,
    verifiedBy: result.verifierAgentId || result.verifiedBy || null,
    evidence: result.evidence,
    tests: result.tests
  }));

  const byTask = Object.fromEntries(results.map((result) => [result.taskId, result]));
  const report = {
    generatedAt: new Date().toISOString(),
    execution: "in-process real executors (no model, no network)",
    artifacts: ARTIFACTS,
    agents: workforce.agents().map((agent) => ({ id: agent.id, specialty: agent.specialty, adapter: agent.adapterId, capabilities: agent.capabilities })),
    assigned,
    runs,
    results,
    outcome: {
      verified: results.filter((result) => result.status === "verified").length,
      failed: results.filter((result) => result.status === "failed").length,
      unverified: results.filter((result) => result.status === "unverified").length,
      failedJobReportedFailed: byTask["job-qa-fail"]?.status !== "verified",
      emptyResearchBlocked: ["blocked", "unverified", "failed"].includes(byTask["job-research-empty"]?.status),
      contentArtifact: byTask["job-content"]?.evidence?.find((line) => line.startsWith("content.file=")) || null
    }
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("AUTONOMOUS WORKFORCE DEMONSTRATION");
    console.log("agents:", report.agents.map((agent) => agent.specialty).join(", "));
    for (const result of results) {
      console.log(
        String(result.taskId).padEnd(20),
        String(result.status).padEnd(11),
        "verifiedBy=" + String(result.verifiedBy || "none").padEnd(16),
        (result.evidence || [])[0] || ""
      );
    }
    console.log("outcome:", JSON.stringify(report.outcome));
  }

  const ok = report.outcome.verified >= 6 &&
    report.outcome.failedJobReportedFailed === true &&
    report.outcome.contentArtifact !== null;
  if (!ok) process.exitCode = 1;
  await rm(path.join(ROOT, "tests", "fixtures", "failing-probe.test.mjs"), { force: true });
  if (!process.argv.includes("--keep")) await rm(path.join(ROOT, ARTIFACTS), { recursive: true, force: true });
}

main().catch((error) => {
  console.error("DEMO_FAILED", String(error?.message || error));
  process.exitCode = 1;
});
