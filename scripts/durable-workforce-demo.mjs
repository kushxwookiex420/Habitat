#!/usr/bin/env node
/**
 * Durable workforce, end to end, with a simulated restart between assignment and completion.
 *
 * 1. detect   — the improvement engine reads a real status snapshot and produces a finding
 * 2. intake   — the finding becomes a task and is assigned to an eligible agent (no human step)
 * 3. RESTART  — the first workforce instance is discarded; a new instance hydrates from SQLite
 * 4. execute  — the runner runs the agent's adapter, then an independent verifier's adapter
 * 5. result   — verified, approval required, approval still pending
 *
 * Tests are actually executed by the executors (`node --test tests/ax-workforce.test.mjs`), so the
 * evidence is a real run, not a canned string. No provider is called, so the cost is null.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkforceRepository } from "../d1-workforce-repository.mjs";
import { createDurableWorkforce } from "../ax-durable-workforce.mjs";
import { createImprovementMonitor } from "../ax-improvement.mjs";
import { createWorkforceIntake } from "../ax-workforce-intake.mjs";
import { createWorkforceRunner } from "../ax-workforce-runner.mjs";
import { buildSystemStatus } from "../system-status.mjs";

const REPO = process.cwd();
const dir = mkdtempSync(path.join(os.tmpdir(), "habitat-workforce-"));
const databasePath = path.join(dir, "workforce.db");
const log = (...args) => console.error(...args);
const quiet = { error() {}, warn() {}, log() {} };

function openDatabase() {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

function queryFrom(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };
}

function adapters() {
  return [
    {
      id: "local-coder",
      kind: "coding",
      description: "Runs the repository's own tests as its evidence.",
      execute: async () => ({ ok: true }),
      health: async () => ({ status: "healthy" })
    },
    {
      id: "local-verifier",
      kind: "verification",
      description: "Independent rerun of the same suite.",
      execute: async () => ({ ok: true })
    }
  ];
}

async function seed(workforce) {
  for (const adapter of adapters()) await workforce.registerAdapter(adapter);
  await workforce.registerAgent({
    id: "coder.local",
    name: "Local coder",
    specialty: "coding",
    adapterId: "local-coder",
    capabilities: ["coding", "tests"],
    permissions: { allowed: ["coding", "tests"], denied: ["deploy", "publish"] },
    limits: { maxTaskCents: 0 },
    workspace: { isolation: "git-worktree" },
    availability: { maxConcurrent: 2 }
  });
  await workforce.registerAgent({
    id: "verifier.local",
    name: "Independent verifier",
    specialty: "verification",
    adapterId: "local-verifier",
    capabilities: ["verification"],
    permissions: { allowed: ["verification"], denied: ["coding"] },
    availability: { maxConcurrent: 2 }
  });
}

function runSuite() {
  try {
    const stdout = execFileSync(process.execPath, ["--test", "tests/ax-workforce.test.mjs"], { cwd: REPO, encoding: "utf8" });
    const pass = Number((/^ℹ pass (\d+)/m.exec(stdout) || [])[1] || 0);
    const fail = Number((/^ℹ fail (\d+)/m.exec(stdout) || [])[1] || 0);
    return { ok: fail === 0 && pass > 0, pass, fail, evidence: "node --test tests/ax-workforce.test.mjs → " + pass + " pass, " + fail + " fail" };
  } catch (error) {
    const output = String(error?.stdout || "") + String(error?.stderr || "");
    const pass = Number((/^ℹ pass (\d+)/m.exec(output) || [])[1] || 0);
    const fail = Number((/^ℹ fail (\d+)/m.exec(output) || [])[1] || 0);
    return { ok: false, pass, fail, evidence: "node --test tests/ax-workforce.test.mjs → " + pass + " pass, " + fail + " fail" };
  }
}

// --- 1. detect -------------------------------------------------------------------------------
const status = buildSystemStatus({
  env: process.env,
  version: "0.8.6",
  commit: null,
  startedAtMs: Date.now() - 60_000,
  latencyMs: 1,
  registry: new Map(),
  tasks: [],
  deviceBridge: { durable: false, axTokenConfigured: Boolean(process.env.HABITAT_AX_BRIDGE_TOKEN), perDeviceTokens: true, nexus: { configured: false, reason: "disabled_by_config" } },
  devicePresence: { paired: 0, recentlySeen: false },
  storage: { taskRepositoryReady: false, contentJobRepositoryReady: false, dispatchLeaseReady: false, secretVaultReady: false },
  providers: {},
  routes: { chat: true },
  execution: { configured: false, reason: "disabled_by_config" }
});
const monitor = createImprovementMonitor({ readSignals: async () => ({ systemStatus: status }), now: () => Date.now() });
const pass = await monitor.check();
if (pass.findings.length === 0) {
  console.log(JSON.stringify({ ok: false, stage: "detect", detail: "no findings; nothing to delegate" }, null, 2));
  process.exit(0);
}
const finding = pass.findings.find(item => item.kind === "execution_blocked") || pass.findings[0];
log("[detect] " + finding.kind + " — " + finding.title);

// --- 2. intake -------------------------------------------------------------------------------
const db1 = openDatabase();
const repository = createWorkforceRepository({ query: queryFrom(db1) });
const first = createDurableWorkforce({ repository, adapters: adapters(), log: quiet });
await seed(first);
const intake = createWorkforceIntake({ workforce: first });
const task = await intake.intake(finding);
if (!task.ok) {
  console.log(JSON.stringify({ ok: false, stage: "intake", task }, null, 2));
  process.exit(1);
}
log("[intake] " + task.taskId + " → " + task.agentId + " (" + task.assignmentId + ")");
const beforeRestart = await repository.counts();

// --- 3. restart ------------------------------------------------------------------------------
// Discard the process-local engine entirely: closing the connection is what a restart looks like to
// the next instance, which has nothing but the store.
first.assignments();
db1.close();
log("[restart] closed the first instance");

const db2 = openDatabase();
const repository2 = createWorkforceRepository({ query: queryFrom(db2) });
const second = createDurableWorkforce({ repository: repository2, adapters: adapters(), log: quiet });
const hydrated = await second.hydrate();
const recovered = second.assignments().filter(item => item.state === "active");
log("[restart] hydrated " + hydrated.agents + " agents, " + hydrated.assignments + " assignments; active=" + recovered.length);
if (recovered.length !== 1) {
  console.log(JSON.stringify({ ok: false, stage: "restart", hydrated, recovered }, null, 2));
  process.exit(1);
}

// --- 4. execute ------------------------------------------------------------------------------
const suite = runSuite();
const runner = createWorkforceRunner({
  workforce: second,
  executors: {
    "local-coder": async () => ({
      result: {
        status: suite.ok ? "completed" : "failed",
        evidence: [suite.evidence, "finding: " + finding.detail],
        changedFiles: [],
        tests: { ran: suite.pass + suite.fail, passed: suite.pass, failed: suite.fail },
        costCents: null
      }
    }),
    "local-verifier": async () => {
      const independent = runSuite();
      return { ok: independent.ok, evidence: ["independent rerun: " + independent.evidence], tests: { ran: independent.pass + independent.fail, passed: independent.pass, failed: independent.fail } };
    }
  },
  verifierAgentId: "verifier.local",
  log: quiet
});
const run = await runner.runOnce();
log("[execute] " + JSON.stringify(run.tasks));

// --- 5. result -------------------------------------------------------------------------------
const db3 = openDatabase();
const repository3 = createWorkforceRepository({ query: queryFrom(db3) });
const third = createDurableWorkforce({ repository: repository3, adapters: adapters(), log: quiet });
await third.hydrate();
const results = third.results();
const stored = (await repository3.listResults())[0] || null;
const audit = await repository3.listAudit({ limit: 200 });
db3.close();

console.log(JSON.stringify({
  ok: results.some(item => item.status === "verified"),
  finding: { kind: finding.kind, title: finding.title, evidence: finding.evidence },
  task: { taskId: task.taskId, assignmentId: task.assignmentId, agentId: task.agentId, requires: task.requires },
  restart: { countsBefore: beforeRestart, hydrated, activeRecovered: recovered.length },
  run,
  result: results[0] ? {
    status: results[0].status,
    verifierAgentId: results[0].verifierAgentId,
    implementer: results[0].agentId,
    approvalRequired: results[0].approvalRequired,
    approvalState: stored?.approvalState || null,
    costMeasured: results[0].costMeasured,
    tests: results[0].tests,
    evidence: results[0].evidence
  } : null,
  auditEvents: audit.length,
  auditTail: audit.slice(-4).map(item => item.action),
  database: databasePath,
  note: "Verification is not approval: approvalState stays 'required' until the owner decides."
}, null, 2));

rmSync(dir, { recursive: true, force: true });
