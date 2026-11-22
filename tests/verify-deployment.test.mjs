import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRoute,
  commitMatches,
  evaluateDeployment,
  routeEvidence,
  verifyDeployment,
  MISSION_17_ROUTES
} from "../scripts/verify-deployment.mjs";

/**
 * Mission 19 — deployment verification contract.
 *
 * These tests exercise the classifier and the whole probe with an injected fetch. The distinction
 * that matters most: a 404 proves the route is absent, while a 401 proves it is deployed and guarded.
 */

function response(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    text: async () => (body === null ? "" : JSON.stringify(body)),
    json: async () => body
  };
}

function fakeFetch({ health = 200, healthBody = {}, openapi = 200, routeStatus = 401, authenticated = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: options.method || "GET", auth: Boolean(options.headers?.authorization) });
    if (pathname === "/health") return response(health, healthBody);
    if (pathname === "/ax/command/openapi.json") {
      return response(openapi, openapi === 200 ? { openapi: "3.1.0", paths: { "/ax/command/tasks": { get: {} }, "/ax/command/messages": { post: {} } } } : null);
    }
    if (pathname === "/ax/command/presence") return response(authenticated ? 200 : 401, authenticated ? { ok: true } : { ok: false });
    if (pathname === "/ax/command/agents") return response(authenticated ? 200 : 401, authenticated ? { ok: true, agents: [{}, {}] } : { ok: false });
    return response(routeStatus, routeStatus === 404 ? { error: "Cannot POST" } : { ok: false, code: "invalid_token" });
  };
  return { fetchImpl, calls };
}

test("classifyRoute separates a missing route from an authentication failure", () => {
  assert.equal(classifyRoute(404), "missing");
  assert.equal(classifyRoute(401), "present_auth_required");
  assert.equal(classifyRoute(403), "present_auth_required");
  assert.equal(classifyRoute(400), "present");
  assert.equal(classifyRoute(409), "present");
  assert.equal(classifyRoute(405), "wrong_method");
  assert.equal(classifyRoute(0), "unreachable");

  const missing = routeEvidence(MISSION_17_ROUTES[0], 404);
  const guarded = routeEvidence(MISSION_17_ROUTES[0], 401);
  assert.equal(missing.deployed, false);
  assert.equal(missing.error, "route_not_deployed");
  assert.equal(guarded.deployed, true);
  assert.equal(guarded.error, null);
});

test("commitMatches accepts an abbreviated SHA on either side and refuses a different build", () => {
  assert.equal(commitMatches("dfcfcf7cc93c5127b87c5f8870bda147b0505732", "dfcfcf7"), true);
  assert.equal(commitMatches("dfcfcf7", "dfcfcf7cc93c5127b87c5f8870bda147b0505732"), true);
  assert.equal(commitMatches("8b5b168", "dfcfcf7"), false);
  assert.equal(commitMatches(null, "dfcfcf7"), null);
  assert.equal(commitMatches("not-a-sha", "dfcfcf7"), null);
});

test("a live origin running the expected commit with guarded routes is CURRENT", async () => {
  const { fetchImpl, calls } = fakeFetch({ healthBody: { version: "0.5.0", commit: "dfcfcf7cc93c5", nexus: { configured: false } } });
  const report = await verifyDeployment({ origin: "https://habitat.example.test", expectedCommit: "dfcfcf7", token: "test-token", fetchImpl });

  assert.equal(report.status, "CURRENT");
  assert.equal(report.current, true);
  assert.equal(report.version, "0.5.0");
  assert.equal(report.mission17Present, true);
  assert.equal(report.openapi.operations, 2);
  assert.equal(report.authenticated.credentialAccepted, true);
  assert.equal(report.authenticated.agentCount, 2);
  assert.ok(calls.some(call => call.pathname === "/ax/command/presence" && call.auth), "the token was actually sent");

  // The revoke route must never be called with a credential.
  const revoke = calls.find(call => call.pathname === "/ax/command/agents/revoke");
  assert.equal(revoke.auth, false);
});

test("a Mission 17 route answering 404 marks the deployment OUTDATED even when health is green", async () => {
  const { fetchImpl } = fakeFetch({ healthBody: { version: "0.5.0" }, routeStatus: 404 });
  const report = await verifyDeployment({ origin: "https://habitat.example.test", fetchImpl });
  assert.equal(report.status, "OUTDATED");
  assert.equal(report.mission17Present, false);
  assert.deepEqual(report.mission17Missing.sort(), ["agents_revoke", "work", "work_stop"]);
  assert.ok(report.blockers.some(line => /Mission 17 routes are absent/.test(line)));
});

test("an absent optional restore route is reported but does not make Mission 17 outdated", async () => {
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/health") return response(200, { version: "0.5.0", commit: "c713d5d" });
    if (pathname === "/ax/command/openapi.json") return response(200, { openapi: "3.1.0", paths: {} });
    if (pathname === "/ax/command/agents/restore") return response(404, { error: "Cannot POST" });
    return response(401, { ok: false });
  };
  const report = await verifyDeployment({ origin: "https://habitat.example.test", expectedCommit: "c713d5d", fetchImpl });
  assert.equal(report.mission17Present, true);
  assert.equal(report.mission19Present, false);
  assert.equal(report.status, "CURRENT", "a Mission 17 deployment is still current without the optional restore route");
});

test("an unauthenticated 401 still proves the route is deployed", async () => {
  const { fetchImpl } = fakeFetch({ routeStatus: 401, authenticated: false });
  const report = await verifyDeployment({ origin: "https://habitat.example.test", token: "refused-token", fetchImpl });
  assert.equal(report.mission17Present, true, "401 is a deployed, guarded route");
  assert.equal(report.authenticated.credentialAccepted, false);
  assert.ok(report.routes.every(route => route.classification === "present_auth_required"));
  assert.equal(report.status, "UNKNOWN", "no commit was supplied or observed");
});

test("a wrong commit is OUTDATED, not merely unknown", async () => {
  const { fetchImpl } = fakeFetch({ healthBody: { version: "0.5.0", commit: "8b5b168" } });
  const report = await verifyDeployment({ origin: "https://habitat.example.test", expectedCommit: "dfcfcf7", fetchImpl });
  assert.equal(report.status, "OUTDATED");
  assert.equal(report.commitMatches, false);
});

test("an origin that does not answer is UNREACHABLE", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const report = await verifyDeployment({ origin: "https://habitat.example.test", fetchImpl });
  assert.equal(report.status, "UNREACHABLE");
  assert.equal(report.current, false);
});

test("a non-HTTPS origin is refused instead of probed", async () => {
  const report = await verifyDeployment({ origin: "http://example.com", fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(report.status, "INVALID_ORIGIN");
});

test("evaluateDeployment does not turn a missing commit into a pass", () => {
  const health = { status: 200, json: { version: "0.5.0" } };
  const openapi = { status: 200, operations: 10, json: { openapi: "3.1.0" } };
  const routes = MISSION_17_ROUTES.map(route => routeEvidence(route, 401));
  const report = evaluateDeployment({ health, openapi, routes, expectedCommit: "dfcfcf7" });
  assert.equal(report.status, "UNKNOWN");
  assert.equal(report.current, false);
});
