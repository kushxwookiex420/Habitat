#!/usr/bin/env node
// Vice City Files release gate. Fail closed: an MP4 that merely exists is not publish-ready.
// Usage: node scripts/vice-city-release-gate.mjs <final.mp4> <original-intro.mp4> <outro.mp4> <report.json>
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const [artifact, intro, outro, reportPath] = process.argv.slice(2);
const issues = [];
const checks = {};
const probe = async (file) => {
  const st = await fs.stat(file);
  if (!st.isFile() || st.size < 10000) throw new Error(`Missing or implausibly small media file: ${file}`);
  const { stdout } = await run("ffprobe", ["-v","error","-show_entries","format=duration,size:stream=codec_type,width,height,codec_name","-of","json",file]);
  const d = JSON.parse(stdout);
  const v = d.streams?.find(s=>s.codec_type==="video");
  const a = d.streams?.find(s=>s.codec_type==="audio");
  const duration = Number(d.format?.duration || 0);
  if (!v || !a || duration <= 0) throw new Error(`Invalid video/audio streams or duration: ${file}`);
  return { durationSeconds: duration, bytes: st.size, width:Number(v.width), height:Number(v.height), videoCodec:v.codec_name, audioCodec:a.codec_name };
};
const check = (name, ok, detail) => { checks[name] = {status:ok?"PASS":"FAIL",...detail}; if(!ok) issues.push({check:name,...detail}); };
try {
  if (!artifact || !intro || !outro || !reportPath) throw new Error("Usage: node scripts/vice-city-release-gate.mjs <final.mp4> <original-intro.mp4> <outro.mp4> <report.json>");
  const [finalInfo,introInfo,outroInfo] = await Promise.all([probe(artifact),probe(intro),probe(outro)]);
  check("final_container", finalInfo.width > 0 && finalInfo.height > 0, finalInfo);
  check("original_intro_present", introInfo.durationSeconds >= 7, {path:intro,durationSeconds:introInfo.durationSeconds,requiredMinimumSeconds:7});
  check("outro_present", outroInfo.durationSeconds >= 2, {path:outro,durationSeconds:outroInfo.durationSeconds,requiredMinimumSeconds:2});
  check("final_has_room_for_branded_segments", finalInfo.durationSeconds >= introInfo.durationSeconds + outroInfo.durationSeconds + 8, {finalDurationSeconds:finalInfo.durationSeconds,introDurationSeconds:introInfo.durationSeconds,outroDurationSeconds:outroInfo.durationSeconds});
  check("final_not_truncated_at_44_seconds", finalInfo.durationSeconds > 44, {durationSeconds:finalInfo.durationSeconds,minimumSecondsExclusive:44});
  // Require an explicit edit-decision manifest from the assembler proving that the
  // approved intro is first, narration begins at 8s, and the outro is the final segment.
  const manifestPath = process.env.VICE_CITY_EDIT_MANIFEST;
  let manifest = null;
  if (manifestPath) {
    manifest = JSON.parse(await fs.readFile(manifestPath,"utf8"));
  }
  const validManifest = manifest &&
    path.resolve(manifest.introPath||"") === path.resolve(intro) &&
    Number(manifest.narrationStartSeconds) >= 8 &&
    Number(manifest.outroDurationSeconds) >= 2 &&
    manifest.finalSegment === "branded_outro" &&
    manifest.narrationComplete === true &&
    manifest.fixedDurationTrim !== true;
  check("timeline_manifest", Boolean(validManifest), {
    manifestPath:manifestPath||null,
    requirement:"Original intro first; narration starts at >=8s; complete narration; >=2s branded outro last; no fixed-duration truncation."
  });
} catch (e) {
  issues.push({check:"gate_execution",detail:String(e?.message||e)});
  checks.gate_execution = {status:"FAIL",detail:String(e?.message||e)};
}
const report = {
  project:"Vice City Files",
  gate:"VICE_CITY_FILES_RELEASE_GATE_V1",
  status:issues.length ? "BLOCKED" : "REVIEW_READY",
  publishAllowed:false,
  note:"Review-ready does not authorize publishing. Human approval remains required.",
  verifiedAt:new Date().toISOString(),
  artifact:artifact||null,
  checks,
  issues
};
if (reportPath) {
  await fs.mkdir(path.dirname(path.resolve(reportPath)),{recursive:true});
  await fs.writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
}
console.log(JSON.stringify(report,null,2));
if (issues.length) process.exitCode=1;
