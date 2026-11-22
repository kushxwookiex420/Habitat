import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkReleaseInputs, checkEvidenceClaims, releaseOnlyChanges } from "../scripts/release-gate.mjs";

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

test("only documentation and release-record files may follow the validated commit", () => {
  assert.equal(releaseOnlyChanges(["release/manifest.json", "docs/NEXUS_MISSION_13.md"]), true);
  assert.equal(releaseOnlyChanges(["release/manifest.json", "ax-objectives.mjs"]), false);
  assert.equal(releaseOnlyChanges(["tests/release-gate.test.mjs"]), false);
  assert.equal(releaseOnlyChanges([]), false);
});

test("evidence claims must be explicit and a verified claim needs its identifiers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "habitat-gate-evidence-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "STAGING_VALIDATION_RESULTS.md"), "Staging status: NOT RUN — owner-blocked\nOwner action: create a disposable database\n");
    await writeFile(path.join(root, "docs", "ANDROID_MISSION_13_DEVICE_TEST.md"), "Android physical status: BUILD ONLY — owner-blocked\nOwner action: run the sheet on the S26 Ultra\n");
    const honest = await checkEvidenceClaims(root);
    assert.equal(honest.ok, true);

    await writeFile(path.join(root, "docs", "STAGING_VALIDATION_RESULTS.md"), "Staging status: STAGING VERIFIED\nAudit head: not-a-real-head\n");
    await writeFile(path.join(root, "docs", "ANDROID_MISSION_13_DEVICE_TEST.md"), "Android physical status: PHYSICAL S26 ULTRA VERIFIED\n");
    const unsupported = await checkEvidenceClaims(root);
    assert.equal(unsupported.ok, false);
    assert.ok(unsupported.checks.some(item => item.name === "staging write process recorded" && item.ok === false));
    assert.ok(unsupported.checks.some(item => item.name === "physical device model recorded" && item.ok === false));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete migration set still fails when other inputs exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "habitat-gate-partial-"));
  try {
    for (const file of ["docs/NEXUS_MISSION_12.md", "docs/SECURITY_REVIEW_MISSION_12.md", "docs/STAGING_VALIDATION.md", "docs/ANDROID_DEVICE_VALIDATION.md", "docs/NEXUS_MISSION_13.md", "docs/NEXUS_MISSION_13_BASELINE.md", "docs/STAGING_VALIDATION_RESULTS.md", "docs/ANDROID_MISSION_13_DEVICE_TEST.md", "docs/RENDER_INTEGRATION_READINESS.md", "release/demo-evidence.json", "release/perf-mission-12.json"]) {
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
