import test from "node:test";
import assert from "node:assert/strict";
import { runStagingDemo } from "../scripts/staging-demo.mjs";

test("the staging harness refuses without explicit credentials and writes authorization", async () => {
  const report = await runStagingDemo({ env: {} });
  assert.equal(report.ok, false);
  assert.equal(report.code, "staging_not_configured");
  assert.deepEqual(report.missing, [
    "CLOUDFLARE_ACCOUNT_ID",
    "HABITAT_D1_DATABASE_ID",
    "HABITAT_D1_API_TOKEN",
    "STAGING_ALLOW_WRITES",
    "STAGING_OBJECTIVE_KEY",
    "STAGING_OWNER_APPROVAL_ID"
  ]);
  assert.match(report.ownerAction, /staging D1/);
});

test("the staging harness will not write without STAGING_ALLOW_WRITES=true", async () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "acct",
    HABITAT_D1_DATABASE_ID: "db",
    HABITAT_D1_API_TOKEN: "token",
    STAGING_ALLOW_WRITES: "false",
    STAGING_OBJECTIVE_KEY: "key",
    STAGING_OWNER_APPROVAL_ID: "approval"
  };
  const report = await runStagingDemo({ env });
  assert.equal(report.ok, false);
  assert.equal(report.code, "staging_writes_not_authorized");
});
