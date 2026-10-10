import test from "node:test";
import assert from "node:assert/strict";
import { normalizeViceCityScript } from "../vice-city-script-fallback.mjs";

test("uses a factual render-compatible fallback when model narration is missing", () => {
  const result = normalizeViceCityScript({ title: "model output without voiceover" });
  assert.equal(typeof result.voiceover, "string");
  assert.ok(result.voiceover.length >= 80);
  assert.equal(result.fallbackReason !== undefined, true);
  assert.ok(result.sources.some(source => source.includes("rockstargames.com")));
  assert.equal(result.shotList.length, 6);
});

test("preserves a valid model voiceover without replacing it", () => {
  const voiceover = "This is a complete model voiceover with enough words to pass the production narration minimum.";
  const result = normalizeViceCityScript({ title: "Generated", voiceover });
  assert.equal(result.voiceover, voiceover);
  assert.equal(result.fallbackReason, undefined);
});

test("falls back when narration is long but required production fields are absent", () => {
  const result = normalizeViceCityScript({ voiceover: "This is long enough narration but the rest of the script schema is incomplete and cannot be rendered safely." });
  assert.ok(result.fallbackReason);
  assert.ok(Array.isArray(result.onScreenText) && result.onScreenText.length > 0);
  assert.ok(Array.isArray(result.hashtags) && result.hashtags.length > 0);
});
