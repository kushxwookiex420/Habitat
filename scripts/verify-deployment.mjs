#!/usr/bin/env node
/**
 * Mission 19 — deployment verification.
 *
 * Proves what the live origin is actually running without guessing:
 *   - /health identity: version, optional commit, start time, NEXUS mount state
 *   - /ax/command/openapi.json: the public contract and its operation count
 *   - Mission 17 routes: 404 means the route is absent, 401/403 means it exists and is guarded
 *   - authenticated probes (optional token): does the credential work, and is the agent surface live
 *
 * The token is read from HABITAT_AX_COMMAND_TOKEN and is never written to the report. Exit code 0
 * means CURRENT; every other outcome exits 1 so a workflow can gate on it.
 *
 *   npm run verify:deployment
 *   node scripts/verify-deployment.mjs --expect-commit <sha> --json release/verification.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ORIGIN = "https://habitat-1-szzd.onrender.com";
export const MISSION_17_ROUTES = Object.freeze([
  { key: "work", method: "POST", path: "/ax/command/objectives/probe/work" },
  { key: "work_stop", method: "POST", path: "/ax/command/objectives/probe/work/stop" },
  { key: "agents_revoke", method: "POST", path: "/ax/command/agents/revoke" }
]);
export const MISSION_19_ROUTE = Object.freeze({ key: "agents_restore", method: "POST", path: "/ax/command/agents/restore" });

/** A status code answers exactly one question: is the route deployed? */
export function classifyRoute(status) {
  if (!Number.isFinite(status) || status === 0) return "unreachable";
  if (status === 404) return "missing";
  if (status === 401 || status === 403) return "present_auth_required";
  if (status === 400 || status === 409 || status === 415 || status === 422) return "present";
  if (status === 200 || status === 202 || status === 204) return "present";
  if (status === 405) return "wrong_method";
  return "present_other";
}

export function routeEvidence(route, status) {
  const classification = classifyRoute(status);
  return {
    key: route.key,
    method: route.method,
    path: route.path,
    status,
    classification,
    deployed: classification !== "missing" && classification !== "unreachable",
    error: status === 404 ? "route_not_deployed"
      : status === 0 ? "network_unreachable"
      : status === 405 ? "route_present_method_not_allowed"
      : null
  };
}

function normalizeCommit(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(text) ? text : null;
}

/** Same commit, allowing an abbreviated SHA on either side. */
export function commitMatches(observed, expected) {
  const left = normalizeCommit(observed);
  const right = normalizeCommit(expected);
  if (!left || !right) return null;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Decide the deployment state from evidence only. `UNKNOWN` is a distinct outcome: the service is
 * reachable and the route surface is right, but it did not report which commit it runs.
 */
export function evaluateDeployment({ health, openapi, routes, expectedCommit = null, authenticated = null } = {}) {
  const healthStatus = Number(health?.status || 0);
  const body = health?.json || null;
  const observedCommit = normalizeCommit(body?.commit);
  const expected = normalizeCommit(expectedCommit);
  const match = expected ? commitMatches(observedCommit, expected) : null;

  const routeList = Array.isArray(routes) ? routes : [];
  const mission17 = routeList.filter(route => MISSION_17_ROUTES.some(item => item.key === route.key));
  const mission17Present = mission17.length === MISSION_17_ROUTES.length && mission17.every(route => route.deployed === true);
  const mission17Missing = mission17.filter(route => route.deployed !== true).map(route => route.key);

  const openapiStatus = Number(openapi?.status || 0);
  const operations = Number(openapi?.operations || 0);

  let status;
  const blockers = [];
  if (healthStatus === 0) {
    status = "UNREACHABLE";
    blockers.push("The origin did not answer /health.");
  } else if (healthStatus !== 200) {
    status = "UNHEALTHY";
    blockers.push("/health answered HTTP " + healthStatus + ".");
  } else if (routeList.some(route => route.classification === "missing")) {
    status = "OUTDATED";
    blockers.push("Mission 17 routes are absent: " + mission17Missing.join(", ") + ".");
  } else if (expected && match === false) {
    status = "OUTDATED";
    blockers.push("The service reports commit " + observedCommit + " but " + expected + " was expected.");
  } else if (expected && match === null) {
    status = "UNKNOWN";
    blockers.push("The service did not report a commit; the deployed SHA cannot be proven from outside.");
  } else if (!expected && !observedCommit) {
    status = "UNKNOWN";
    blockers.push("No expected commit was supplied and the service reports none.");
  } else {
    status = "CURRENT";
  }
  if (openapiStatus !== 200) blockers.push("/ax/command/openapi.json answered HTTP " + openapiStatus + ".");
  else if (operations < 1) blockers.push("The OpenAPI document declares no operations.");

  return {
    status,
    current: status === "CURRENT",
    version: body?.version || null,
    observedCommit,
    expectedCommit: expected,
    commitMatches: match,
    mission17Present,
    mission17Missing,
    routes: routeList,
    openapi: { status: openapiStatus, operations, openapi: openapi?.json?.openapi || null },
    nexus: body?.nexus || null,
    startedAt: body?.startedAt || null,
    authenticated,
    blockers
  };
}

async function probe(fetchImpl, origin, method, pathname, { token = null, body = null, timeoutMs = 15_000 } = {}) {
  const headers = { accept: "application/json" };
  if (body !== null) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  try {
    const response = await fetchImpl(origin + pathname, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    let json = null;
    const text = await response.text();
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: response.status, json, text: text.slice(0, 2_000) };
  } catch {
    return { status: 0, json: null, text: "", error: "network_error" };
  }
}

function operationCount(spec) {
  if (!spec?.paths) return 0;
  return Object.values(spec.paths)
    .flatMap(item => Object.keys(item || {}))
    .filter(method => ["get", "post", "put", "patch", "delete"].includes(method)).length;
}

export async function verifyDeployment({
  origin = DEFAULT_ORIGIN,
  expectedCommit = null,
  token = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  now = () => new Date().toISOString()
} = {}) {
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return { schemaVersion: 1, generatedAt: now(), origin: base, status: "INVALID_ORIGIN", current: false, error: "origin is not a URL" };
  }
  if (parsed.protocol !== "https:" && !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
    return { schemaVersion: 1, generatedAt: now(), origin: base, status: "INVALID_ORIGIN", current: false, error: "only HTTPS origins are verified (loopback is allowed for local tests)" };
  }

  const health = await probe(fetchImpl, base, "GET", "/health", { timeoutMs });
  const openapi = await probe(fetchImpl, base, "GET", "/ax/command/openapi.json", { timeoutMs });
  openapi.operations = operationCount(openapi.json);

  const routes = [];
  for (const route of [...MISSION_17_ROUTES, MISSION_19_ROUTE]) {
    const result = await probe(fetchImpl, base, route.method, route.path, { body: {}, timeoutMs });
    routes.push(routeEvidence(route, result.status));
  }

  // Authenticated probes never mutate state: presence and the agent list are reads. The revoke and
  // work routes are never called with a credential.
  let authenticated = null;
  if (token) {
    const presence = await probe(fetchImpl, base, "GET", "/ax/command/presence", { token, timeoutMs });
    const agents = await probe(fetchImpl, base, "GET", "/ax/command/agents", { token, timeoutMs });
    authenticated = {
      attempted: true,
      presenceStatus: presence.status,
      agentsStatus: agents.status,
      credentialAccepted: presence.status === 200 || agents.status === 200,
      agentCount: Array.isArray(agents.json?.agents) ? agents.json.agents.length : null,
      revoked: typeof agents.json?.revoked === "boolean" ? agents.json.revoked : null,
      note: presence.status === 401 || agents.status === 401
        ? "The credential was refused; route presence is still proven by the unauthenticated 401s."
        : null
    };
  } else {
    authenticated = { attempted: false, credentialAccepted: null, note: "No token was supplied, so authenticated state is not claimed." };
  }

  const evaluation = evaluateDeployment({ health, openapi, routes, expectedCommit, authenticated });
  return {
    schemaVersion: 1,
    generatedAt: now(),
    origin: base,
    health: {
      status: health.status,
      version: evaluation.version,
      commit: evaluation.observedCommit,
      startedAt: evaluation.startedAt,
      nexus: evaluation.nexus
    },
    openapi: { status: openapi.status, operations: openapi.operations, spec: openapi.json?.openapi || null },
    ...evaluation,
    expectedCommit: normalizeCommit(expectedCommit)
  };
}

function parseArgs(argv) {
  const args = { origin: process.env.HABITAT_BASE_URL || DEFAULT_ORIGIN, expectedCommit: null, json: "release/mission-19-deployment-verification.json", token: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--origin") args.origin = argv[++index];
    else if (item === "--expect-commit") args.expectedCommit = argv[++index];
    else if (item === "--json") args.json = argv[++index];
    else if (item === "--no-json") args.json = null;
  }
  // The credential comes from the environment only: a command line is visible in process listings.
  args.token = process.env.HABITAT_AX_COMMAND_TOKEN || null;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await verifyDeployment({ origin: args.origin, expectedCommit: args.expectedCommit, token: args.token });
  const summary = {
    status: report.status,
    origin: report.origin,
    version: report.version,
    commit: report.observedCommit,
    expectedCommit: report.expectedCommit,
    mission17Present: report.mission17Present,
    mission17Missing: report.mission17Missing,
    openapiOperations: report.openapi?.operations,
    authenticated: report.authenticated?.credentialAccepted,
    blockers: report.blockers
  };
  console.log(JSON.stringify(summary, null, 2));
  if (args.json) {
    const target = path.resolve(args.json);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
    console.error("evidence: " + path.relative(process.cwd(), target));
  }
  process.exitCode = report.current ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL("file://" + path.resolve(process.argv[1])).href) {
  await main();
}
