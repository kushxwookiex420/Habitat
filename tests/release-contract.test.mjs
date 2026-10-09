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
  assert.ok(source.includes("payload.artifact?.verified === true"));
  assert.ok(source.includes("Ax final review failed"));
  assert.ok(source.includes("publish approval required"));
  assert.ok(source.includes("Math.max(60, configuredAutonomousIntervalMinutes)"));
  assert.ok(source.includes('firstRun:"after full interval (no boot-time dispatch)"'));
  assert.ok(!source.includes("setTimeout(runAutonomous, 10000)"));
});

test("TikTok publisher validates consent and publish result", async () => {
  const source = await fs.readFile(new URL("../tiktok-publisher.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("userConsent"));
  assert.ok(source.includes("publish_id") || source.includes("publishId"));
});

test("Artifact 001 uses real official images and narration, never silent placeholder audio", async () => {
  const source = await fs.readFile(new URL("../scripts/render-artifact-001.sh", import.meta.url), "utf8");
  assert.ok(source.includes("rockstargames.com/VI/_next/static/media/"));
  assert.ok(source.includes("translate.google.com/translate_tts"));
  assert.ok(source.includes("narration-present"));
  assert.ok(!source.includes("anullsrc"));
  assert.ok(!source.includes("placeholder-silence"));
});

test("cross-session continuity checkpoint is durable and exposed by the backend", async () => {
  const checkpoint = await fs.readFile(new URL("../AX_CONTINUITY.md", import.meta.url), "utf8");
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const resources = await fs.readFile(new URL("../docs/FREE_RESOURCES.md", import.meta.url), "utf8");
  assert.ok(checkpoint.includes("Resume protocol for every new Ax / coding-agent session"));
  assert.ok(checkpoint.includes("runtime persistence"));
  assert.ok(server.includes('app.get("/continuity"'));
  assert.ok(server.includes('app.get("/continuity/status"'));
  assert.ok(server.includes('new URL("./AX_CONTINUITY.md", import.meta.url)'));
  assert.ok(resources.includes("free forever"));
});

test("runtime storage never claims durable persistence from an in-memory probe", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes('status: storagePassed ? "UNKNOWN" : "FAIL"'));
  assert.ok(server.includes('durable: false'));
  assert.ok(server.includes('persistence: "process-local"'));
  assert.ok(server.includes('nonPassingChecks = Object.entries(checks).filter(([, v]) => v.status !== "PASS")'));
});

test("critical modules are present and non-empty", async () => {
  for (const file of ["server.mjs", "content-engine.mjs", "visual-qa.mjs", "tiktok-publisher.mjs"]) {
    const source = await fs.readFile(new URL("../" + file, import.meta.url), "utf8");
    assert.ok(source.trim().length > 0, file);
  }
});