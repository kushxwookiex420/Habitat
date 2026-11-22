#!/usr/bin/env node
/**
 * Read-only production verification for Habitat.
 *
 * Every check is a GET. Nothing is written, no credential is supplied, and no secret is read or
 * printed: the script only observes public status codes and booleans. It is safe to run against
 * production at any time, and it fails closed — an unexpected "open" answer is a failure, not a
 * warning.
 *
 * Usage:
 *   node scripts/production-readonly-check.mjs
 *   node scripts/production-readonly-check.mjs --base-url https://habitat-1-szzd.onrender.com
 *   node scripts/production-readonly-check.mjs --expect-commit 57a5123
 *   node scripts/production-readonly-check.mjs --require-message-surface
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the checks could not run.
 */

const DEFAULT_BASE_URL = "https://habitat-1-szzd.onrender.com";

const PROBES = Object.freeze([
  { name: "nexus-channel requires auth", path: "/ax/nexus/channel", accept: [401], forbidden: [200] },
  { name: "ax command messages require auth", path: "/ax/command/messages", accept: [401], forbidden: [200] }
]);

function trimBase(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function getJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

async function probeStatus(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    // Read and discard so the connection is released; no body content is reported.
    try { await response.text(); } catch {}
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure check runner: inject `fetchImpl` to test the rules without touching production.
 * Returns { ok, checks, commit, nexus } and never throws for an expected HTTP status.
 */
export async function runReadOnlyChecks({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  expectCommit = null,
  requireMessageSurface = false
} = {}) {
  const base = trimBase(baseUrl);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  let health;
  try {
    health = await getJson(fetchImpl, base + "/health", timeoutMs);
  } catch (error) {
    add("health reachable", false, String(error?.message || error).slice(0, 200));
    return { ok: false, checks, unreachable: true, commit: null, nexus: null };
  }

  add("health reachable", health.status === 200, "HTTP " + health.status);
  if (health.status !== 200) return { ok: false, checks, commit: null, nexus: null };

  const body = health.body || {};
  const commit = String(body.commit || "");
  add("health reports a commit", /^[0-9a-f]{7,40}$/i.test(commit), commit ? commit.slice(0, 12) : "missing");
  if (expectCommit) {
    const wanted = String(expectCommit).toLowerCase();
    add(
      "health commit matches expectation",
      commit.toLowerCase().startsWith(wanted),
      "expected " + wanted + ", got " + (commit.slice(0, 12) || "none")
    );
  }

  const nexus = body.nexus || null;
  add("health reports nexus state", Boolean(nexus) && typeof nexus.configured === "boolean", nexus ? JSON.stringify({ configured: nexus.configured, reason: nexus.reason ?? null }) : "missing");
  // The executor must stay disabled until the owner authorizes activation. This is a hard failure.
  add("nexus executor is disabled", nexus?.configured === false, nexus?.configured === true ? "configured=true is unexpected before activation approval" : String(nexus?.reason || "not reported"));

  const surface = body.nexusMessageSurface || null;
  if (requireMessageSurface) {
    // Post-#95 gate: the field must exist and report a configured surface. Presence without
    // configuration still means the bridge cannot report readiness.
    add(
      "message-surface is deployed and configured",
      surface?.configured === true,
      surface ? JSON.stringify({ configured: surface.configured === true, code: surface.code || null }) : "not present — deploy PR #95 first"
    );
  } else {
    add(
      "message-surface status is either reported or clearly absent",
      true,
      surface ? JSON.stringify({ configured: surface.configured === true, code: surface.code || null }) : "not present (PR #95 not deployed)"
    );
  }

  for (const probe of PROBES) {
    try {
      const status = await probeStatus(fetchImpl, base + probe.path, timeoutMs);
      if (probe.forbidden.includes(status)) {
        add(probe.name, false, "HTTP " + status + " — endpoint answered without authentication");
      } else if (probe.accept.includes(status)) {
        add(probe.name, true, "HTTP " + status);
      } else {
        add(probe.name, false, "HTTP " + status + " (expected " + probe.accept.join("/") + ")");
      }
    } catch (error) {
      add(probe.name, false, String(error?.message || error).slice(0, 200));
    }
  }

  return { ok: checks.every(check => check.ok), checks, commit: commit || null, nexus };
}

function parseArgs(argv) {
  const options = { baseUrl: DEFAULT_BASE_URL, expectCommit: null, timeoutMs: 15_000, json: false, requireMessageSurface: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") options.baseUrl = argv[++index];
    else if (arg === "--expect-commit") options.expectCommit = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index] || 0) || 15_000;
    else if (arg === "--json") options.json = true;
    else if (arg === "--require-message-surface") options.requireMessageSurface = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Read-only Habitat production check. Options: --base-url URL --expect-commit SHA --timeout-ms N --json --require-message-surface");
      process.exit(0);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = await runReadOnlyChecks(options);
  } catch (error) {
    console.error("PRODUCTION_CHECK_ERROR", String(error?.message || error));
    process.exitCode = 2;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify({ ok: result.ok, commit: result.commit, nexus: result.nexus, checks: result.checks }, null, 2));
  } else {
    console.log("Habitat read-only production check — " + trimBase(options.baseUrl));
    for (const check of result.checks) {
      console.log((check.ok ? "PASS " : "FAIL ") + check.name + " · " + check.detail);
    }
    console.log(result.ok ? "RESULT: PASS" : "RESULT: FAIL");
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === "file://" + process.argv[1]) {
  main();
}
