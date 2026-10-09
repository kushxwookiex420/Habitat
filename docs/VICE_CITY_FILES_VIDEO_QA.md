# Vice City Files — Video Production and Release Gate

This standard is mandatory for every generated video for @ViceCityFilesYT. A render is a draft until it passes the checks below. Never upload automatically; require explicit human approval.

## 1. Preserve the channel identity
- Reuse the existing approved Vice City Files intro asset/project. Do not recreate, replace, trim, or redesign it as part of an ordinary episode render.
- Keep the intro's first 7 seconds and its original audio intact. The episode narration and episode subtitles begin at 00:08.
- Add a deliberate, branded outro/end card to every episode. Do not treat a fade to black, an abruptly ending image, or the end of narration as an outro.
- If the original intro source asset is unavailable, stop and report the missing asset. Never silently substitute a storyboard, screenshot, or newly generated intro.

## 2. Timeline and narration integrity
- Build the final timeline from the actual audio duration, not an estimated script duration.
- Use speech-to-text or the narration text to verify that the final spoken sentence is complete. Leave at least 1.0 second of visual/audio tail after the final spoken word, then show the outro/end card for at least 2.0 seconds.
- Reject any render that ends during a word or sentence, cuts off the audio waveform, has narration extending past the video, or has a silent/black gap that was not intentional.
- Do not hard-code a 44-second endpoint or any other fixed duration. The end time must be computed from the assembled media and final narration.
- Confirm that the MP4 has both valid video and audio streams, a non-zero duration, and a playable final frame.

## 3. Visual composition
- Use source images/video that match the scene being discussed. Prefer official, verified game assets or clearly labeled illustrative visuals; never imply fan-made imagery is official gameplay.
- Keep all titles, captions, and subtitles within safe margins: at least 5% from each frame edge, with extra room for platform UI overlays.
- Do not place headers over important image subjects. Use a consistent title bar or lower-third with readable contrast, restrained font sizes, and no overlapping text.
- Fit the complete caption to the frame; wrap lines deliberately, limit to two lines at once, and measure text bounds before rendering.
- Keep images fully composed and intentionally cropped; avoid accidental extreme zooms, stretched images, black bars, and repeated static scenes where scene changes are expected.
- Match scene cuts to narration beats. Include a visible scene or composition change when the subject changes; do not animate every still with an automatic zoom by default.
- Normalize narration volume and avoid clipping, robotic artifacts, abrupt audio edits, and background music that masks speech.

## 4. Automated render checks (must fail the job on a critical error)
Before an artifact can be marked ready, check:
1. Container/video/audio streams are valid and duration is reported.
2. Intro is present at 00:00–00:07 and narration/subtitles do not begin before 00:08.
3. Outro/end card is present at the end and satisfies the minimum duration.
4. Narration reaches a complete ending; final audio does not get cut by the video duration.
5. Captions and title bounds remain inside safe margins; no title overlaps key imagery.
6. There are multiple intentional scenes when the script calls for them.
7. A contact sheet of sampled frames (opening, scene transitions, final 10 seconds) is generated for visual inspection.
8. A QA report records PASS/FAIL for every check and the artifact's duration, dimensions, frame rate, audio duration, and output filename.

Automated checks cannot fully judge whether visuals are tasteful or the narration sounds natural. Those items require actual playback and visual review.

## 5. Release decision
- Any critical failure means the artifact is rejected and must be rendered again; never label it approved or ready.
- After every render, play the opening, at least one middle transition, the last 10 seconds, and the complete ending audio. Inspect the contact sheet for text collisions, cropping, and irrelevant visuals.
- Store the QA report beside the artifact. A missing QA report means NOT VERIFIED.
- Only after all checks pass may the video be presented to the user for review. Public publishing still requires explicit user approval and valid platform authorization.

## 6. Regression cases
Every pipeline change must test at least:
- A short narration and a long narration.
- Narration whose final sentence is longer than the previous scene.
- A script whose length does not match any historical hard-coded duration.
- Missing intro or outro asset (must fail clearly rather than silently omit it).
- Long title/caption text (must wrap or fail; never overflow).
- Missing audio stream or a render whose audio is longer than the video.
