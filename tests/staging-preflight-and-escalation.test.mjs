import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifyDiff, deploymentProcedure, evaluatePreflight, parseStagingFlags
} from "../scripts/staging-deploy-preflight.mjs";
import { findEscalations, summarizeAttempts, validateEscalationBody } from "../scripts/staging-escalation-check.mjs";

test("the staging blueprint really keeps autonomy off", async () => {
  const yaml = await readFile(new URL("../render.staging.yaml", import.meta.url), "utf8");
  const flags = parseStagingFlags(yaml);
  assert.equal(flags.environment, "staging");
  assert.equal(flags.nexus, "false");
  assert.equal(flags.missions, "false");
  assert.equal(flags.workforce, "false");
});

test("preflight refuses an enabled autonomy flag, a migration, or production config", () => {
  const base = {
    targetSha: "b".repeat(40),
    deployedSha: "a".repeat(40),
    flags: { environment: "staging", nexus: "false", missions: "false", workforce: "false" },
    files: ["ax-orchestrator.mjs", "tests/ax-priority-policy.test.mjs"]
  };
  assert.equal(evaluatePreflight(base).ok, true);

  const enabled = evaluatePreflight({ ...base, flags: { ...base.flags, nexus: "true" } });
  assert.equal(enabled.ok, false);
  assert.ok(enabled.blockers.some((blocker) => blocker.code === "autonomy_flag_enabled"));

  const migrated = evaluatePreflight({ ...base, files: [...base.files, "migrations/0009_add_priority.sql"] });
  assert.ok(migrated.blockers.some((blocker) => blocker.code === "migrations_in_diff"));

  const production = evaluatePreflight({ ...base, files: ["render.yaml"] });
  assert.ok(production.blockers.some((blocker) => blocker.code === "production_config_in_diff"));

  const blind = evaluatePreflight({ ...base, deployedSha: null });
  assert.ok(blind.blockers.some((blocker) => blocker.code === "deployed_sha_unknown"));

  const notStaging = evaluatePreflight({ ...base, flags: { ...base.flags, environment: "production" } });
  assert.ok(notStaging.blockers.some((blocker) => blocker.code === "environment_not_marked_staging"));
});

test("preflight classifies files and always offers a rollback", () => {
  const diff = classifyDiff(["migrations/0001.sql", "Dockerfile", "render.yaml", "tests/a.test.mjs", "docs/A.md", "server.mjs"]);
  assert.deepEqual(diff.migrations, ["migrations/0001.sql"]);
  assert.deepEqual(diff.deployment, ["Dockerfile"]);
  assert.deepEqual(diff.production, ["render.yaml"]);
  assert.deepEqual(diff.tests, ["tests/a.test.mjs"]);
  assert.deepEqual(diff.docs, ["docs/A.md"]);
  assert.deepEqual(diff.code, ["server.mjs"]);

  const procedure = deploymentProcedure({ targetSha: "76e9330aaaa", deployedSha: "efcf65caaaa" });
  assert.equal(procedure.length, 8);
  assert.ok(procedure.some((step) => /Redeploy/.test(step) && /efcf65c/.test(step)));
  assert.ok(procedure.some((step) => /NEXUS_RUNTIME: disabled/.test(step)));
});

test("escalation matching is per task and its body must carry the promised facts", () => {
  const messages = [
    { id: "m1", correlationId: "task:t1", body: "NEXUS EXECUTION FAILURE\nTask: t1\nReason: adapter refused\nAttempts: 1\nFailed at: now\nStatus: failed" },
    { id: "m2", correlationId: "task:t2", body: "unrelated" },
    { id: "m3", correlationId: null, body: "task:t1 mentioned but not correlated" }
  ];
  const found = findEscalations(messages, "t1");
  assert.deepEqual(found.map((message) => message.id), ["m1"]);
  assert.equal(findEscalations(messages, "t2").length, 1, "another task's message is not this task's escalation");

  assert.equal(validateEscalationBody(found[0].body, { taskId: "t1" }).ok, true);
  const incomplete = validateEscalationBody("NEXUS EXECUTION FAILURE", { taskId: "t1" });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.missing.includes("task id"));
  assert.ok(incomplete.missing.includes("attempt count"));
  assert.equal(validateEscalationBody(null, { taskId: "t1" }).ok, false);

  // One message per attempt is correct; two for one attempt is a duplicate.
  const perAttempt = summarizeAttempts([
    { body: "Attempts: 0" },
    { body: "Attempts: 1" }
  ]);
  assert.deepEqual(perAttempt.attempts, [0, 1]);
  assert.deepEqual(perAttempt.duplicates, []);

  const duplicated = summarizeAttempts([
    { body: "Attempts: 0" },
    { body: "Attempts: 0" }
  ]);
  assert.deepEqual(duplicated.duplicates, [0]);
  assert.deepEqual(summarizeAttempts([{ body: "no attempt line" }, null]).attempts, []);
});
