# Vice City Files Video Production Standard

This is the mandatory default for every Habitat-generated Vice City Files video. A successful export is not a publish-ready result.

## Required structure
1. **Intro card and spoken hook:** channel identity, topic, and a clear reason to keep watching.
2. **Main story:** fact-checked narration synchronized to readable, relevant visuals; no title may cover the important subject.
3. **Outro card and spoken close:** channel identity plus a short follow prompt. The outro must have visible screen time after the last spoken word.
4. Use a 9:16, 1080x1920 master unless the job explicitly requests another format.

## Hard release gates
- Never hard-trim narration to a fixed target duration. Measure the rendered narration and make the timeline fit it.
- Audio must not extend beyond the video, and narration must not be cut off by `-t`, `-shortest`, or an export preset.
- Verify intro and outro are represented in the render plan and in the actual timeline; do not count a footer watermark as an outro.
- Require at least 1.5 seconds of clean outro hold after narration finishes.
- Verify media duration, video/audio stream durations, audible audio, scene progression, black/frozen frames, and text safe-area risks.
- If speech-end or outro timing cannot be measured reliably, mark QA **BLOCKED / REVIEW REQUIRED**. Never silently pass an unknown.
- Automated checks are a floor, not a substitute for watching the complete video. Public posting remains behind the creator's explicit approval.

## Repair policy
On any failed gate, retain the artifact for inspection, report the exact failing check, repair the timeline/render plan, regenerate the MP4, and rerun all QA. Do not label the failed artifact ready to publish.
