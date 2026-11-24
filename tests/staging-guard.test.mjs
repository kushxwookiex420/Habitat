import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { databaseAllowed, PRODUCTION_D1_DATABASE_ID, stagingEnvironment } from "../staging-guard.mjs";

const STAGING_DB = "0fdf1ac9-65a3-4e83-8042-f3fa52282068";

test("a staging process refuses the production database id", () => {
  const stagingEnv = { HABITAT_ENVIRONMENT: "staging", HABITAT_D1_DATABASE_ID: PRODUCTION_D1_DATABASE_ID };
  assert.equal(stagingEnvironment(stagingEnv), true);
  assert.deepEqual(databaseAllowed({ env: stagingEnv, databaseId: PRODUCTION_D1_DATABASE_ID }), {
    ok: false,
    reason: "staging_points_at_production_database"
  });
  // A trailing space or different case is still the production database.
  assert.equal(databaseAllowed({ env: stagingEnv, databaseId: " " + PRODUCTION_D1_DATABASE_ID.toUpperCase() + " " }).ok, false);
});

test("staging with the staging database, and production with no marker, are allowed", () => {
  assert.equal(databaseAllowed({ env: { HABITAT_ENVIRONMENT: "staging" }, databaseId: STAGING_DB }).ok, true);
  assert.equal(databaseAllowed({ env: {}, databaseId: PRODUCTION_D1_DATABASE_ID }).ok, true, "unmarked processes keep their existing behavior");
  assert.equal(databaseAllowed({ env: { HABITAT_ENVIRONMENT: "production" }, databaseId: PRODUCTION_D1_DATABASE_ID }).ok, true);
  assert.deepEqual(databaseAllowed({ env: { HABITAT_ENVIRONMENT: "staging" }, databaseId: "" }), {
    ok: true,
    reason: "no_database_configured"
  });
});

test("a staging server configured with the production database exits before listening", () => {
  const result = spawnSync(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      PORT: "0",
      HABITAT_ENVIRONMENT: "staging",
      HABITAT_D1_DATABASE_ID: PRODUCTION_D1_DATABASE_ID,
      CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      HABITAT_D1_API_TOKEN: "not-a-real-token"
    },
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(result.status, 1, "the process must exit non-zero: " + String(result.stderr || result.error));
  assert.match(result.stderr, /STAGING_GUARD_REFUSED_START/);
  assert.match(result.stderr, /staging_points_at_production_database/);
  assert.equal(result.stderr.includes(PRODUCTION_D1_DATABASE_ID), false, "the guard must not print the database id");
  assert.equal(result.stdout.includes("Cannot GET"), false, "no route may be served");
});
