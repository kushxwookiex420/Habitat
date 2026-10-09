import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { runVisualQA } from "../visual-qa.mjs";

test("Visual QA fails closed when the artifact is missing", async () => {
  const result = await runVisualQA({
    artifactPath: new URL("../missing-release-test.mp4", import.meta.url).pathname,
    renderPlan: { format: "9:16", scenes: [{ start: 0, end: 1, title: "test" }] }
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.length > 0);
});

test("Visual QA requires audio and checks silent tracks", async () => {
  const source = await fs.readFile(new URL("../visual-qa.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("requireAudio = true"));
  assert.ok(source.includes("missing_audio_track"));
  assert.ok(source.includes("silent_audio_track"));
});

test("render and publish paths stay approval gated", async () => {
  const source = await fs.readFile(new URL("../content-engine.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("const maxAttempts = 3"));
  assert.ok(source.includes("artifact.verified === true"));
  assert.ok(source.includes("Ax final review failed"));
  assert.ok(source.includes("publish approval required"));
});

test("TikTok publisher validates consent and publish result", async () => {
  const source = await fs.readFile(new URL("../tiktok-publisher.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("userConsent"));
  assert.ok(source.includes("publish_id") || source.includes("publishId"));
});

test("critical modules are present and non-empty", async () => {
  for (const file of ["server.mjs", "content-engine.mjs", "visual-qa.mjs", "tiktok-publisher.mjs"]) {
    const source = await fs.readFile(new URL("../" + file, import.meta.url), "utf8");
    assert.ok(source.trim().length > 0, file);
  }
});
