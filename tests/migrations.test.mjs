import test from "node:test";
import assert from "node:assert/strict";
import { runMigrationChecks } from "../scripts/migration-check.mjs";

test("all migrations apply from scratch, repeat safely and preserve data", async () => {
  const report = await runMigrationChecks();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(item => !item.ok), null, 2));
  assert.equal(report.summary.failed, 0);
  assert.ok(report.checks.some(item => item.name === "fresh table habitat_ax_security_events"));
  assert.ok(report.checks.some(item => item.name === "upgrade preserves existing task data"));
  assert.match(report.summary.environment, /not D1 itself/);
});
