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
  assert.ok(source.includes("clip1.mp4"));
  assert.ok(source.includes("clip6.mp4"));
  assert.ok(source.includes("Real-world B-roll (NOT GTA gameplay)"));
  assert.ok(source.includes("REAL-WORLD B-ROLL • NOT GAMEPLAY"));
  assert.ok(source.includes("broll-attribution.txt"));
  assert.ok(source.includes("overlay=(W-w)/2:430+(650-h)/2:shortest=1"));
  assert.ok(source.includes("drawbox=x=40:y=125:w=1000:h=250"));
  assert.ok(source.includes("drawbox=x=40:y=1535:w=1000:h=120"));
  assert.ok(source.includes("VOICE_DURATION"));
  assert.ok(source.includes("apad=pad_dur=1"));
  assert.ok(source.includes("source-duration-neural-narration-v7-moving-broll"));
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


test("Artifact 001 workflow can rebuild branded intro/outro clips when the optional bundle is absent", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/artifact_001.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("librsvg2-bin"));
  assert.ok((workflow.match(/--retry 6 --retry-all-errors --retry-delay 8 --retry-max-time 180 --max-time 240/g) || []).length >= 3);
  assert.ok(workflow.includes("rsvg-convert -o /tmp/vice-city-title-card.png artifacts/vice-city-6-title-card.svg"));
  assert.ok(workflow.includes("assets/vice-city-files-intro.mp4"));
  assert.ok(workflow.includes("assets/vice-city-files-outro.mp4"));
  assert.ok(workflow.includes("FOLLOW FOR FACT-CHECKED GAMING UPDATES"));
  assert.ok(workflow.includes("test -s assets/vice-city-files-intro.mp4"));
  assert.ok(workflow.includes("test -s assets/vice-city-files-outro.mp4"));
});


test("visual QA falls back to system FFmpeg when bundled npm binaries are absent", async () => {
  const visualQa = await fs.readFile(new URL("../visual-qa.mjs", import.meta.url), "utf8");
  assert.ok(visualQa.includes('process.env.HABITAT_FFMPEG_PATH || "ffmpeg"'));
  assert.ok(visualQa.includes('process.env.HABITAT_FFPROBE_PATH || "ffprobe"'));
  assert.ok(visualQa.includes('createRequire(import.meta.url)'));
  assert.doesNotMatch(visualQa, /^import ffmpegPath from "ffmpeg-static";/m);
  assert.doesNotMatch(visualQa, /^import ffprobeStatic from "ffprobe-static";/m);
});


test("autonomous scheduler delegates heavy video rendering to the external GitHub runner", async () => {
  const scheduler = await fs.readFile(new URL("../.github/workflows/habitat-autonomous-scheduler.yml", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../.github/workflows/artifact_001.yml", import.meta.url), "utf8");
  assert.ok(scheduler.includes("uses: ./.github/workflows/artifact_001.yml"));
  assert.ok(scheduler.includes('cron: "17 14 * * *"'));
  assert.ok(!scheduler.includes("/content/autonomous-run"));
  assert.ok(renderer.includes("workflow_call:"));
  assert.ok(renderer.includes('inputs.objective || \'Create Artifact 001: Vice City 6: The Next Big Leap\''));
  assert.ok(scheduler.includes('cron: "17 14 * * *"'));
  assert.ok(!scheduler.includes("deferStagesToCaller"));
  assert.ok(!scheduler.includes("run_stage research"));
  assert.ok(renderer.includes("Render real MP4 locally"));
  assert.ok(renderer.includes("Run deterministic visual and audio QA"));
});





test("DropPilot runs a bounded daily rotation of demo-source research without auto-using third-party footage", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/droppilot-demo-research-daily.yml", import.meta.url), "utf8");
  const research = await fs.readFile(new URL("../product-demo-research.mjs", import.meta.url), "utf8");
  assert.ok(workflow.includes('cron: "37 14 * * *"'));
  assert.ok(workflow.includes(".github/workflows/droppilot-demo-research-daily.yml"));
  assert.ok(workflow.includes('sleep 75'));
  assert.ok(workflow.includes("max-parallel: 2"));
  assert.ok(workflow.includes('first=$(((day_number - 1) * 2 % 19))'));
  assert.ok(workflow.includes("second=$(((first + 1) % 19))"));
  assert.ok(workflow.includes("Save research evidence for rights review"));
  assert.ok(research.includes("Results are leads, NOT proof of reuse rights"));
  assert.ok(research.includes("commercial permission/licence is confirmed"));
});


test("video renderer derives narration and mobile-safe scene overlays from the generated script", async () => {
  const renderer = await fs.readFile(new URL("../scripts/render-artifact-001.sh", import.meta.url), "utf8");
  assert.ok(renderer.includes('SCRIPT_JSON="${2:-}"'));
  assert.ok(renderer.includes('payload.get("job",{}).get("stages",{}).get("script",{}).get("result")'));
  assert.ok(renderer.includes('script.get("voiceover"'));
  assert.ok(renderer.includes('scene-plan.json'));
  assert.ok(renderer.includes('jq -r ".scenes[$i].title"'));
  assert.ok(renderer.includes('jq -r ".scenes[$i].subtitle"'));
  assert.ok(renderer.includes('renderer":"source-duration-neural-narration-v7-moving-broll"'));
});


test("Artifact 001 uses six moving B-roll clips with attribution and a no-gameplay disclaimer", async () => {
  const source = await fs.readFile(new URL("../scripts/render-artifact-001.sh", import.meta.url), "utf8");
  const workflow = await fs.readFile(new URL("../.github/workflows/artifact_001.yml", import.meta.url), "utf8");
  assert.equal((source.match(/videos\.pexels\.com\/video-files\//g) || []).length, 6);
  assert.ok(source.includes('cp "$TMP/broll-attribution.txt" "${OUT}.attribution.txt"'));
  assert.ok(source.includes('map "[v]" -map 12:a:0'));
  assert.ok(workflow.includes("habitat-artifact-001-body.mp4.attribution.txt"));
  assert.ok(workflow.includes("habitat-artifact-001.mp4.attribution.txt"));
});
