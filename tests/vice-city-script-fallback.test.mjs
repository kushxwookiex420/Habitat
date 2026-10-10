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
