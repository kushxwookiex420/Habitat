import test from "node:test";
import assert from "node:assert/strict";
import { normalizeViceCityScript } from "../vice-city-script-fallback.mjs";

const validVoiceover = "Rockstar Games has shared several confirmed details about the next Grand Theft Auto game. The story follows Jason and Lucia through Leonida, with Vice City at the center of the setting. PlayStation Five and Xbox Series X and Series S are the announced launch platforms. Keep rumors separate from official announcements, and check Rockstar sources before treating new claims as facts. Follow Vice City Files for clear updates without speculation.";

function validScript(voiceover = validVoiceover) {
  return {
    title: "Confirmed GTA details",
    hook: "Here are the official details.",
    voiceover,
    onScreenText: ["Confirmed details"],
    shotList: ["Opening", "Setting", "Platforms", "Closing"],
    caption: "Official details only.",
    hashtags: ["#Gaming"]
  };
}

test("uses a factual render-compatible fallback when model narration is missing", () => {
  const result = normalizeViceCityScript({ title: "model output without voiceover" });
  assert.equal(typeof result.voiceover, "string");
  assert.ok(result.voiceover.length >= 180);
  assert.equal(result.fallbackReason !== undefined, true);
  assert.ok(result.sources.some(source => source.includes("rockstargames.com")));
  assert.equal(result.shotList.length, 6);
});

test("preserves coherent model narration that passes production checks", () => {
  const result = normalizeViceCityScript(validScript());
  assert.equal(result.voiceover, validVoiceover);
  assert.equal(result.fallbackReason, undefined);
});

test("falls back when narration is long enough but production fields are absent", () => {
  const result = normalizeViceCityScript({ voiceover: validVoiceover });
  assert.ok(result.fallbackReason);
  assert.ok(Array.isArray(result.onScreenText) && result.onScreenText.length > 0);
  assert.ok(Array.isArray(result.hashtags) && result.hashtags.length > 0);
});

test("falls back when the model returns a short narration", () => {
  const result = normalizeViceCityScript(validScript("This is a short narration that cannot support a complete video."));
  assert.match(result.fallbackReason, /too short|fewer than 35/);
  assert.ok(result.voiceover.length >= 180);
});

test("falls back when narration contains placeholder text", () => {
  const result = normalizeViceCityScript(validScript("Insert narration here. This placeholder text should not be rendered as a finished video."));
  assert.match(result.fallbackReason, /placeholder/);
});

test("falls back when narration is raw JSON rather than spoken prose", () => {
  const result = normalizeViceCityScript(validScript(JSON.stringify({ voiceover: validVoiceover })));
  assert.ok(result.fallbackReason);
  assert.equal(result.voiceover, normalizeViceCityScript({}).voiceover);
  assert.doesNotMatch(result.voiceover, /^\s*\{/);
});

test("falls back when narration repeats the same words excessively", () => {
  const repeated = Array(50).fill("GTA GTA GTA GTA GTA GTA GTA.").join(" ");
  const result = normalizeViceCityScript(validScript(repeated));
  assert.match(result.fallbackReason, /repetitive/);
});


test("uses a legacy-specific fallback when the daily objective is about Vice City's return", () => {
  const objective = "Create a fresh Vice City Files short about the legacy of Vice City and its confirmed connection to GTA VI.";
  const result = normalizeViceCityScript({ title: "broken model output" }, objective);
  assert.equal(result.title, "VICE CITY'S RETURN");
  assert.match(result.voiceover, /Vice City back as a central setting/i);
  assert.equal(result.onScreenText.length, 6);
  assert.equal(result.shotList.length, 6);
});

test("rejects a valid but generic script when it ignores the requested daily topic", () => {
  const objective = "Create a fresh Vice City Files short about the legacy of Vice City.";
  const result = normalizeViceCityScript(validScript(), objective);
  assert.equal(result.title, "VICE CITY'S RETURN");
  assert.match(result.fallbackReason, /did not address the requested daily topic/);
});

test("uses a platform-specific fallback when the free model cannot deliver a valid script", () => {
  const objective = "Create a short about officially confirmed launch platforms and availability.";
  const result = normalizeViceCityScript({}, objective);
  assert.equal(result.title, "WHERE GTA VI IS ANNOUNCED");
  assert.match(result.voiceover, /PlayStation Five and Xbox Series X and Series S/);
  assert.equal(result.onScreenText.length, 6);
});
