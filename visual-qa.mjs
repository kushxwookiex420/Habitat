// Habitat Visual QA Worker
// Deterministic media inspection: dimensions, duration, black/blank frames,
// freeze detection, scene progression, and render-plan safe-area preflight.
// This module never claims a visual PASS from model prose alone.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

function parseJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

function estimateTextWidth(text, fontSize, bold = false) {
  // Conservative proportional estimate for DejaVu Sans used by the renderer.
  // It intentionally overestimates so overflow becomes a block rather than a miss.
  const factor = bold ? 0.64 : 0.58;
  return String(text ?? "").length * Number(fontSize || 16) * factor;
}

function safeAreaPreflight(renderPlan, width, height) {
  const issues = [];
  const safeLeft = Math.round(width * 0.072);
  const safeRight = Math.round(width * 0.928);
  const safeTop = Math.round(height * 0.08);
  const safeBottom = Math.round(height * 0.94);
  const maxTextWidth = safeRight - safeLeft;
  const texts = Array.isArray(renderPlan?.onScreenText) ? renderPlan.onScreenText : [];

  for (const text of texts) {
    const value = typeof text === "string" ? text : (text?.text || text?.value || "");
    if (!value) continue;
    const fontSize = Number(text?.fontSize || 32);
    const bold = text?.bold !== false;
    const estimate = estimateTextWidth(value, fontSize, bold);
    if (estimate > maxTextWidth) {
      issues.push({ type:"text_overflow_risk", text:value, estimatedWidthPx:Math.round(estimate), maxSafeWidthPx:maxTextWidth });
    }
  }

  const scenes = Array.isArray(renderPlan?.scenes) ? renderPlan.scenes : [];
  if (!scenes.length) issues.push({ type:"scene_plan_missing", detail:"No scenes were supplied to the visual gate." });
  if (width > 0 && height > 0 && Math.abs((width / height) - (9 / 16)) > 0.01 && String(renderPlan?.format) === "9:16") {
    issues.push({ type:"aspect_ratio_plan_mismatch", format:renderPlan.format, width, height });
  }

  return { safeArea:{left:safeLeft,right:safeRight,top:safeTop,bottom:safeBottom}, issues };
}

export async function runVisualQA({ artifactPath, renderPlan = {}, expectedSceneCount = null, requireAudio = true }) {
  const startedAt = Date.now();
  const issues = [];
  const checks = {};

  try {
    const stat = await fs.stat(artifactPath);
    checks.file = { status: stat.size > 0 ? "PASS" : "FAIL", bytes: stat.size };
    if (!stat.size) issues.push({ type:"empty_artifact", detail:"MP4 file is empty." });

    const probe = await execFileAsync("ffprobe", [
      "-v","error",
      "-show_entries","format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels",
      "-of","json",artifactPath
    ]);
    const data = parseJson(probe.stdout);
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find(s => s.codec_type === "video") || {};
    const audio = streams.find(s => s.codec_type === "audio") || null;
    const duration = Number(data?.format?.duration || 0);
    const width = Number(video.width || 0);
    const height = Number(video.height || 0);

    checks.container = {
      status: duration > 0 && width > 0 && height > 0 ? "PASS" : "FAIL",
      durationSeconds: duration, width, height, frameRate: video.r_frame_rate || null
    };
    if (duration <= 0) issues.push({ type:"invalid_duration", duration });
    if (!width || !height) issues.push({ type:"missing_video_dimensions" });

    // Content intended for social publishing must carry an audio stream by default.
    // This catches silent exports before they reach the creator approval step.
    checks.audioTrack = {
      status: audio || !requireAudio ? "PASS" : "FAIL",
      required: Boolean(requireAudio),
      present: Boolean(audio),
      codec: audio?.codec_name || null,
      sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
      channels: audio?.channels ? Number(audio.channels) : null
    };
    if (!audio && requireAudio) {
      issues.push({ type:"missing_audio_track", detail:"No audio stream was found; add the intended voiceover/music or explicitly set requireAudio=false for a silent deliverable." });
    }

    // A container can have an audio track that contains only digital silence.
    // Detect that separately so a silent placeholder cannot pass as narrated content.
    if (audio && requireAudio) {
      const volume = await execFileAsync("ffmpeg", [
        "-hide_banner","-nostats","-i",artifactPath,
        "-vn","-af","volumedetect","-f","null","-"
      ]).catch(e => ({ stdout:"", stderr:String(e?.stderr || e?.message || e) }));
      const volumeText = String(volume.stderr || "");
      const meanMatch = volumeText.match(/mean_volume:\s*(-?inf|-?[0-9.]+)\s*dB/i);
      const meanVolumeDb = meanMatch ? (meanMatch[1].toLowerCase() === "-inf" ? -Infinity : Number(meanMatch[1])) : null;
      const silent = meanVolumeDb === -Infinity || (Number.isFinite(meanVolumeDb) && meanVolumeDb <= -55);
      checks.audioLevel = {
        status: meanVolumeDb === null ? "UNKNOWN" : silent ? "FAIL" : "PASS",
        meanVolumeDb: meanVolumeDb === -Infinity ? "-Infinity" : meanVolumeDb,
        thresholdDb: -55
      };
      if (silent) {
        issues.push({ type:"silent_audio_track", meanVolumeDb:meanVolumeDb === -Infinity ? "-Infinity" : meanVolumeDb, detail:"The audio stream is effectively silent; a voiceover/music track is required for this content workflow." });
      } else if (meanVolumeDb === null) {
        issues.push({ type:"audio_level_unmeasurable", detail:"Could not measure audio level; verify the audio stream before publishing." });
      }
    }

    const preflight = safeAreaPreflight(renderPlan, width, height);
    checks.safeArea = { status: preflight.issues.length ? "FAIL" : "PASS", ...preflight };
    issues.push(...preflight.issues);

    // Black-frame detector. A few frames may legitimately be dark, so only a
    // sustained black interval is a defect.
    const black = await execFileAsync("ffmpeg", [
      "-hide_banner","-loglevel","info","-i",artifactPath,
      "-vf","blackdetect=d=0.60:pix_th=0.02",
      "-an","-f","null","-"
    ]).catch(e => ({ stdout:"", stderr:String(e?.stderr || e?.message || e) }));
    const blackMatches = String(black.stderr || "").match(/black_start:([0-9.]+).*?black_end:([0-9.]+).*?black_duration:([0-9.]+)/g) || [];
    const blackIntervals = blackMatches.map(line => {
      const m=line.match(/black_start:([0-9.]+).*?black_end:([0-9.]+).*?black_duration:([0-9.]+)/);
      return m ? {start:Number(m[1]),end:Number(m[2]),duration:Number(m[3])} : null;
    }).filter(Boolean);
    checks.blackFrames = { status: blackIntervals.length ? "FAIL" : "PASS", intervals:blackIntervals };
    if (blackIntervals.length) issues.push({ type:"sustained_black_frame", intervals:blackIntervals });

    // Freeze detector catches the exact class of failure where a video plays but
    // the visual scene never changes. A short static title card is allowed.
    const freeze = await execFileAsync("ffmpeg", [
      "-hide_banner","-loglevel","info","-i",artifactPath,
      "-vf","freezedetect=n=0.003:d=2",
      "-an","-f","null","-"
    ]).catch(e => ({ stdout:"", stderr:String(e?.stderr || e?.message || e) }));
    const freezeText = String(freeze.stderr || "");
    const freezeMatches = freezeText.match(/freeze_start:([0-9.]+).*?freeze_duration:([0-9.]+)/g) || [];
    const freezeIntervals = freezeMatches.map(line => {
      const m=line.match(/freeze_start:([0-9.]+).*?freeze_duration:([0-9.]+)/);
      return m ? {start:Number(m[1]),duration:Number(m[2])} : null;
    }).filter(Boolean).filter(x => x.duration >= 2.5);
    checks.freeze = { status: freezeIntervals.length ? "FAIL" : "PASS", intervals:freezeIntervals };
    if (freezeIntervals.length) issues.push({ type:"frozen_visual", intervals:freezeIntervals });

    // Scene-change detector: require meaningful visual transitions when the plan
    // explicitly contains multiple scenes. This is independent of model judgment.
    const scene = await execFileAsync("ffmpeg", [
      "-hide_banner","-loglevel","info","-i",artifactPath,
      "-vf","select='gt(scene,0.02)',showinfo",
      "-an","-f","null","-"
    ]).catch(e => ({ stdout:"", stderr:String(e?.stderr || e?.message || e) }));
    const sceneTimes = [...String(scene.stderr || "").matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(m[1]));
    const uniqueSceneTimes = sceneTimes.filter((v,i,a) => i === 0 || Math.abs(v-a[i-1]) > 0.25);
    const plannedCount = expectedSceneCount ?? (Array.isArray(renderPlan?.scenes) ? renderPlan.scenes.length : 0);
    const minimumTransitions = Math.max(0, Number(plannedCount || 0) - 1);
    checks.sceneProgression = {
      status: minimumTransitions === 0 || uniqueSceneTimes.length >= Math.max(1, minimumTransitions) ? "PASS" : "FAIL",
      plannedScenes:Number(plannedCount || 0), detectedTransitions:uniqueSceneTimes.length, transitionTimes:uniqueSceneTimes.slice(0,50)
    };
    if (checks.sceneProgression.status === "FAIL") {
      issues.push({ type:"scene_progression_failed", plannedScenes:Number(plannedCount || 0), detectedTransitions:uniqueSceneTimes.length, transitionTimes:uniqueSceneTimes });
    }

    const remediation = issues.map(issue => {
      switch (issue.type) {
        case "text_overflow_risk": return { action:"resize_text", text:issue.text, instruction:"Reduce font size or shorten the on-screen text until estimated width is within the safe area." };
        case "missing_audio_track": return { action:"add_or_restore_audio", instruction:"Add the intended voiceover or licensed audio track, re-render, and re-run Visual QA." };
        case "silent_audio_track": return { action:"replace_silent_audio", instruction:"Replace placeholder silence with the intended recorded/generated voiceover and properly licensed background audio, then re-render and re-run Visual QA." };
        case "audio_level_unmeasurable": return { action:"verify_audio", instruction:"Inspect the audio stream and ensure it contains audible speech/music before publishing." };
        case "sustained_black_frame": return { action:"repair_black_frames", instruction:"Replace the affected interval with a valid scene frame/background and re-render." };
        case "frozen_visual": return { action:"repair_frozen_scene", instruction:"Ensure the affected scene changes visually or shorten the static interval below the freeze threshold." };
        case "scene_progression_failed": return { action:"repair_scene_progression", instruction:"Ensure every planned scene produces a meaningful visual transition and re-render." };
        case "aspect_ratio_plan_mismatch": return { action:"repair_aspect_ratio", instruction:"Render the requested 9:16 output at 1080x1920." };
        case "scene_plan_missing": return { action:"repair_scene_plan", instruction:"Supply an explicit scene list before rendering." };
        default: return { action:"inspect_and_repair", instruction:"Resolve the machine-reported defect and re-run Visual QA." };
      }
    });
    const overall = issues.length ? "BLOCKED" : "VISUAL_PASS";
    return {
      status:overall,
      remediation,
      repairRequired: issues.length > 0,
      verifiedAt:new Date().toISOString(),
      durationMs:Date.now()-startedAt,
      checks,
      issues,
      artifact:{path:artifactPath,durationSeconds:duration,width,height,bytes:stat.size},
      machineDerived:true
    };
  } catch (error) {
    return {
      status:"BLOCKED",
      verifiedAt:new Date().toISOString(),
      durationMs:Date.now()-startedAt,
      checks,
      issues:[...issues,{type:"visual_qa_execution_error",detail:String(error?.message || error)}],
      machineDerived:true
    };
  }
}
