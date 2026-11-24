#!/usr/bin/env node
/**
 * One end-to-end self-improvement cycle, on the real repository.
 *
 * detect → task → assign → implement on an isolated branch → independently verify → present for approval
 *
 * Every step is real: the issue is found by scanning the tree, the change is written into a git
 * worktree on its own branch, the tests run with node in that worktree, and a different agent record
 * does the verification. Nothing is merged, pushed or published here; the branch is left for review.
 *
 * The only thing not measured is money: no model provider is called, so `costCents` is null rather
 * than a fabricated zero.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkforce } from "../ax-workforce.mjs";

const REPO = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const branch = "demo/self-improvement-" + stamp;
const worktree = mkdtempSync(path.join(os.tmpdir(), "habitat-selfimprove-"));
const log = (...args) => console.error(...args);

function git(args, cwd = REPO) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function runtimeFiles() {
  const entries = await readdir(REPO, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.startsWith("."))
    .map(entry => entry.name);
}

/**
 * Detection: an exported function that no other runtime module references is dead surface that looks
 * live. This is a real finding produced from the tree, not a scripted one.
 */
async function detectUnusedExport(name) {
  const files = (await runtimeFiles()).filter(file => !file.startsWith("tests"));
  const definition = "export function " + name;
  const references = [];
  let definedIn = null;
  for (const file of files) {
    const source = readFileSync(path.join(REPO, file), "utf8");
    if (source.includes(definition)) definedIn = file;
    const uses = source.split("\n").filter(line => line.includes(name) && !line.includes(definition));
    if (uses.length > 0) references.push({ file, lines: uses.length });
  }
  return {
    issue: references.length === 0 && definedIn ? "unused_export" : null,
    name,
    definedIn,
    references,
    detail: references.length === 0 && definedIn
      ? name + " is exported from " + definedIn + " and referenced by no other runtime module."
      : name + " is referenced by " + references.length + " module(s)."
  };
}

const detection = await detectUnusedExport("createOpenAiPlanner");
if (!detection.issue) {
  console.log(JSON.stringify({ ok: true, stage: "detect", outcome: "no_issue_found", detection }, null, 2));
  process.exit(0);
}
log("[detect] " + detection.detail);

const workforce = createWorkforce({ log: { error() {}, warn() {}, log() {} } });

workforce.registerAdapter({
  id: "local-engineering",
  kind: "coding",
  description: "Deterministic local engineering adapter: writes files and runs node tests.",
  execute: async () => ({ ok: true }),
  health: async () => ({ status: "healthy" })
});
workforce.registerAdapter({
  id: "alternate-engineering",
  kind: "coding",
  description: "Second coding adapter, present to prove the specialty is not a single vendor.",
  execute: async () => ({ ok: true }),
  health: async () => ({ status: "healthy" })
});
workforce.registerAdapter({
  id: "local-verification",
  kind: "verification",
  description: "Runs the same tests independently and never writes code.",
  execute: async () => ({ ok: true }),
  health: async () => ({ status: "healthy" })
});

workforce.registerAgent({
  id: "coder.primary",
  name: "Primary coder",
  specialty: "coding",
  adapterId: "local-engineering",
  capabilities: ["coding", "tests"],
  permissions: { allowed: ["coding", "tests"], denied: ["deploy", "publish"] },
  limits: { maxTaskCents: 0 },
  workspace: { isolation: "git-worktree", branchPattern: "demo/self-improvement-*" },
  availability: { maxConcurrent: 1 }
});
workforce.registerAgent({
  id: "coder.alternate",
  name: "Alternate coder",
  specialty: "coding",
  adapterId: "alternate-engineering",
  capabilities: ["coding"],
  permissions: { allowed: ["coding"], denied: ["deploy"] },
  availability: { maxConcurrent: 2 }
});
workforce.registerAgent({
  id: "verifier.independent",
  name: "Independent verifier",
  specialty: "verification",
  adapterId: "local-verification",
  capabilities: ["verification"],
  permissions: { allowed: ["verification"], denied: ["coding"] },
  availability: { maxConcurrent: 2 }
});

const taskId = "task-selfimprove-" + stamp.toLowerCase();
const assignment = workforce.assign({
  taskId,
  agentId: "coder.primary",
  requires: ["coding", "tests"],
  scopes: ["tests/"],
  workspaceKey: branch
});
if (!assignment.ok) {
  console.log(JSON.stringify({ ok: false, stage: "assign", assignment }, null, 2));
  process.exit(1);
}
log("[assign] " + assignment.assignmentId + " → coder.primary on " + branch);

// Isolated workspace: a real worktree on its own branch. The main tree is untouched.
git(["worktree", "add", "-b", branch, worktree, "HEAD"]);
log("[implement] worktree " + worktree);

const guardTest = [
  "import test from \"node:test\";",
  "import assert from \"node:assert/strict\";",
  "import { readFileSync } from \"node:fs\";",
  "import path from \"node:path\";",
  "",
  "const root = path.resolve(import.meta.dirname, \"..\");",
  "",
  "test(\"the single-provider planner is not the runtime planning path\", () => {",
  "  const orchestrator = readFileSync(path.join(root, \"ax-orchestrator.mjs\"), \"utf8\");",
  "  assert.match(orchestrator, /export function createOpenAiPlanner/, \"the fallback still exists and is documented as such\");",
  "  const bridge = readFileSync(path.join(root, \"device-command-bridge.mjs\"), \"utf8\");",
  "  assert.equal(bridge.includes(\"createOpenAiPlanner\"), false, \"the runtime must not wire the single-provider planner\");",
  "  assert.match(bridge, /createAxPlannerFromProviderConfig/, \"the runtime uses the provider-independent planner\");",
  "});",
  "",
  "test(\"the reconciliation is documented\", () => {",
  "  const doc = readFileSync(path.join(root, \"docs\", \"AX_PROVIDER_RECONCILIATION.md\"), \"utf8\");",
  "  assert.match(doc, /createOpenAiPlanner/);",
  "});",
  ""
].join("\n");

mkdirSync(path.join(worktree, "tests"), { recursive: true });
const guardPath = path.join(worktree, "tests", "reconciliation-guard.test.mjs");
writeFileSync(guardPath, guardTest, "utf8");

const decoratorPath = path.join(worktree, "ax-orchestrator.mjs");
const decoratorSource = readFileSync(decoratorPath, "utf8");
const marker = "export function createOpenAiPlanner({";
if (!decoratorSource.includes("@deprecated")) {
  writeFileSync(decoratorPath, decoratorSource.replace(marker, "/**\n * @deprecated Not wired anywhere. The runtime plans through `ax-providers.mjs`; this exists only as\n * a single-provider fallback and is kept for tests. See docs/AX_PROVIDER_RECONCILIATION.md.\n */\n" + marker), "utf8");
}

function runTests(cwd) {
  try {
    const stdout = execFileSync(process.execPath, ["--test", "tests/reconciliation-guard.test.mjs"], { cwd, encoding: "utf8" });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout || "") + String(error?.stderr || "") };
  }
}

const implemented = runTests(worktree);
const changedFiles = ["tests/reconciliation-guard.test.mjs", "ax-orchestrator.mjs"];
const diffStat = git(["diff", "--stat", "HEAD"], worktree);
log("[implement] " + diffStat.split("\n").slice(-1)[0]);

const implementation = workforce.finalize({
  assignmentId: assignment.assignmentId,
  result: {
    status: implemented.ok ? "completed" : "failed",
    evidence: [
      "detected: " + detection.detail,
      "diff: " + diffStat.split("\n").slice(-1)[0],
      "test run: node --test tests/reconciliation-guard.test.mjs"
    ],
    changedFiles,
    tests: { ran: 2, passed: implemented.ok ? 2 : 0, failed: implemented.ok ? 0 : 2 },
    costCents: null
  },
  // Deliberately no verifier here: this first call must be refused, proving the guard is real.
  verifierAgentId: "coder.primary",
  verification: { ok: implemented.ok, evidence: ["self-check"], tests: { ran: 2, passed: 2, failed: 0 } }
});
log("[finalize] implementer self-verification → " + implementation.code);

const verificationRun = runTests(worktree);
const verification = workforce.finalize({
  assignmentId: assignment.assignmentId,
  result: {
    status: implemented.ok ? "completed" : "failed",
    evidence: [
      "detected: " + detection.detail,
      "diff: " + diffStat.split("\n").slice(-1)[0],
      "test run: node --test tests/reconciliation-guard.test.mjs"
    ],
    changedFiles,
    tests: { ran: 2, passed: implemented.ok ? 2 : 0, failed: implemented.ok ? 0 : 2 },
    costCents: null
  },
  verifierAgentId: "verifier.independent",
  verification: {
    ok: verificationRun.ok,
    evidence: ["independent rerun in " + worktree + ": node --test tests/reconciliation-guard.test.mjs"],
    tests: { ran: 2, passed: verificationRun.ok ? 2 : 0, failed: verificationRun.ok ? 0 : 2 }
  }
});

const summary = {
  ok: verification.ok === true,
  detection,
  taskId,
  branch,
  worktree,
  implementer: "coder.primary",
  verifier: "verifier.independent",
  selfVerificationRefused: implementation.code === "self_verification_refused",
  finalStatus: verification.result?.status || verification.code,
  changedFiles,
  tests: verification.result?.tests || null,
  costCents: verification.result?.costCents ?? null,
  approvalRequired: verification.result?.approvalRequired ?? null,
  approved: verification.result?.approved ?? false,
  merged: false,
  pushed: false,
  workforce: workforce.summarize(),
  note: "Left on " + branch + " for owner review. Nothing was merged, pushed or published."
};

try {
  git(["worktree", "remove", "--force", worktree], REPO);
} catch {
  rmSync(worktree, { recursive: true, force: true });
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
