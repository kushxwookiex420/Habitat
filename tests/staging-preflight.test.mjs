import test from "node:test";
import assert from "node:assert/strict";
import { runStagingPreflight } from "../scripts/staging-preflight.mjs";

const okFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, result: { status: "active" } })
});

const withEnv = (extra = {}) => ({ NEXUS_RUNTIME_ENABLED: "", ...extra });

test("with no credentials the repository checks pass and only the staging checks block", async () => {
  const report = await runStagingPreflight({ env: withEnv(), fetchImpl: okFetch });
  assert.equal(report.ok, false);
  assert.ok(report.blockingCodes.includes("credentials_missing"));

  const byName = Object.fromEntries(report.checks.map((item) => [item.name, item]));
  for (const name of [
    "node_version",
    "p1_migrations_present",
    "migration_sequence_contiguous",
    "network_routes_present",
    "scheduler_tick_route_present",
    "container_contract",
    "nexus_runtime_disabled"
  ]) {
    assert.equal(byName[name].ok, true, name + ": " + byName[name].detail);
  }
  assert.equal(byName.staging_credentials_present.ok, false);
  assert.equal(report.tokenVerification.attempted, false, "no token means no network call");
});

test("a staging id equal to the production id is refused", async () => {
  const report = await runStagingPreflight({
    env: withEnv({
      CLOUDFLARE_ACCOUNT_ID: "account",
      HABITAT_D1_API_TOKEN: "token-value",
      STAGING_D1_DATABASE_ID: "same-id",
      PRODUCTION_D1_DATABASE_ID: "same-id",
      STAGING_D1_CONFIRM: "provision"
    }),
    fetchImpl: okFetch
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockingCodes.includes("staging_is_production"));
  const isolation = report.checks.find((item) => item.name === "database_isolation");
  assert.equal(isolation.ok, false);
  assert.match(isolation.detail, /equals the production id/);
});

test("complete, isolated configuration with an active token passes", async () => {
  const report = await runStagingPreflight({
    env: withEnv({
      CLOUDFLARE_ACCOUNT_ID: "account",
      HABITAT_D1_API_TOKEN: "token-value",
      STAGING_D1_DATABASE_ID: "staging-id",
      PRODUCTION_D1_DATABASE_ID: "production-id",
      STAGING_D1_CONFIRM: "provision"
    }),
    fetchImpl: okFetch
  });
  assert.equal(report.ok, true, JSON.stringify(report.blockingCodes));
  assert.equal(report.tokenVerification.ok, true);
  assert.equal(report.blockingFailureCount, 0);
});

test("a creating step is refused without the explicit confirmation flag", async () => {
  const report = await runStagingPreflight({
    env: withEnv({
      CLOUDFLARE_ACCOUNT_ID: "account",
      HABITAT_D1_API_TOKEN: "token-value",
      STAGING_D1_DATABASE_ID: "staging-id",
      PRODUCTION_D1_DATABASE_ID: "production-id"
    }),
    fetchImpl: okFetch
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockingCodes.includes("confirmation_required"));
});

test("an inactive token blocks and the credential value never reaches the report", async () => {
  const secret = "super-secret-token-value-123456";
  const report = await runStagingPreflight({
    env: withEnv({
      CLOUDFLARE_ACCOUNT_ID: "account",
      HABITAT_D1_API_TOKEN: secret,
      STAGING_D1_DATABASE_ID: "staging-id",
      PRODUCTION_D1_DATABASE_ID: "production-id",
      STAGING_D1_CONFIRM: "provision"
    }),
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ success: false, errors: [{ message: "Invalid API Token" }] }) })
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockingCodes.includes("token_invalid"));
  assert.equal(JSON.stringify(report).includes(secret), false, "the token must not be serialised into the report");
});

test("enabling the NEXUS runtime blocks staging preflight", async () => {
  const report = await runStagingPreflight({ env: withEnv({ NEXUS_RUNTIME_ENABLED: "true" }), fetchImpl: okFetch });
  assert.equal(report.ok, false);
  assert.ok(report.blockingCodes.includes("nexus_runtime_enabled"));
});

test("a token verification network failure is reported, not thrown", async () => {
  const report = await runStagingPreflight({
    env: withEnv({
      CLOUDFLARE_ACCOUNT_ID: "account",
      HABITAT_D1_API_TOKEN: "token-value",
      STAGING_D1_DATABASE_ID: "staging-id",
      PRODUCTION_D1_DATABASE_ID: "production-id",
      STAGING_D1_CONFIRM: "provision"
    }),
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockingCodes.includes("token_invalid"));
  assert.match(report.tokenVerification.reason, /network down/);
});
