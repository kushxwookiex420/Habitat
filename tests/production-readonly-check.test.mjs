import test from "node:test";
import assert from "node:assert/strict";
import { runReadOnlyChecks } from "../scripts/production-readonly-check.mjs";

/**
 * Rule tests for the read-only production check. A fake fetch stands in for the deployment, so
 * these tests prove the pass/fail logic without touching production.
 */

const BASE = "https://habitat.example";

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    const route = routes[parsed.pathname];
    if (!route) return { status: 404, text: async () => JSON.stringify({ ok: false }) };
    const status = typeof route === "function" ? route().status : route.status;
    const body = typeof route === "function" ? route().body : route.body;
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? {})) };
  };
  return { impl, calls };
}

function healthyRoutes(overrides = {}) {
  return {
    "/health": {
      status: 200,
      body: {
        ok: true,
        commit: "57a51237f40ff814b177d53311a007d72605fbe2",
        nexus: { configured: false, reason: "disabled_by_config" },
        nexusMessageSurface: { configured: true, code: null }
      }
    },
    "/ax/nexus/channel": { status: 401, body: { ok: false, error: "invalid_nexus_token" } },
    "/ax/command/messages": { status: 401, body: { ok: false, error: "invalid_token" } },
    ...overrides
  };
}

test("a correctly configured deployment passes every check", async () => {
  const fake = fakeFetch(healthyRoutes());
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl });

  assert.equal(result.ok, true);
  assert.equal(result.commit.startsWith("57a5123"), true);
  assert.equal(result.checks.every(check => check.ok), true);
  assert.deepEqual(fake.calls, ["/health", "/ax/nexus/channel", "/ax/command/messages"], "only GETs, no mutating paths");
});

test("an enabled executor is a hard failure before activation approval", async () => {
  const fake = fakeFetch(healthyRoutes({
    "/health": { status: 200, body: { commit: "57a5123", nexus: { configured: true }, nexusMessageSurface: { configured: true } } }
  }));
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl });

  assert.equal(result.ok, false);
  const failed = result.checks.filter(check => !check.ok).map(check => check.name);
  assert.deepEqual(failed, ["nexus executor is disabled"]);
});

test("an unauthenticated endpoint that answers 200 fails the check", async () => {
  const fake = fakeFetch(healthyRoutes({
    "/ax/nexus/channel": { status: 200, body: { ok: true, messages: [] } }
  }));
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl });

  assert.equal(result.ok, false);
  const check = result.checks.find(entry => entry.name === "nexus-channel requires auth");
  assert.equal(check.ok, false);
  assert.match(check.detail, /without authentication/);
});

test("a 503 on a protected surface is a failure, not a pass", async () => {
  const fake = fakeFetch(healthyRoutes({
    "/ax/command/messages": { status: 503, body: { ok: false, error: "nexus_auth_unconfigured" } }
  }));
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find(entry => entry.name === "ax command messages require auth").ok, false);
});

test("a commit mismatch fails when an expected commit is supplied", async () => {
  const fake = fakeFetch(healthyRoutes());
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl, expectCommit: "deadbee" });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find(entry => entry.name === "health commit matches expectation").ok, false);
});

test("an unreachable deployment stops after the health probe", async () => {
  const fake = fakeFetch({});
  fake.impl = async () => { throw new Error("connect ECONNREFUSED"); };
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl });

  assert.equal(result.ok, false);
  assert.equal(result.unreachable, true);
  assert.equal(result.checks.length, 1);
  assert.match(result.checks[0].detail, /ECONNREFUSED/);
});

test("a health response missing nexus state fails closed", async () => {
  const fake = fakeFetch(healthyRoutes({
    "/health": { status: 200, body: { commit: "57a5123" } }
  }));
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find(entry => entry.name === "health reports nexus state").ok, false);
});

test("strict mode fails when the message surface is absent", async () => {
  const fake = fakeFetch(healthyRoutes({
    "/health": { status: 200, body: { commit: "57a5123", nexus: { configured: false, reason: "disabled_by_config" } } }
  }));
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl, requireMessageSurface: true });

  assert.equal(result.ok, false);
  const check = result.checks.find(entry => entry.name === "message-surface is deployed and configured");
  assert.equal(check.ok, false);
  assert.match(check.detail, /not present/);
});

test("strict mode fails when the surface is reported but not configured", async () => {
  const fake = fakeFetch(healthyRoutes({
    "/health": { status: 200, body: { commit: "57a5123", nexus: { configured: false }, nexusMessageSurface: { configured: false, code: "token_missing" } } }
  }));
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: fake.impl, requireMessageSurface: true });

  assert.equal(result.ok, false);
  const check = result.checks.find(entry => entry.name === "message-surface is deployed and configured");
  assert.equal(check.ok, false);
  assert.match(check.detail, /token_missing/);
});

test("strict mode passes on a configured surface, and the default tolerates absence", async () => {
  const withoutSurface = fakeFetch(healthyRoutes({
    "/health": { status: 200, body: { commit: "57a5123", nexus: { configured: false } } }
  }));
  const lenient = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: withoutSurface.impl });
  assert.equal(lenient.ok, true);

  const withSurface = fakeFetch(healthyRoutes());
  const strict = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: withSurface.impl, requireMessageSurface: true });
  assert.equal(strict.ok, true);
  assert.equal(strict.checks.find(entry => entry.name === "message-surface is deployed and configured").ok, true);
});

test("a cold-start abort on health is retried once, then passes", async () => {
  const calls = [];
  const fake = fakeFetch(healthyRoutes());
  const base = fake.impl;
  const impl = async (url, options) => {
    calls.push(new URL(url).pathname);
    if (calls.filter(path => path === "/health").length === 1) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return base(url, options);
  };
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: impl, timeoutMs: 10 });

  assert.equal(result.ok, true);
  assert.equal(calls.filter(path => path === "/health").length, 2);
  assert.match(result.checks[0].detail, /retried after cold start/);
});

test("a non-timeout failure is not retried", async () => {
  let healthCalls = 0;
  const impl = async (url) => {
    if (new URL(url).pathname === "/health") healthCalls += 1;
    throw new Error("connect ECONNREFUSED");
  };
  const result = await runReadOnlyChecks({ baseUrl: BASE, fetchImpl: impl });

  assert.equal(result.ok, false);
  assert.equal(healthCalls, 1);
});
