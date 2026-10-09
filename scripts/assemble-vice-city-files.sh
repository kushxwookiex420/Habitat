#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Usage: $0 <body.mp4> <approved-intro.mp4> <approved-outro.mp4> <final.mp4> [edit-manifest.json]" >&2
  exit 64
fi

BODY=$(realpath "$1")
INTRO=$(realpath "$2")
OUTRO=$(realpath "$3")
OUT=$(realpath -m "$4")
MANIFEST=$(realpath -m "${5:-vice-city-edit-manifest.json}")
for f in "$BODY" "$INTRO" "$OUTRO"; do
  [[ -s "$f" ]] || { echo "Required approved media is missing or empty: $f" >&2; exit 42; }
done
mkdir -p "$(dirname "$OUT")" "$(dirname "$MANIFEST")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

probe_duration() {
  ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1"
}
BODY_DURATION=$(probe_duration "$BODY")
INTRO_SOURCE_DURATION=$(probe_duration "$INTRO")
OUTRO_DURATION=$(probe_duration "$OUTRO")
python - "$BODY_DURATION" "$INTRO_SOURCE_DURATION" "$OUTRO_DURATION" <<'PY'
import sys
body,intro,outro=map(float,sys.argv[1:])
if body <= 1: raise SystemExit("Body video must exceed one second.")
if intro <= 1: raise SystemExit("Approved intro is invalid or too short.")
if outro < 2: raise SystemExit("Approved branded outro must be at least two seconds.")
PY

# Preserve the entire source intro. If shorter than seven seconds, extend only
# its final branded frame; narration starts at 8s (or after a longer intro).
TARGET_INTRO=$(python - "$INTRO_SOURCE_DURATION" <<'PY'
import sys
print(max(7.0,float(sys.argv[1])))
PY
)
INTRO_HOLD=$(python - "$TARGET_INTRO" "$INTRO_SOURCE_DURATION" <<'PY'
import sys
print(max(0.0,float(sys.argv[1])-float(sys.argv[2])))
PY
)
NARRATION_START=$(python - "$TARGET_INTRO" <<'PY'
import sys
print(float(sys.argv[1])+1.0)
PY
)
BODY_ASSEMBLED_DURATION=$(python - "$BODY_DURATION" <<'PY'
import sys
print(float(sys.argv[1])+2.0)
PY
)

render_brand_segment() {
  local source="$1" duration="$2" hold="$3" output="$4"
  ffmpeg -hide_banner -loglevel error -y \
    -i "$source" \
    -f lavfi -t "$duration" -i "anullsrc=channel_layout=stereo:sample_rate=48000" \
    -filter_complex "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:14,eq=brightness=-0.22:saturation=0.78[back];[fg]scale=1080:608:force_original_aspect_ratio=decrease:flags=lanczos[front];[back][front]overlay=(W-w)/2:(H-h)/2,tpad=stop_mode=clone:stop_duration=${hold},fps=30,setsar=1,format=yuv420p[v]" \
    -map "[v]" -map 1:a:0 -t "$duration" \
    -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 96k -ar 48000 -ac 2 \
    -movflags +faststart "$output"
}

render_brand_segment "$INTRO" "$TARGET_INTRO" "$INTRO_HOLD" "$TMP/intro.mp4"
render_brand_segment "$OUTRO" "$OUTRO_DURATION" "0" "$TMP/outro.mp4"

# Keep the entire generated voice track, delay it until the intro has cleared,
# and add a one-second audio tail rather than trimming to a guessed endpoint.
ffmpeg -hide_banner -loglevel error -y -i "$BODY" \
  -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=2,fps=30,setsar=1,format=yuv420p[v];[0:a]adelay=1000|1000,apad=pad_dur=1[a]" \
  -map "[v]" -map "[a]" -t "$BODY_ASSEMBLED_DURATION" \
  -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 160k -ar 48000 -ac 2 \
  -movflags +faststart "$TMP/body.mp4"

printf "file '%s'\nfile '%s'\nfile '%s'\n" "$TMP/intro.mp4" "$TMP/body.mp4" "$TMP/outro.mp4" > "$TMP/concat.txt"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$TMP/concat.txt" \
  -c copy -movflags +faststart "$OUT"

python - "$OUT" "$INTRO" "$OUTRO" "$MANIFEST" "$INTRO_SOURCE_DURATION" "$TARGET_INTRO" "$NARRATION_START" "$OUTRO_DURATION" "$BODY_DURATION" <<'PY'
import json,os,subprocess,sys
out,intro,outro,manifest,source_intro,intro_timeline,narration_start,outro_duration,body_duration=sys.argv[1:]
p=json.loads(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration,size:stream=codec_type,width,height,codec_name,sample_rate","-of","json",out],text=True))
v=next((s for s in p["streams"] if s["codec_type"]=="video"),None)
a=next((s for s in p["streams"] if s["codec_type"]=="audio"),None)
duration=float(p["format"]["duration"])
if not v or not a: raise SystemExit("Final assembly is missing video or audio.")
if (int(v["width"]),int(v["height"])) != (1080,1920): raise SystemExit("Final assembly must be 1080x1920.")
if abs(duration-(float(intro_timeline)+float(body_duration)+2+float(outro_duration))) > 0.75:
    raise SystemExit(f"Unexpected final duration {duration:.2f}s.")
record={
 "introPath":intro,
 "introSourceDurationSeconds":float(source_intro),
 "introTimelineSeconds":float(intro_timeline),
 "narrationStartSeconds":float(narration_start),
 "bodyAudioDurationSeconds":float(body_duration),
 "postNarrationTailSeconds":1.0,
 "outroPath":outro,
 "outroDurationSeconds":float(outro_duration),
 "finalSegment":"branded_outro",
 "narrationComplete":True,
 "fixedDurationTrim":False,
 "assembly":"dynamic-source-duration-v1",
 "note":"All generated voiceover bytes were retained and padded by one second; speech content still requires human playback review."
}
with open(manifest,"w") as f: json.dump(record,f,indent=2); f.write("\n")
print(json.dumps({"verified":True,"output":out,"durationSeconds":duration,"bytes":os.path.getsize(out),"introTimelineSeconds":float(intro_timeline),"narrationStartSeconds":float(narration_start),"outroDurationSeconds":float(outro_duration),"manifest":manifest},indent=2))
PY
