import test from "node:test";
import assert from "node:assert/strict";
import { P1_TABLES, rollbackStatements, runRollbackChecks } from "../scripts/migration-rollback-check.mjs";

test("P1 migrations roll back cleanly and preserve pre-existing data", async () => {
  const report = await runRollbackChecks();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(item => !item.ok), null, 2));
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.droppedTables, P1_TABLES.length);
  assert.match(report.summary.dataLoss, /P1 rows are discarded/);
  assert.ok(report.checks.some(item => item.name === "rollback restores the exact pre-0008 schema"));
  assert.ok(report.checks.some(item => item.name === "rollback preserves the cost ledger row"));
});

test("the rollback plan only ever drops the eight P1 tables", () => {
  const statements = rollbackStatements();
  assert.equal(statements.length, 8);
  for (const statement of statements) {
    assert.match(statement, /^DROP TABLE IF EXISTS habitat_ax_[a-z_]+$/);
    const name = statement.replace("DROP TABLE IF EXISTS ", "");
    assert.ok(P1_TABLES.includes(name), name);
  }
  assert.equal(statements.some(statement => statement.includes("habitat_command_tasks")), false);
  assert.equal(statements.some(statement => statement.includes("habitat_ax_cost_ledger")), false);
  assert.equal(statements.some(statement => statement.includes("habitat_ax_scheduler")), false);
});
