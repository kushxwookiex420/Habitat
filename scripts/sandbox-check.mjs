#!/usr/bin/env node
import { detectSandbox, SANDBOX_BACKEND, SANDBOX_LIMITS } from "../nexus-sandbox.mjs";

/**
 * Portable sandbox capability report.
 *
 * Exists so CI (and an operator) can state *what* was actually verified instead of implying that a
 * green suite means the Linux isolation guarantees were exercised. It runs no untrusted command and
 * needs no privilege: it resolves host tools, probes unprivileged user namespaces, and prints one
 * JSON line.
 *
 * Exit codes:
 *   0  report produced (whether or not isolation is available)
 *   1  the report itself failed — treat this as a broken environment, not as "sandbox absent"
 *   2  `--require` was passed and the host cannot run the sandbox
 */

// The guarantees this mission requires, and which tier can prove each one.
const COVERAGE = Object.freeze({
  host_filesystem_isolation: "namespaces",
  checkout_boundary: "portable",
  secret_and_environment_isolation: "namespaces",
  network_isolation: "namespaces",
  symlink_and_path_traversal: "portable",
  child_process_containment: "namespaces",
  rlimit_cpu_memory_file_process: "namespaces",
  capability_drop_no_new_privs: "namespaces",
  timeout_and_process_tree_termination: "namespaces",
  output_redaction: "portable",
  fail_closed_on_missing_prerequisites: "portable"
});

const TIERS = Object.freeze({
  portable: "runs on any runner: tests/sandbox-security-contract.test.mjs",
  namespaces: "needs unprivileged user namespaces: tests/nexus-sandbox.test.mjs",
  dedicated: "needs a dedicated Linux security host: docs/SANDBOX_SECURITY.md"
});

const requireSandbox = process.argv.includes("--require");

try {
  const verdict = await detectSandbox();
  const report = {
    schemaVersion: 1,
    backend: verdict.backend || SANDBOX_BACKEND,
    available: Boolean(verdict.available),
    reason: verdict.reason,
    missing: verdict.missing || [],
    tools: verdict.tools || {},
    limits: SANDBOX_LIMITS,
    tiers: TIERS,
    coverage: Object.fromEntries(
      Object.entries(COVERAGE).map(([guarantee, tier]) => [
        guarantee,
        verdict.available || tier === "portable"
          ? { verified: tier === "portable", requires: tier }
          : { verified: false, requires: tier, blockedBy: verdict.reason }
      ])
    )
  };
  console.log(JSON.stringify(report));
  if (requireSandbox && !verdict.available) process.exit(2);
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: String(error?.message || error) }));
  process.exit(1);
}
