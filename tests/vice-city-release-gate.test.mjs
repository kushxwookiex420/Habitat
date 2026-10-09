import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("release gate fails closed when required approved intro/outro are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"vice-city-gate-"));
  const report = path.join(dir,"report.json");
  const result = spawnSync(process.execPath, ["scripts/vice-city-release-gate.mjs", path.join(dir,"missing-final.mp4"), path.join(dir,"missing-intro.mp4"), path.join(dir,"missing-outro.mp4"), report], {encoding:"utf8"});
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(fs.readFileSync(report,"utf8"));
  assert.equal(parsed.status,"BLOCKED");
  assert.equal(parsed.publishAllowed,false);
  assert.ok(parsed.issues.length > 0);
  fs.rmSync(dir,{recursive:true,force:true});
});

test("release gate requires an explicit timeline manifest and never authorizes publishing", () => {
  const source = fs.readFileSync("scripts/vice-city-release-gate.mjs","utf8");
  assert.match(source,/narrationStartSeconds/);
  assert.match(source,/finalSegment === "branded_outro"/);
  assert.match(source,/publishAllowed:false/);
  assert.match(source,/fixedDurationTrim !== true/);
});
