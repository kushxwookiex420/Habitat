#!/usr/bin/env node
/**
 * Staging deployment preflight.
 *
 * Turns "deploy 76e9330 carefully" into a machine-checked list: what changes between the commit the
 * staging service is actually running and the target commit, whether that diff touches anything that
 * needs its own approval (migrations, deployment config), and whether the autonomy flags are still off.
 *
 * It reads the live `/health` commit, so the deployed SHA is observed rather than assumed. It refuses a
 * production origin, and it prints no credential: it uses none.
 *
 * Exit codes: 0 = no blockers, 1 = blockers found, 2 = preflight could not run.
 */

const STAGING_HOST = "habitat-staging-e3ie.onrender.com";
const PRODUCTION_HOST = "habitat-1-szzd.onrender.com";
const AUTONOMY_FLAGS = ["NEXUS_RUNTIME_ENABLED", "HABITAT_MISSIONS_ENABLED", "HABITAT_WORKFORCE_ENABLED"];

export function parseStagingFlags(yamlText) {
  const text = String(yamlText || "");
  const value = (key) => {
    const match = new RegExp("-\\s*key:\\s*" + key + "\\s*\\n\\s*value:\\s*[\"']?([^\"'\\n]*)", "m").exec(text);
    return match ? match[1].trim() : null;
  };
  return {
    environment: value("HABITAT_ENVIRONMENT"),
    gateway: value("HABITAT_GATEWAY_ENABLED"),
    heartbeat: value("HABITAT_HEARTBEAT_ENABLED"),
    mcpEvents: value("HABITAT_MCP_EVENTS_ENABLED"),
    workforce: value("HABITAT_WORKFORCE_ENABLED"),
    missions: value("HABITAT_MISSIONS_ENABLED"),
    nexus: value("NEXUS_RUNTIME_ENABLED")
  };
}

export function classifyDiff(files = []) {
  const out = { migrations: [], deployment: [], production: [], security: [], code: [], tests: [], docs: [] };
  for (const raw of Array.isArray(files) ? files : []) {
    const file = String(raw || "").trim();
    if (!file) continue;
    if (file.startsWith("migrations/")) out.migrations.push(file);
    else if (file === "Dockerfile" || file.startsWith("deploy/") || file === "render.staging.yaml") out.deployment.push(file);
    else if (file === "render.yaml" || file.startsWith(".habitat-render-env")) out.production.push(file);
    else if (/(^|\/)(staging-guard|command-auth|ax-owner-attestation|ax-approval-gate)\.mjs$/.test(file)) out.security.push(file);
    else if (file.startsWith("tests/")) out.tests.push(file);
    else if (file.startsWith("docs/") || file.endsWith(".md")) out.docs.push(file);
    else out.code.push(file);
  }
  return out;
}

export function evaluatePreflight({ targetSha, deployedSha, files = [], flags = {}, expectedStagingHead = null } = {}) {
  const blockers = [];
  const warnings = [];
  const diff = classifyDiff(files);

  if (!targetSha) blockers.push({ code: "target_sha_required", detail: "Name the commit to deploy." });
  if (!deployedSha) blockers.push({ code: "deployed_sha_unknown", detail: "The live service did not report a commit; do not deploy blind." });
  if (targetSha && deployedSha && targetSha === deployedSha) {
    warnings.push({ code: "already_deployed", detail: "The service already reports the target commit." });
  }
  if (expectedStagingHead && targetSha && expectedStagingHead !== targetSha) {
    warnings.push({ code: "not_staging_head", detail: "The target is not the current head of staging/integration." });
  }

  for (const key of AUTONOMY_FLAGS) {
    const flagKey = key === "NEXUS_RUNTIME_ENABLED" ? "nexus"
      : key === "HABITAT_MISSIONS_ENABLED" ? "missions" : "workforce";
    const value = String(flags[flagKey] ?? "").trim().toLowerCase();
    if (value === "true") {
      blockers.push({ code: "autonomy_flag_enabled", detail: key + " is true in the staging blueprint; it must stay false until the round trip and escalation are verified." });
    }
  }
  if (String(flags.environment || "").trim().toLowerCase() !== "staging") {
    blockers.push({ code: "environment_not_marked_staging", detail: "HABITAT_ENVIRONMENT must be staging so the production-database guard is active." });
  }
  if (diff.migrations.length) {
    blockers.push({ code: "migrations_in_diff", detail: "This diff changes migrations; they need their own reviewed run before a deploy." });
  }
  if (diff.production.length) {
    blockers.push({ code: "production_config_in_diff", detail: "This diff touches production configuration; it is out of scope for a staging deploy." });
  }
  if (diff.deployment.length) {
    warnings.push({ code: "deployment_config_changed", detail: "Deployment files changed; confirm the built image reflects them." });
  }

  return {
    ok: blockers.length === 0,
    targetSha: targetSha || null,
    deployedSha: deployedSha || null,
    flags,
    diff,
    blockers,
    warnings
  };
}

/** The operator's checklist, printed so the procedure is not remembered but executed. */
export function deploymentProcedure({ targetSha, deployedSha } = {}) {
  return [
    "1. Render dashboard -> habitat-staging-e3ie -> Environment: confirm HABITAT_ENVIRONMENT=staging and the three autonomy flags are false.",
    "2. Confirm the service is the staging blueprint target (branch staging/integration, autoDeploy false).",
    "3. Manual Deploy, branch staging/integration, commit " + (targetSha ? targetSha.slice(0, 7) : "<target>") + ".",
    "4. Watch startup logs: expect STAGING_GUARD pass (no STAGING_GUARD_REFUSED_START) and NEXUS_RUNTIME: disabled.",
    "5. GET /health: commit must equal " + (targetSha ? targetSha.slice(0, 7) : "<target>") + ", deviceBridge.ready true, nexus.configured false.",
    "6. GET /system/status: environment.name staging with databaseGuardActive true, storage ready, gateway enabled, mcpEvents configured, workers.execution.canExecute false.",
    "7. Re-run unauthenticated probes: /ax/device/devices, /device/commands/next, /ax/command/diagnostics, /mcp must all answer 401.",
    "8. Rollback if any check fails: Render -> Deploys -> previous deploy (" + (deployedSha ? deployedSha.slice(0, 7) : "<previous>") + ") -> Redeploy. No data migration is involved."
  ];
}

function argValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1] || fallback;
}

function stagingOrigin() {
  const raw = String(process.env.STAGING_BASE_URL || ("https://" + STAGING_HOST)).trim();
  let url;
  try { url = new URL(raw); } catch { return { ok: false, code: "invalid_base_url" }; }
  if (url.protocol !== "https:") return { ok: false, code: "https_required" };
  if (url.hostname === PRODUCTION_HOST) return { ok: false, code: "refuses_production" };
  if (url.hostname !== STAGING_HOST) return { ok: false, code: "not_the_staging_host" };
  return { ok: true, origin: url.origin };
}

async function main() {
  const argv = process.argv.slice(2);
  const targetSha = argv.find((value, index) => index > 0 && argv[index - 1] === "--target") || argValue(argv, "--target");
  const report = { generatedAt: new Date().toISOString(), target: "staging", checks: {} };

  const base = stagingOrigin();
  if (!base.ok) {
    report.blocked = base.code;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  let deployedSha = null;
  try {
    const response = await fetch(base.origin + "/health", { signal: AbortSignal.timeout(120_000) });
    const body = await response.json();
    deployedSha = body?.commit || null;
    report.checks.health = { status: response.status, commit: deployedSha, nexusConfigured: body?.nexus?.configured ?? null };
  } catch (error) {
    report.blocked = "service_unreachable";
    report.error = String(error?.message || error).slice(0, 200);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  let files = [];
  let expectedStagingHead = null;
  // Resolve both sides to full SHAs before comparing: a short target equal to HEAD is the same commit,
  // and reporting it as "not the head" would be a false warning.
  let resolvedTarget = null;
  try {
    if (targetSha) resolvedTarget = git("rev-parse", "--verify", targetSha + "^{commit}");
    if (deployedSha && resolvedTarget && deployedSha !== resolvedTarget) {
      files = git("diff", "--name-only", deployedSha + ".." + resolvedTarget).split("\n").filter(Boolean);
    }
    expectedStagingHead = git("rev-parse", "HEAD");
  } catch (error) {
    report.blocked = "git_range_unavailable";
    report.error = String(error?.message || error).slice(0, 200);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const { readFile } = await import("node:fs/promises");
  let yaml = "";
  try { yaml = await readFile(new URL("../render.staging.yaml", import.meta.url), "utf8"); } catch { yaml = ""; }
  const flags = parseStagingFlags(yaml);

  const result = evaluatePreflight({ targetSha: resolvedTarget, deployedSha, files, flags, expectedStagingHead });
  report.targetSha = result.targetSha;
  report.deployedSha = result.deployedSha;
  report.checks.diff = result.diff;
  report.checks.flags = flags;
  report.blockers = result.blockers;
  report.warnings = result.warnings;
  report.procedure = deploymentProcedure({ targetSha, deployedSha });
  report.ok = result.ok;
  if (!result.ok) process.exitCode = 1;

  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, fatal: String(error?.message || error).slice(0, 300) }, null, 2));
    process.exitCode = 2;
  });
}
