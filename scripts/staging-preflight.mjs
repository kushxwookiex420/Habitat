#!/usr/bin/env node
/**
 * Staging preflight — validate every prerequisite before a D1 staging database exists.
 *
 * Usage:
 *   node scripts/staging-preflight.mjs            # human table, exit 1 on a blocking failure
 *   node scripts/staging-preflight.mjs --json     # machine-readable report
 *
 * It never prints a credential value and never writes to D1, Cloudflare or any service. The only
 * optional network call is a read-only token verification, and only when credentials are present.
 *
 * Checks are split into two classes:
 *   - repository checks, which must pass on any checkout (migrations, routes, container contract);
 *   - staging checks, which stay failed until the owner supplies the staging credentials.
 * A report is only `ok` when both classes pass, so "preflight green" always means "safe to provision".
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// D1 database ids are UUIDs. A guard against "staging is production" is worthless if one id is a
// truncated string that can never match, so a malformed id blocks instead of silently passing.
const D1_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIGRATIONS_FOR_P1 = Object.freeze([
  "0008_ax_capability_registry.sql",
  "0009_ax_fulfillment_treasury.sql"
]);

const NETWORK_ROUTES = Object.freeze([
  "/ax/command/network/status",
  "/ax/command/network/capabilities",
  "/ax/command/network/treasury",
  "/ax/command/network/approvals"
]);

function read(rootDir, relative) {
  const file = path.join(rootDir, relative);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function check(name, ok, detail, extra = {}) {
  return { name, ok: Boolean(ok), detail, ...extra };
}

/**
 * @param {object} input
 * @param {object} [input.env]
 * @param {string} [input.rootDir]
 * @param {Function} [input.fetchImpl]
 */
export async function runStagingPreflight({ env = process.env, rootDir = process.cwd(), fetchImpl = fetch } = {}) {
  const checks = [];
  const value = name => String(env[name] || "").trim();

  // --- repository checks -------------------------------------------------------------------
  const pkgText = read(rootDir, "package.json");
  let pkg = null;
  try { pkg = pkgText ? JSON.parse(pkgText) : null; } catch { pkg = null; }
  const engine = pkg?.engines?.node || "";
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(check(
    "node_version",
    major >= 22,
    "running node " + process.versions.node + (engine ? ", package requires " + engine : ""),
    { blocking: true }
  ));

  const migrationNames = MIGRATIONS_FOR_P1.map((name) => {
    const text = read(rootDir, path.join("migrations", name));
    return { name, present: Boolean(text && text.trim()), bytes: text ? text.length : 0 };
  });
  checks.push(check(
    "p1_migrations_present",
    migrationNames.every((item) => item.present && item.bytes > 0),
    migrationNames.map((item) => item.name + "=" + (item.present ? item.bytes + "B" : "MISSING")).join(" "),
    { blocking: true }
  ));

  // A gap in the numbering means an apply loop would stop or skip a required schema step.
  const migrationDir = path.join(rootDir, "migrations");
  let listed = [];
  try {
    listed = readdirSync(migrationDir).filter((name) => name.endsWith(".sql"));
  } catch {
    listed = [];
  }
  const sequence = listed.map((name) => Number(name.slice(0, 4))).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  const contiguous = sequence.length > 0 && sequence.every((n, index) => index === 0 || n === sequence[index - 1] + 1);
  checks.push(check(
    "migration_sequence_contiguous",
    contiguous,
    sequence.length ? "found " + sequence.map((n) => String(n).padStart(4, "0")).join(",") : "no numbered migrations found",
    { blocking: true }
  ));

  const routes = read(rootDir, "command-routes.mjs") || "";
  const missingRoutes = NETWORK_ROUTES.filter((route) => !routes.includes(route));
  checks.push(check(
    "network_routes_present",
    missingRoutes.length === 0,
    missingRoutes.length ? "missing: " + missingRoutes.join(", ") : "all " + NETWORK_ROUTES.length + " sampled routes registered",
    { blocking: true }
  ));
  checks.push(check(
    "scheduler_tick_route_present",
    routes.includes("/ax/command/scheduler/tick"),
    routes.includes("/ax/command/scheduler/tick") ? "tick route registered" : "tick route absent: the expiry sweep cannot run",
    { blocking: true }
  ));

  const server = read(rootDir, "server.mjs") || "";
  const hasPort = /process\.env\.PORT/.test(server);
  const hasHealth = server.includes("/health");
  checks.push(check(
    "container_contract",
    hasPort && hasHealth && existsSync(path.join(rootDir, "Dockerfile")),
    "Dockerfile=" + existsSync(path.join(rootDir, "Dockerfile")) + " PORT=" + hasPort + " /health=" + hasHealth,
    { blocking: true }
  ));
  checks.push(check(
    "health_reports_commit",
    server.includes("commit"),
    server.includes("commit") ? "/health exposes the running commit for deployment verification" : "/health does not report a commit; drift cannot be proven",
    { blocking: false }
  ));

  // --- safety ------------------------------------------------------------------------------
  const nexus = value("NEXUS_RUNTIME_ENABLED").toLowerCase();
  checks.push(check(
    "nexus_runtime_disabled",
    nexus !== "true" && nexus !== "1",
    nexus ? "NEXUS_RUNTIME_ENABLED is set to " + nexus : "NEXUS_RUNTIME_ENABLED is unset (worker off)",
    { blocking: true, code: nexus === "true" || nexus === "1" ? "nexus_runtime_enabled" : null }
  ));

  // The repository's D1 code reads HABITAT_D1_API_TOKEN; Wrangler and the REST API read
  // CLOUDFLARE_API_TOKEN. Either name is accepted so the owner does not have to duplicate a secret.
  const token = value("HABITAT_D1_API_TOKEN") || value("CLOUDFLARE_API_TOKEN");
  const tokenSource = value("HABITAT_D1_API_TOKEN") ? "HABITAT_D1_API_TOKEN" : (value("CLOUDFLARE_API_TOKEN") ? "CLOUDFLARE_API_TOKEN" : null);
  const missingNames = [];
  if (!value("CLOUDFLARE_ACCOUNT_ID")) missingNames.push("CLOUDFLARE_ACCOUNT_ID");
  if (!token) missingNames.push("HABITAT_D1_API_TOKEN (or CLOUDFLARE_API_TOKEN)");
  if (!value("STAGING_D1_DATABASE_ID")) missingNames.push("STAGING_D1_DATABASE_ID");
  if (!value("PRODUCTION_D1_DATABASE_ID")) missingNames.push("PRODUCTION_D1_DATABASE_ID");
  checks.push(check(
    "staging_credentials_present",
    missingNames.length === 0,
    missingNames.length ? "missing: " + missingNames.join(", ") : "all staging variables present (values not printed; token from " + tokenSource + ")",
    { blocking: true, code: missingNames.length ? "credentials_missing" : null }
  ));

  const stagingId = value("STAGING_D1_DATABASE_ID");
  const productionId = value("PRODUCTION_D1_DATABASE_ID");
  const malformed = [
    ["STAGING_D1_DATABASE_ID", stagingId],
    ["PRODUCTION_D1_DATABASE_ID", productionId]
  ].filter(([, id]) => id && !D1_ID_PATTERN.test(id)).map(([name]) => name);
  checks.push(check(
    "database_id_format",
    malformed.length === 0,
    malformed.length
      ? "not a D1 UUID: " + malformed.join(", ") + " — re-copy from the dashboard; the isolation guard cannot work with a malformed id"
      : (stagingId && productionId ? "both ids are D1 UUIDs" : "cannot validate until both ids are present"),
    { blocking: true, code: malformed.length ? "database_id_malformed" : null }
  ));

  const isolated = Boolean(stagingId && productionId) && stagingId !== productionId;
  checks.push(check(
    "database_isolation",
    isolated,
    stagingId && productionId
      ? (isolated ? "staging id differs from production id" : "staging id equals the production id")
      : "cannot compare until both ids are present",
    { blocking: true, code: isolated || !stagingId || !productionId ? null : "staging_is_production" }
  ));

  const confirmed = value("STAGING_D1_CONFIRM").toLowerCase() === "provision";
  checks.push(check(
    "provision_confirmation",
    confirmed,
    confirmed ? "STAGING_D1_CONFIRM=provision" : "set STAGING_D1_CONFIRM=provision to allow a creating step",
    { blocking: true, code: confirmed ? null : "confirmation_required" }
  ));

  // --- read-only token verification (only when a token exists) ------------------------------
  let tokenVerification = { attempted: false, ok: false, status: null };
  if (token) {
    tokenVerification.attempted = true;
    tokenVerification.source = tokenSource;
    try {
      const response = await fetchImpl("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        method: "GET",
        headers: { authorization: "Bearer " + token }
      });
      tokenVerification.status = response.status;
      const body = await response.json().catch(() => null);
      tokenVerification.ok = response.ok && body?.success !== false && body?.result?.status === "active";
      if (!tokenVerification.ok) tokenVerification.reason = body?.errors?.[0]?.message || "token is not active";
    } catch (error) {
      tokenVerification.reason = String(error?.message || error).slice(0, 160);
    }
    checks.push(check(
      "token_verifies",
      tokenVerification.ok,
      tokenVerification.ok ? "Cloudflare reports the token active" : "token verification failed: " + (tokenVerification.reason || "status " + tokenVerification.status),
      { blocking: true, code: tokenVerification.ok ? null : "token_invalid" }
    ));
  }

  const blockingFailures = checks.filter((item) => item.blocking && !item.ok);
  const warnings = checks.filter((item) => !item.blocking && !item.ok);
  const blockingCodes = [...new Set(blockingFailures.map((item) => item.code).filter(Boolean))];

  return {
    ok: blockingFailures.length === 0,
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    checkCount: checks.length,
    blockingFailureCount: blockingFailures.length,
    warningCount: warnings.length,
    blockingCodes,
    credentialsConfigured: missingNames.length === 0,
    tokenVerification,
    checks,
    note: "Preflight performs no write and no provisioning. It prints names, never values."
  };
}

function render(report) {
  for (const item of report.checks) {
    const mark = item.ok ? "PASS" : (item.blocking ? "BLOCK" : "WARN");
    console.log(mark.padEnd(6) + item.name.padEnd(30) + item.detail);
  }
  console.log("");
  console.log(report.ok
    ? "PREFLIGHT OK — safe to provision staging."
    : "PREFLIGHT BLOCKED — " + report.blockingFailureCount + " blocking check(s): " + (report.blockingCodes.join(", ") || "unnamed") + ".");
  if (!report.ok) {
    console.log("No write was attempted. Supply the missing staging values as protected secrets and re-run.");
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const report = await runStagingPreflight();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else render(report);
  process.exitCode = report.ok ? 0 : 1;
}
