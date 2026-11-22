#!/usr/bin/env node
/**
 * Mission 17 acceptance evidence.
 *
 * Runs the NEXUS acceptance suites (the work cycle and the bridge-level autonomous mission) with the
 * TAP reporter, records one machine-readable evidence file and exits non-zero if anything failed.
 *
 * This is local evidence. It reads no credential, writes no credential and never contacts Render,
 * D1 or a model provider. The objective/evidence stores in the acceptance run are memory
 * implementations of the same CAS contract the D1 repositories implement.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = ["tests/ax-work-cycle.test.mjs", "tests/ax-nexus-e2e.test.mjs"];

function run(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 240_000
  });
}

const startedAt = new Date().toISOString();
const result = run(process.execPath, ["--test", "--test-reporter=tap", ...SUITES]);
const stdout = result.stdout || "";
const stderr = result.stderr || "";
const checks = [...stdout.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)].map(match => ({
  ok: match[1] === "ok",
  name: match[2].trim()
}));
const failed = checks.filter(check => !check.ok);
const commit = (run("git", ["rev-parse", "HEAD"]).stdout || "").trim();
const branch = (run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim();

const evidence = {
  schemaVersion: 1,
  mission: "17",
  title: "NEXUS autonomous work cycle acceptance",
  generatedAt: startedAt,
  finishedAt: new Date().toISOString(),
  commit,
  branch,
  node: process.version,
  suites: SUITES,
  summary: {
    checked: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    exitCode: result.status
  },
  checks,
  operational: [
    "durable objective receipt, understanding, planning, authorization and execution transitions",
    "deterministic Director plan routed to memory, research, engineering, operations, security and verification",
    "read-only repository research with file/line citations and digests",
    "allowlisted engineering inspection with node --check and a test-backed correction proposal",
    "per-step evidence persistence and resume without repeating finished work",
    "independent verification against acceptance criteria before completion",
    "memory write after a verified completion",
    "authenticated NEXUS->Ax result and progress messages with a stable correlation id",
    "scheduler autonomy drives agent-oriented objectives through the work cycle",
    "stop and revoke controls with audit events"
  ],
  notVerifiedHere: [
    "No OpenAI or other model call: the Director plan is deterministic, so model planning quality is not measured.",
    "No Cloudflare D1 or Render deployment: the acceptance run uses memory repositories with the same CAS contract.",
    "No Android device, no APK build, no release gate and no production migration.",
    "The signature/verification check is keyword-based evidence coverage, not semantic proof.",
    "An in-flight agent call cannot be interrupted mid-call; stop takes effect before the next step."
  ],
  secretsExposed: false
};

await mkdir(path.join(ROOT, "release"), { recursive: true });
await writeFile(path.join(ROOT, "release", "mission-17-nexus-acceptance.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");

if (failed.length) console.error("FAILED: " + failed.map(check => check.name).join("; "));
if (result.status !== 0 && !failed.length) console.error("The test process exited " + result.status + ": " + stderr.slice(-400));
console.log(JSON.stringify(evidence.summary));
process.exit(result.status === 0 && failed.length === 0 && checks.length > 0 ? 0 : 1);
