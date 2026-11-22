import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkReleaseInputs } from "../scripts/release-gate.mjs";

test("the release gate fails when required documents, artifacts or migrations are missing", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "habitat-gate-empty-"));
  try {
    const report = await checkReleaseInputs(empty);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some(item => item.name === "docs/NEXUS_MISSION_12.md" && item.ok === false));
    assert.ok(report.checks.some(item => item.name === "release/perf-mission-12.json" && item.ok === false));
    assert.ok(report.checks.some(item => item.name === "migrations/0005_ax_security_scheduler.sql" && item.ok === false));
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("an incomplete migration set still fails when other inputs exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "habitat-gate-partial-"));
  try {
    for (const file of ["docs/NEXUS_MISSION_12.md", "docs/SECURITY_REVIEW_MISSION_12.md", "docs/STAGING_VALIDATION.md", "docs/ANDROID_DEVICE_VALIDATION.md", "release/demo-evidence.json", "release/perf-mission-12.json"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "{}\n");
    }
    await mkdir(path.join(root, "migrations"), { recursive: true });
    await writeFile(path.join(root, "migrations", "0005_ax_security_scheduler.sql"), "CREATE TABLE IF NOT EXISTS habitat_ax_security_events (id TEXT);\n");
    const report = await checkReleaseInputs(root);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some(item => item.name === "migrations/0001_habitat_tasks.sql" && item.ok === false));
    assert.ok(report.checks.some(item => item.name === "0005 has scheduler table" && item.ok === false));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
