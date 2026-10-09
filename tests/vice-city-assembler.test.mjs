import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

test("assembler refuses to invent or silently substitute missing intro/outro assets", () => {
  const result = spawnSync("bash", ["scripts/assemble-vice-city-files.sh", "/tmp/missing-body.mp4", "/tmp/missing-intro.mp4", "/tmp/missing-outro.mp4", "/tmp/final.mp4"], {encoding:"utf8"});
  assert.notEqual(result.status, 0);
  assert.match((result.stderr||"")+(result.stdout||""), /Required approved media is missing/);
});

test("assembler uses source durations, a delayed narration start, and a real tail instead of a fixed 45-second trim", () => {
  const source = fs.readFileSync("scripts/assemble-vice-city-files.sh","utf8");
  assert.match(source,/probe_duration/);
  assert.match(source,/adelay=1000\|1000/);
  assert.match(source,/postNarrationTailSeconds":1\.0/);
  assert.match(source,/fixedDurationTrim/);
  assert.doesNotMatch(source,/-t 45\b/);
});
