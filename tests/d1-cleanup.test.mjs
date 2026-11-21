import test from "node:test";
import assert from "node:assert/strict";
import { cleanupIsolatedRows } from "../scripts/d1-cleanup.mjs";

test("D1 cleanup failure marks the workflow failed instead of returning a false green", async () => {
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    const calls = [];
    const ok = await cleanupIsolatedRows(async (sql, params) => {
      calls.push({ sql, params });
      throw new Error("D1 cleanup unavailable");
    }, ["itest-a", "itest-b"], { log() {}, error() {} });
    assert.equal(ok, false);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(calls.map(call => call.params[0]), ["itest-a", "itest-b"]);
  } finally {
    process.exitCode = previous;
  }
});

test("D1 cleanup deletes only the supplied isolated ids", async () => {
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    const deleted = [];
    const ok = await cleanupIsolatedRows(async (sql, params) => {
      assert.match(sql, /^DELETE FROM habitat_command_tasks WHERE id = \?$/);
      deleted.push(params[0]);
    }, ["itest-a", "itest-b"], { log() {}, error() {} });
    assert.equal(ok, true);
    assert.deepEqual(deleted, ["itest-a", "itest-b"]);
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = previous;
  }
});
