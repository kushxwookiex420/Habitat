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
  assert.ok(source.includes("audio_longer_than_video"));
  assert.ok(source.includes("streamSync"));
  assert.ok(source.includes("toleranceSeconds: 0.12"));
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

test("TikTok token refresh is persisted through the encrypted vault before use", async () => {
  const source = await fs.readFile(new URL("../tiktok-publisher.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("async function ensureAccessToken()"));
  assert.ok(source.includes('grant_type: "refresh_token"'));
  assert.ok(source.includes('await tokenVault.set("tiktok_tokens", bundle)'));
  assert.ok(source.includes("refreshInFlight"));
  assert.ok(source.includes("refusing to refresh credentials without durable storage"));
});

test("Artifact 001 uses official images, neural narration, and a clean non-overlapping layout", async () => {
  const source = await fs.readFile(new URL("../scripts/render-artifact-001.sh", import.meta.url), "utf8");
  const workflow = await fs.readFile(new URL("../.github/workflows/artifact_001.yml", import.meta.url), "utf8");
  assert.ok(source.includes("rockstargames.com/VI/_next/static/media/"));
  assert.ok(source.includes("edge-tts"));
  assert.ok(source.includes("en-US-AndrewNeural"));
  assert.ok(!source.includes("translate.google.com/translate_tts"));
  assert.ok(source.includes("boxblur=24:12"));
  assert.ok(source.includes("drawbox=x=40:y=125:w=1000:h=250"));
  assert.ok(source.includes("drawbox=x=40:y=1535:w=1000:h=120"));
  assert.ok(source.includes("VOICE_DURATION"));
  assert.ok(source.includes("apad=pad_dur=1"));
  assert.ok(source.includes("source-duration-neural-narration-v5-smooth-30fps"));
  assert.ok(source.includes("-loop 1 -framerate 30"));
  assert.ok(!source.includes("-loop 1 -framerate 15"), "every still-scene input must use the same 30 fps cadence");
  assert.ok(!source.includes("zoompan"), "the renderer must not reintroduce zoompan judder");
  assert.ok(!source.includes("anullsrc"));
  assert.ok(!source.includes("placeholder-silence"));
  assert.ok(workflow.includes("Run deterministic visual and audio QA"));
  assert.ok(workflow.includes("if (result.status !== 'VISUAL_PASS') process.exit(1)"));
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
  assert.ok(server.includes('storagePassed ? "UNKNOWN" : "FAIL"'));
  assert.ok(server.includes('taskRepository && taskStorageReady ? (storagePassed ? "PASS" : "FAIL")'));
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

test("AI worker availability follows every configured provider, not OpenRouter alone", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes('status: hasAnyAiProviderKey() ? "available" : "blocked"'));
  assert.ok(!server.includes('status: apiKey ? "available" : "blocked"'));
});

test("brain status reports provider presence without exposing credentials", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes('app.get("/brain/status"'));
  assert.ok(server.includes('secretsExposed: false'));
  assert.ok(server.includes('note: "Configuration is not proof of a successful inference; use the system check for a live model test."'));
});


test("Cloudflare Workers AI credentials count as a usable configured brain", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const helper = server.match(/function hasAnyAiProviderKey\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(helper.includes("CLOUDFLARE_API_TOKEN"));
  assert.ok(helper.includes("CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(helper.includes("cloudflareReady"));
  assert.ok(server.includes('brain: hasAnyAiProviderKey() ? "ready" : "missing_api_key"'));
  assert.ok(server.includes("Cloudflare Workers AI, Groq, Gemini, OpenRouter"));
});

test("Cerebras is not counted unless the paid-provider opt-in is explicit", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const helper = server.match(/function hasAnyAiProviderKey\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(helper.includes('process.env.HABITAT_ALLOW_PAID_PROVIDERS || "").toLowerCase() === "true"'));
});

test("provider setup errors include Cloudflare Workers AI and paid Cerebras opt-in", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(server.includes("Cerebras requires CEREBRAS_API_KEY and HABITAT_ALLOW_PAID_PROVIDERS=true"));
});
